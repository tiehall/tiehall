import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HALL_WAITS_PER_SESSION } from "../src/hall-routes.ts";
import { createHallRoute, createHallStateRoute, createHallWaitRoute, createLogger, sessionCookiesOf } from "../src/index.ts";
import { startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { addTeam, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// The live hall's reads as its script calls them (web-ui: The live hall's
// reads and its long-poll; web-ui: The content security policy of each kind of
// page; requester-loop: No push paths other than the hooks; design.md, Design:
// The live hall; D57 (9), (12)). GET /hall/state and GET /hall/wait answer
// one complete JSON document each, never a stream, with no-store, nosniff,
// same-origin and the JSON answers' policy; only the web session's cookie
// reads them: without one they answer 401 with an RFC 9457 problem, an agent's
// OAuth access token or personal access token in an Authorization header
// included, and a removed member gets 403. Neither renews the session: an
// unattended hall would otherwise keep it alive. While the app shuts down, the
// wait ends at once with 503 and Retry-After: 0. The routes are built as the
// web role builds them, against an install with the sign-in service, whose
// people sign in with GitHub through the stub.

/** How long the hall's wait holds here, instead of 25 seconds. */
const HOLD_MS = 1_500;
/** The JSON answers' policy, as design.md's table gives it. */
const JSON_POLICY = "default-src 'none'; frame-ancestors 'none'";

let harness: AgentAccessHarness;
const shutdown = new AbortController();
let carol: SignedIn;
let dana: SignedIn;
let options: Parameters<typeof createHallRoute>[0];
let state: (request: Request) => Promise<Response>;
let wait: (request: Request) => Promise<Response>;
let page: (request: Request) => Promise<Response>;

beforeAll(async () => {
  harness = await startAgentAccess({ wait: { hallHoldMs: HOLD_MS, shutdown: shutdown.signal } });
  const { install, signIn } = harness;
  const fe = await addTeam(install.owner, "FE");
  const be = await addTeam(install.owner, "BE");
  carol = await harness.member("carol");
  await joinTeams(install.owner, carol.userId, be);
  dana = await harness.member("dana");
  await joinTeams(install.owner, dana.userId, fe);
  await openRequest(install, tokenOf(carol.userId), { targetTeam: "FE", title: "Add a dark mode" });
  options = {
    execute: install.execute,
    session: (request: Request, renewal?: Headers) => signIn.service.session(request.headers, renewal),
    url: URL_OF_INSTALL,
    secret: () => install.authSecret,
    logger: install.logger,
  };
  state = createHallStateRoute(options);
  wait = createHallWaitRoute(options);
  page = createHallRoute(options);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A GET of the route at this path, with these headers. */
function get(route: (request: Request) => Promise<Response>, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return route(new Request(`${URL_OF_INSTALL}${path}`, { headers }));
}

/** The number of the newest domain event about a request, which a wait that should see only what comes next starts from. */
async function cursor(): Promise<number> {
  return ((await (await get(state, "/hall/state", { cookie: carol.cookie })).json()) as { cursor: number }).cursor;
}

function expectJsonHeaders(answer: Response): void {
  expect(answer.headers.get("content-type")).toBe("application/json");
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
  expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(answer.headers.get("content-security-policy")).toBe(JSON_POLICY);
  expect(answer.headers.get("set-cookie")).toBeNull();
}

describe("GET /hall/state", () => {
  it("answers the hall's state as one JSON document, with no-store, nosniff, same-origin and the JSON answers' policy", async () => {
    const answer = await get(state, "/hall/state", { cookie: carol.cookie });
    expect(answer.status).toBe(200);
    expectJsonHeaders(answer);
    const body = (await answer.json()) as { teams: { key: string }[]; requestLines: { key: string }[]; cursor: number };
    expect(body.teams.map(({ key }) => key)).toEqual(["BE", "FE"]);
    expect(body.requestLines.map(({ key }) => key)).toEqual(["FE-1"]);
    expect(body.cursor).toBeGreaterThan(0);
  });

  it("takes the team and agents of the page's address", async () => {
    const narrowed = (await (await get(state, "/hall/state?team=BE&agents=1", { cookie: carol.cookie })).json()) as { lines: { to: { key: string } }[]; feed: { actor: { kind: string } }[] };
    expect(narrowed.lines.map(({ to }) => to.key)).toEqual(["FE"]);
    expect(narrowed.feed.every(({ actor }) => actor.kind === "agent")).toBe(true);
    const none = (await (await get(state, "/hall/state?team=&agents=0", { cookie: carol.cookie })).json()) as { teams: unknown[] };
    expect(none.teams).toHaveLength(2);
  });

  it("refuses a team key that is not one with 400, and a team that does not exist with 404, as problems", async () => {
    for (const [path, status] of [
      ["/hall/state?team=fe", 400],
      ["/hall/state?team=NOPE", 404],
    ] as const) {
      const answer = await get(state, path, { cookie: carol.cookie });
      expect(answer.status, path).toBe(status);
      expect(answer.headers.get("content-type"), path).toBe("application/problem+json");
      expect(answer.headers.get("content-security-policy"), path).toBe(JSON_POLICY);
    }
  });
});

describe("GET /hall/wait", () => {
  it("answers as one JSON document once its hold ends, with the cursor it was given and the same headers", async () => {
    const after = await cursor();
    const answer = await get(wait, `/hall/wait?after=${after}`, { cookie: carol.cookie });
    expect(answer.status).toBe(200);
    expectJsonHeaders(answer);
    expect(await answer.json()).toMatchObject({ cursor: after, reload: false, events: [] });
  });

  it("answers with the events that came after the cursor", async () => {
    const after = await cursor();
    await openRequest(harness.install, tokenOf(carol.userId), { targetTeam: "FE", title: "Move the banner" });
    const answer = await get(wait, `/hall/wait?after=${after}&team=FE`, { cookie: carol.cookie });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { events: { type: string; request: { key: string } }[] };
    expect(body.events.map(({ type, request }) => [type, request.key])).toEqual([["request.opened", "FE-2"]]);
  });

  it("refuses a cursor that is not a whole number from 0 with 400", async () => {
    for (const path of ["/hall/wait", "/hall/wait?after=-1", "/hall/wait?after=x"]) {
      const answer = await get(wait, path, { cookie: carol.cookie });
      expect(answer.status, path).toBe(400);
      expect(answer.headers.get("content-type"), path).toBe("application/problem+json");
    }
  });
});

describe("who may read the hall", () => {
  it("is nobody without a session: 401 with an RFC 9457 problem, and no team, request or event", async () => {
    for (const answer of [await get(state, "/hall/state"), await get(wait, "/hall/wait?after=0")]) {
      expect(answer.status).toBe(401);
      expect(answer.headers.get("content-type")).toBe("application/problem+json");
      expect(answer.headers.get("content-security-policy")).toBe(JSON_POLICY);
      const body = (await answer.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ type: "https://tiehall.com/problems/unauthenticated", status: 401 });
      expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
      expect(JSON.stringify(body)).not.toMatch(/FE-1|"FE"|request\./);
    }
  });

  it("is nobody with only an agent's OAuth access token or personal access token, which /api/v1 takes", async () => {
    const dana = await harness.member("dana-agent");
    await joinTeams(harness.install.owner, dana.userId, (await harness.install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'FE'")).rows[0]?.id ?? "");
    const { accessToken } = await harness.tokens(dana);
    const personal = await harness.personalAccessToken(dana);
    for (const token of [accessToken, personal]) {
      const authorization = `Bearer ${token}`;
      expect((await harness.api("GET", "/api/v1/requests/FE-1", { authorization })).status).toBe(200);
      for (const answer of [await get(state, "/hall/state", { authorization }), await get(wait, "/hall/wait?after=0", { authorization })]) {
        expect(answer.status).toBe(401);
        expect(JSON.stringify(await answer.json())).not.toMatch(/FE-1|"FE"|request\./);
      }
    }
  });

  it("refuses a removed member with 403", async () => {
    const lee = await harness.member("lee");
    const pia = await harness.member("pia");
    await harness.install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [pia.userId]);
    expect((await harness.install.confirm(sessionOf(pia.userId), "members.remove", { userId: lee.userId })).status).toBe(200);
    for (const answer of [await get(state, "/hall/state", { cookie: lee.cookie }), await get(wait, "/hall/wait?after=0", { cookie: lee.cookie })]) {
      expect(answer.status).toBe(403);
      expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/removed-member" });
    }
  });

  it("answers no method but GET", async () => {
    const answer = await state(new Request(`${URL_OF_INSTALL}/hall/state`, { method: "POST", headers: { cookie: carol.cookie } }));
    expect(answer.status).toBe(404);
  });
});

// sign-in: Signing out and ending sessions. A use a day or more after a session was created or last extended extends
// it, but the hall's reads are the page's own, not uses by the person.
describe("the session the hall's reads read", () => {
  /** A fresh sign-in of Carol's, last extended two days ago; returns the browser's Cookie header and the session's expiry. */
  async function staleSession(): Promise<{ cookie: string; expiresAt: number }> {
    const cookie = (await harness.signIn.signIn("carol")).jar.header();
    const token = decodeURIComponent(/tiehall\.session_token=([^;]+)/.exec(cookie)?.[1] ?? "").split(".")[0];
    const { rows } = await harness.install.owner.query<{ expires_at: Date }>("UPDATE web_sessions SET expires_at = now() + interval '5 days' WHERE token = $1 RETURNING expires_at", [token]);
    expect(rows).toHaveLength(1);
    return { cookie, expiresAt: rows[0]?.expires_at.getTime() ?? 0 };
  }

  async function expiryOf(cookie: string): Promise<number> {
    const token = decodeURIComponent(/tiehall\.session_token=([^;]+)/.exec(cookie)?.[1] ?? "").split(".")[0];
    const { rows } = await harness.install.owner.query<{ expires_at: Date }>("SELECT expires_at FROM web_sessions WHERE token = $1", [token]);
    return rows[0]?.expires_at.getTime() ?? 0;
  }

  it("is not extended by /hall/state or /hall/wait, which set no cookie", async () => {
    const { cookie, expiresAt } = await staleSession();
    const read = await get(state, "/hall/state", { cookie });
    expect(read.status).toBe(200);
    expect(sessionCookiesOf(read.headers)).toEqual([]);
    const waited = await get(wait, `/hall/wait?after=${await cursor()}`, { cookie });
    expect(waited.status).toBe(200);
    expect(sessionCookiesOf(waited.headers)).toEqual([]);
    expect(await expiryOf(cookie)).toBe(expiresAt);
  });

  it("is extended by opening /hall, as by opening any page, whose answer renews the browser's cookie", async () => {
    const { cookie, expiresAt } = await staleSession();
    const opened = await get(page, "/hall", { cookie, accept: "text/html" });
    expect(opened.status).toBe(200);
    expect(sessionCookiesOf(opened.headers).map(({ maxAge }) => maxAge)).toEqual([604_800]);
    expect(await expiryOf(cookie)).toBeGreaterThan(expiresAt + 24 * 60 * 60_000);
  });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a session's waits", () => {
  it("are at most a few at once: one more is refused at once with 429 and Retry-After, another session's are not, and one is taken again once one ends", async () => {
    const after = await cursor();
    const held = Array.from({ length: HALL_WAITS_PER_SESSION }, () => get(wait, `/hall/wait?after=${after}`, { cookie: carol.cookie }));
    await pause(300);
    const started = Date.now();
    const refused = await get(wait, `/hall/wait?after=${after}`, { cookie: carol.cookie });
    expect(Date.now() - started).toBeLessThan(500);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(refused.headers.get("content-type")).toBe("application/problem+json");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toMatchObject({ type: "https://tiehall.com/problems/rate-limited", status: 429 });
    const others = get(wait, `/hall/wait?after=${after}`, { cookie: dana.cookie });
    for (const answer of [...(await Promise.all(held)), await others]) expect(answer.status).toBe(200);
    expect((await get(wait, `/hall/wait?after=${after}`, { cookie: carol.cookie })).status).toBe(200);
  });
});

describe("a browser that hangs up", () => {
  it("ends its held wait at once and quietly: no error is logged", async () => {
    const lines: string[] = [];
    const quiet = createHallWaitRoute({ ...options, logger: createLogger({ write: (line) => lines.push(line) }) });
    const leaving = new AbortController();
    const ended = quiet(new Request(`${URL_OF_INSTALL}/hall/wait?after=${await cursor()}`, { headers: { cookie: carol.cookie }, signal: leaving.signal })).then(() => Date.now());
    await pause(200);
    const left = Date.now();
    leaving.abort();
    expect((await ended) - left).toBeLessThan(500);
    expect(lines).toEqual([]);
  });
});

// While the app shuts down (self-host-install: A restart stops the app gracefully). This runs last: once the install
// shuts down, every wait ends at once.
describe("a shutdown", () => {
  it("ends a held wait with 503 and Retry-After: 0 at once, and a wait that starts afterwards too", async () => {
    const waiting = get(wait, `/hall/wait?after=${await cursor()}`, { cookie: carol.cookie }).then((answer) => ({ answer, at: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = Date.now();
    shutdown.abort();
    const { answer, at } = await waiting;
    expect(at - stopped).toBeLessThan(500);
    for (const ended of [answer, await get(wait, "/hall/wait?after=0", { cookie: carol.cookie })]) {
      expect(ended.status).toBe(503);
      expect(ended.headers.get("retry-after")).toBe("0");
      expect(ended.headers.get("content-type")).toBe("application/problem+json");
      expect(await ended.json()).toMatchObject({ type: "https://tiehall.com/problems/shutting-down", status: 503 });
    }
  });
});
