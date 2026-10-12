import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID, createInboxRoute, expireProposals, INBOX_PATH, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, openRequestInTheWebUi, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// The web inbox's update feed (requester-loop: The web inbox; requester-loop:
// The pull readers; requester-loop: What whats_new covers; design.md,
// Decisions this change rests on: D28 #62; D29 (5); design.md, Design rules:
// Requester loop). The feed lists the user's updates after the web inbox's own
// cursor, from the whats_new scope plus the events on the requests whose
// requesting team is one of the user's teams, without any event of the user's
// own, what they did in the web UI or through their agents
// (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55
// (43); findings-from-claude-code-run: design.md, Findings: F2 (4)), and is
// acknowledged like any pull reader: acknowledging it moves only the web inbox's cursor, never the
// cursor of the user's MCP client or CLI, and theirs never move it. The page
// at /inbox shows the feed with each update in Tiehall's words, a link to its
// request and the request's title as text, and a form that acknowledges the
// updates it shows, which passes the web UI's write checks.

let install: TestInstall;
let lee: WebSessionCaller;
let kim: WebSessionCaller;
let oli: WebSessionCaller;
let dana: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const ops = await addTeam(install.owner, "OPS");
  lee = sessionOf(await addUser(install.owner, { login: "lee" }));
  kim = sessionOf(await addUser(install.owner, { login: "kim" }));
  oli = sessionOf(await addUser(install.owner, { login: "oli" }));
  dana = sessionOf(await addUser(install.owner, { login: "dana" }));
  await joinTeams(install.owner, lee.userId, be);
  await joinTeams(install.owner, kim.userId, be);
  await joinTeams(install.owner, oli.userId, ops);
  await joinTeams(install.owner, dana.userId, fe);
});

afterAll(async () => {
  await install?.close();
});

interface Update {
  number: number;
  type: string;
  data: Record<string, unknown>;
  request: { key: string };
}

/** The web inbox's update feed as the user's web UI reads it; fails the test on a refusal. */
async function feed(session: WebSessionCaller): Promise<{ events: Update[]; cursor: number; more: boolean }> {
  const read = await install.web(session).read<{ events: Update[]; cursor: number; more: boolean }>("inbox.updates", { limit: 50 });
  if (!read.ok) throw new Error(`inbox.updates answered ${JSON.stringify(read.problem)}`);
  return read.output;
}

/** A question from OPS on a request Lee opened from BE to OPS, with this title; returns the request. */
async function questionFromOps(title = "Rotate the staging keys"): Promise<{ id: string; key: string }> {
  const request = await openRequest(install, tokenOf(lee.userId), { targetTeam: "OPS", title });
  const asked = await callApi(install, tokenOf(oli.userId), "POST", `/api/v1/requests/${request.key}/messages`, { kind: "question", body: "Which region?" });
  expect(asked.status).toBe(200);
  return request;
}

const route = (session: WebSessionCaller | undefined) =>
  createInboxRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

async function page(session: WebSessionCaller | undefined): Promise<{ status: number; html: string; headers: Headers }> {
  const answer = await route(session)(new Request(`${URL_OF_INSTALL}${INBOX_PATH}`, { headers: { accept: "text/html" } }));
  return { status: answer.status, html: await answer.text(), headers: answer.headers };
}

/** The hidden fields of the page's form that acknowledges the updates it shows, among the page's forms. */
function acknowledgeForm(html: string): Record<string, string> {
  const forms = [...html.matchAll(/<form method="post" action="\/inbox">([\s\S]*?)<\/form>/g)].map(([, form]) => form ?? "");
  const form = forms.find((each) => each.includes('name="action" value="acknowledge"')) ?? "";
  return Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name ?? "", value ?? ""]));
}

function post(session: WebSessionCaller, fields: Record<string, string>, headers: Record<string, string> = { origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" }) {
  return route(session)(
    new Request(`${URL_OF_INSTALL}${INBOX_PATH}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

describe("the update feed", () => {
  // requester-loop: What whats_new covers, "The web inbox adds requests whose requester is the user's team".
  it("lists a question on a request whose requesting team is one of the user's teams, which the user did not open", async () => {
    const request = await questionFromOps();
    const { events } = await feed(kim);
    const onRequest = events.filter(({ data }) => data["requestId"] === request.id).map(({ type, data }) => `${type}:${String(data["kind"] ?? "")}`);
    expect(onRequest).toContain("request.message_posted:question");
  });

  it("leaves out a request the user has no part in, whose requesting team is none of the user's teams", async () => {
    const request = await questionFromOps();
    expect((await feed(dana)).events.filter(({ data }) => data["requestId"] === request.id)).toEqual([]);
  });

  it("is acknowledged with the web inbox's own cursor, which moves no cursor of the user's agents, and theirs never move it", async () => {
    const request = await questionFromOps();
    // Kim's CLI and an MCP client of Kim's read once first, so that each has a cursor of its own: a reader with none
    // yet would start at the web inbox's (decisions-from-groups-15-28: design.md, Decisions this change rests on:
    // D55 (44)).
    const agents = [CLI_CLIENT_ID, `https://agent.example/${randomUUID()}.json`];
    for (const client of agents) expect((await callApi(install, oauthTokenOf(kim.userId, client, "api"), "POST", "/api/v1/updates", { limit: 50 })).body.cursor).toBe(0);
    const before = await feed(kim);
    const last = before.events.at(-1)?.number ?? 0;
    expect(before.events.some(({ data }) => data["requestId"] === request.id)).toBe(true);
    const session = kim;
    const acknowledged = await install.web(session).write<{ cursor: number; events: Update[] }>("inbox.updates", { acknowledge: last }, install.fromThePage(session));
    expect(acknowledged).toMatchObject({ ok: true, output: { cursor: last, events: [] } });
    // Kim's CLI and the MCP client of Kim's are where they were.
    for (const client of agents) {
      const answer = await callApi(install, oauthTokenOf(kim.userId, client, "api"), "POST", "/api/v1/updates", { limit: 50 });
      expect(answer.status).toBe(200);
      expect(answer.body.cursor).toBe(0);
    }
    const { rows } = await install.owner.query<{ reader: string; acknowledged: string }>("SELECT reader, acknowledged FROM read_cursors WHERE user_id = $1 ORDER BY reader", [kim.userId]);
    expect(rows).toEqual(
      [...agents.map((client) => ({ reader: `oauth:${client}`, acknowledged: "0" })), { reader: "web", acknowledged: String(last) }].sort((a, b) => a.reader.localeCompare(b.reader)),
    );
    // Acknowledging through the CLI moves the CLI's cursor alone.
    const later = await questionFromOps();
    const cli = oauthTokenOf(kim.userId, CLI_CLIENT_ID, "cli");
    const read = await callApi(install, cli, "POST", "/api/v1/updates", { limit: 50 });
    const cliLast = (read.body.events as Update[]).at(-1)?.number ?? 0;
    await callApi(install, cli, "POST", "/api/v1/updates", { acknowledge: cliLast });
    const { events } = await feed(kim);
    expect(events.some(({ data }) => data["requestId"] === later.id)).toBe(true);
    expect((await feed(kim)).cursor).toBe(last);
  });
});

describe("the web inbox page", () => {
  it("shows the feed: each update in Tiehall's words with a link to its request and its title as text, and a form that acknowledges them", async () => {
    const request = await questionFromOps("Rotate the <b>staging</b> keys");
    const { status, html, headers } = await page(lee);
    expect(status).toBe(200);
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("<h1>Inbox</h1>");
    expect(html).toContain(`<a class="key" href="/${request.key}">${request.key}</a>`);
    expect(html).toContain("A question was posted");
    expect(html).toContain("Rotate the &#60;b&#62;staging&#60;/b&#62; keys");
    expect(html).not.toContain("<b>staging</b>");
    const fields = acknowledgeForm(html);
    expect(fields["action"]).toBe("acknowledge");
    expect(Number(fields["upTo"])).toBeGreaterThan(0);
    expect(fields["csrf"]).toMatch(/.+/);
  });

  it("acknowledges the updates it showed when its form is posted, and then shows none", async () => {
    await questionFromOps();
    const fields = acknowledgeForm((await page(lee)).html);
    const answer = await post(lee, fields);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(INBOX_PATH);
    expect((await feed(lee)).events).toEqual([]);
    expect((await page(lee)).html).toContain("No new updates.");
  });

  it("refuses the form without the session's CSRF token, or from another origin, with 403, and moves nothing", async () => {
    await questionFromOps();
    const fields = acknowledgeForm((await page(lee)).html);
    const cursor = (await feed(lee)).cursor;
    expect((await post(lee, { ...fields, csrf: "forged" })).status).toBe(403);
    expect((await post(lee, fields, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await feed(lee)).cursor).toBe(cursor);
  });

  it("sends a browser without a session to sign in first, with nothing from the page", async () => {
    const { status, html } = await page(undefined);
    expect(status).toBe(303);
    expect(html).toBe("");
  });
});

// requester-loop: What whats_new covers, "The user's confirmation in the web UI reaches their agent" and "The user's
// answer in the web UI reaches their agent's readers"; requester-loop: Proposal outcomes reach the proposing agent, "A
// withdrawal through the agent is not news to it", "The accountable human's own rejection reaches their agent only"
// and "The other side's rejection reaches the web inbox" (decisions-from-groups-15-28: design.md, Decisions this
// change rests on: D55 (43); findings-from-claude-code-run: design.md, Findings: F2 (4); design.md, Technical
// decisions: T3). The feed, which people read, leaves out every event whose accountable human is the user, what they
// did in the web UI included; another person's event on the same request, and a proposal's ending that another person
// or the system made, are listed. These run last in the file: each first acknowledges the feed up to the install's
// last event, and the last one's expiry ends every proposal still pending.
describe("the user's own events", () => {
  /** Acknowledges the user's feed up to the install's last event, so the next reads list only what comes after. */
  async function caughtUp(session: WebSessionCaller): Promise<void> {
    const { rows } = await install.owner.query<{ last: string }>("SELECT coalesce(max(number), 0) AS last FROM events");
    const acknowledged = await install.web(session).write("inbox.updates", { acknowledge: Number(rows[0]?.last ?? 0) }, install.fromThePage(session));
    if (!acknowledged.ok) throw new Error(`inbox.updates answered ${JSON.stringify(acknowledged.problem)}`);
  }

  /** The updates on the request in the feed, by their type and, for a message, the message's id. */
  async function onRequest(session: WebSessionCaller, requestId: string): Promise<string[]> {
    return (await feed(session)).events
      .filter(({ data }) => data["requestId"] === requestId)
      .map(({ type, data }) => (typeof data["messageId"] === "string" ? `${type}:${data["messageId"]}` : type));
  }

  async function post(caller: Parameters<typeof callApi>[1], key: string, message: Record<string, unknown>): Promise<string> {
    const answer = await callApi(install, caller, "POST", `/api/v1/requests/${key}/messages`, message);
    if (answer.status !== 200) throw new Error(`messages.post answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    return answer.body.message.id;
  }

  async function postInTheWebUi(session: WebSessionCaller, key: string, message: Record<string, unknown>): Promise<string> {
    const result = await install.web(session).write<{ message: { id: string } }>("messages.post", { key, ...message }, install.fromThePage(session));
    if (!result.ok) throw new Error(`messages.post answered ${JSON.stringify(result.problem)}`);
    return result.output.message.id;
  }

  it("leaves out every event of the user, what they did in the web UI and through their agents, and lists another person's on the same request", async () => {
    await caughtUp(lee);
    const request = await openRequestInTheWebUi<{ id: string; key: string }>(install, lee.userId, { targetTeam: "OPS" });
    await post(tokenOf(lee.userId), request.key, { kind: "comment", body: "The keys of staging only." });
    expect((await callApi(install, tokenOf(oli.userId), "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
    const question = await post(tokenOf(oli.userId), request.key, { kind: "question", body: "Which region?" });
    await postInTheWebUi(lee, request.key, { kind: "answer", body: "eu-west-1.", questionId: question });
    expect(await onRequest(lee, request.id)).toEqual(["request.claimed", `request.message_posted:${question}`]);
  });

  it("leaves out how the user confirmed or ended a proposal, in the web UI or through their agent, and lists how the other side or the system ended one", async () => {
    const request = await openRequest<{ id: string; key: string }>(install, tokenOf(lee.userId), { targetTeam: "FE" });
    await caughtUp(dana);
    const proposeDueDate = async (): Promise<string> => {
      const answer = await sendApi(install, tokenOf(dana.userId), "POST", "/api/v1/proposals", { body: { kind: "due_date", key: request.key, dueDate: "2026-12-15" }, headers: { "if-match": '"1"' } });
      if (answer.status !== 202) throw new Error(`proposals.propose answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      return answer.body.proposal.id;
    };
    const confirm = async (session: WebSessionCaller, proposal: string) => expect((await install.confirm(session, "proposals.confirm", { proposal })).status).toBe(200);
    const reject = async (session: WebSessionCaller, proposal: string) =>
      expect(await install.web(session).write("proposals.reject", { proposal }, install.fromThePage(session))).toMatchObject({ ok: true });
    const withdrawn = await proposeDueDate();
    expect((await callApi(install, tokenOf(dana.userId), "POST", "/api/v1/proposals", { kind: "withdraw_proposal", proposal: withdrawn })).status).toBe(200);
    const decline = await callApi(install, tokenOf(dana.userId), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(decline.status).toBe(202);
    const rejectedByDana: string = decline.body.proposal.id;
    await reject(dana, rejectedByDana);
    const rejectedByLee = await proposeDueDate();
    await confirm(dana, rejectedByLee);
    await reject(lee, rejectedByLee);
    const expired = await proposeDueDate();
    await confirm(dana, expired);
    await expireProposals.handle(
      { id: "expire", queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(Date.now() + 8 * 24 * 3_600_000) },
    );
    const proposals = (await feed(dana)).events.filter(({ data }) => typeof data["proposalId"] === "string");
    expect(proposals.map(({ type, data }) => [type, data["proposalId"], data["how"]])).toEqual([
      ["proposal.ended", rejectedByLee, "rejected"],
      ["proposal.ended", expired, "expired"],
    ]);
  });
});
