import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import { CONFIRM_PATH, createWebCommands, GITHUB_ADMIN_PATH, INVITES_PATH, MEMBERS_PATH, sessionCookiesOf } from "../src/index.ts";
import { startAppServer, type AppServer } from "./support/app-server.ts";
import { addUser } from "./support/members.ts";
import { CookieJar } from "./support/sign-in.ts";

// How long a web session lasts (sign-in: Signing out and ending sessions;
// github-layer-hardening: design.md, Decisions this change rests on: D50 (6);
// design.md, Technical decisions: T4). A web session expires 7 days after it
// was created or last extended; a use extends it to 7 days after that use
// when a day or more has passed since it was created or last extended, and
// the route handler or server action that read it passes the renewed cookie
// on to its answer, while a server component reads it without renewing it.
// Whatever its uses, a session ends 30 days after the sign-in that created
// it: its row goes, and the browser is sent to sign in, not refused as a
// removed member's. The session the setup screen's sign-in creates follows the
// same rules. The install is the one app-server.ts builds as the web role
// does, against the GitHub stub; the clock the sign-in service and its session
// reads go by is the test's, which only Date follows, so every other timer
// runs as usual. Signing out and a removal, which end a session at once, are
// tested in sign-out.test.ts and member-removal.test.ts.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SESSION_COOKIE = "__Secure-tiehall.session_token";

let stub: GitHubStub;
let server: AppServer | undefined;
/** When the test's first sign-in happens: the clock stands still there until a test moves it. */
let start: number;

beforeEach(async () => {
  start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  // A fresh install, migrations included, which a slow runner builds slowly.
  server = await startAppServer(stub);
}, 60_000);

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = undefined;
  await stub.close();
});

/** Moves the test's clock to this long after the first sign-in. */
function at(offset: number): void {
  vi.setSystemTime(start + offset);
}

/** A browser at the install: its cookies, and its requests as the install answers them. */
function browser(jar = new CookieJar()) {
  const install = server!;
  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (jar.header() !== "") headers.set("cookie", jar.header());
    const answer = await install.handle(new Request(path.startsWith("http") ? path : `${install.url}${path}`, { ...init, headers }));
    jar.take(answer);
    return answer;
  };
  return {
    jar,
    get: (path: string, headers: Record<string, string> = {}) => send(path, { headers }),
    post: (path: string, fields: Record<string, string>) =>
      send(path, {
        method: "POST",
        headers: { origin: install.url, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
  };
}

type Browser = ReturnType<typeof browser>;

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** GitHub's return to a sign-in that the answer sent to GitHub's authorize page, as this GitHub user. */
async function returnFromGitHub(started: Response, app: StubApp, login: string, as: Browser): Promise<Response> {
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
  const codeChallenge = authorize.searchParams.get("code_challenge") ?? undefined;
  const code = stub.authorize(app, login, { redirectUri, ...(codeChallenge === undefined ? {} : { codeChallenge }) });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  return as.get(back.href);
}

/**
 * Setup as the operator runs it: the code, the company, the App through the
 * manifest flow, its installation on acme, and Omar's sign-in from the setup
 * screen, which completes setup and signs Omar in; returns Omar's browser and
 * the App.
 */
async function completeSetup(): Promise<{ omar: Browser; app: StubApp }> {
  const install = server!;
  const omar = browser();
  expect((await omar.post("/setup", { code: await install.start() })).status).toBe(303);
  expect((await omar.post("/setup/company", { name: "Acme" })).status).toBe(303);
  const html = await (await omar.get("/setup?org=acme")).text();
  const form = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]*)">/.exec(html);
  const state = new URL(unescapeHtml(form?.[1] ?? "")).searchParams.get("state") ?? "";
  const created = await stub.createAppFromManifest({ manifest: unescapeHtml(form?.[2] ?? ""), org: "acme", state, as: "omar" });
  if (created.status !== "created") throw new Error(`the stub refused the manifest: ${created.messages.join(" ")}`);
  expect((await omar.get(`/setup/github?${new URLSearchParams({ code: created.code, state })}`)).status).toBe(303);
  await stub.install(created.app, { account: "acme" });
  expect((await returnFromGitHub(await omar.post("/setup/sign-in", {}), created.app, "omar", omar)).status).toBe(302);
  return { omar, app: created.app };
}

/** A sign-in with GitHub from the sign-in page, in a fresh browser; returns the browser, signed in. */
async function signIn(app: StubApp, login: string): Promise<Browser> {
  const person = browser();
  expect((await returnFromGitHub(await person.post("/sign-in", { return: "/" }), app, login, person)).status).toBe(302);
  return person;
}

/** The web session a browser's cookie names, as the database holds it; undefined when there is none. */
async function sessionOf(person: Browser): Promise<{ id: string; expiresAt: number } | undefined> {
  const token = /(?:^|; )__Secure-tiehall\.session_token=([^.;]+)/.exec(person.jar.header())?.[1];
  if (token === undefined) return undefined;
  const { rows } = await server!.owner.query<{ id: string; expires_at: Date }>("SELECT id, expires_at FROM web_sessions WHERE token = $1", [
    decodeURIComponent(token),
  ]);
  return rows[0] === undefined ? undefined : { id: rows[0].id, expiresAt: rows[0].expires_at.getTime() };
}

async function sessionRows(id: string): Promise<number> {
  return Number((await server!.owner.query("SELECT count(*) FROM web_sessions WHERE id = $1", [id])).rows[0].count);
}

/**
 * Whether the browser is signed in now, as a server component reads its
 * session: without renewing it, so the check is no use of the session.
 */
async function stillSignedIn(person: Browser): Promise<boolean> {
  return (await server!.signIn.session(new Headers({ cookie: person.jar.header() }))) !== undefined;
}

/** Opens the home page: whether the browser was still signed in, and the answer. */
async function openHome(person: Browser): Promise<{ signedIn: boolean; answer: Response }> {
  const answer = await person.get("/");
  if (answer.status === 200) {
    expect(await answer.clone().text()).toContain("You are signed in.");
    return { signedIn: true, answer };
  }
  return { signedIn: false, answer };
}

/** The Set-Cookie line of the session cookie an answer carries, if any. */
function sessionCookieOf(answer: Response): string | undefined {
  return answer.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
}

/** Whether the answer renews the session's cookie: the same session, for 7 days from now. */
function renews(answer: Response): boolean {
  const line = sessionCookieOf(answer);
  return line !== undefined && /;\s*Max-Age=604800(?:;|$)/i.test(line) && !/^[^=]+=;/.test(line);
}

/** Expects the browser to be sent to sign in, and not refused as a removed member's. */
async function expectSentToSignIn(person: Browser): Promise<void> {
  const { signedIn, answer } = await openHome(person);
  expect(signedIn).toBe(false);
  expect(answer.status).toBe(303);
  expect(answer.headers.get("location")).toBe("/sign-in");
}

describe("a web session", { timeout: 60_000 }, () => {
  it("in daily use ends 30 days after its sign-in, when its row goes and the browser is sent to sign in, not refused with 403", async () => {
    const { app } = await completeSetup();
    const ana = await signIn(app, "omar");
    const session = (await sessionOf(ana))!;

    for (let day = 1; day < 30; day += 1) {
      at(day * DAY);
      expect((await openHome(ana)).signedIn).toBe(true);
    }
    at(30 * DAY - MINUTE);
    expect((await openHome(ana)).signedIn).toBe(true);

    at(30 * DAY);
    await expectSentToSignIn(ana);
    expect(await sessionRows(session.id)).toBe(0);
    // A new sign-in with GitHub signs the person in again.
    expect((await openHome(await signIn(app, "omar"))).signedIn).toBe(true);
  });

  it("expires when it is not used for 7 days after it was created", async () => {
    const { app } = await completeSetup();
    const ana = await signIn(app, "omar");
    const session = (await sessionOf(ana))!;

    at(7 * DAY - MINUTE);
    expect(await stillSignedIn(ana)).toBe(true);
    expect((await sessionOf(ana))!.expiresAt).toBe(start + 7 * DAY);
    at(7 * DAY + MINUTE);
    await expectSentToSignIn(ana);
    expect(await sessionRows(session.id)).toBe(0);
  });

  it("is not extended by a use less than a day after it was created or last extended, and a later use extends it to 7 days after that use, with the renewed cookie on the answer", async () => {
    const { app } = await completeSetup();
    const ana = await signIn(app, "omar");
    const created = (await sessionOf(ana))!;
    expect(created.expiresAt).toBe(start + 7 * DAY);

    // An hour after the sign-in, it is not extended, and the answer sets no cookie.
    at(HOUR);
    const early = await openHome(ana);
    expect(early.signedIn).toBe(true);
    expect(sessionCookieOf(early.answer)).toBeUndefined();
    expect((await sessionOf(ana))!.expiresAt).toBe(start + 7 * DAY);

    // A day and an hour after it: extended to 7 days after this use, and the answer renews the cookie.
    at(DAY + HOUR);
    const later = await openHome(ana);
    expect(later.signedIn).toBe(true);
    expect(renews(later.answer)).toBe(true);
    expect((await sessionOf(ana))!.expiresAt).toBe(start + 8 * DAY + HOUR);

    // Less than a day after the extension: not extended again.
    at(2 * DAY);
    const again = await openHome(ana);
    expect(sessionCookieOf(again.answer)).toBeUndefined();
    expect((await sessionOf(ana))!.expiresAt).toBe(start + 8 * DAY + HOUR);

    // Past the first 7 days, it is still signed in, until 7 days after the use that extended it.
    at(8 * DAY + 30 * MINUTE);
    expect(await stillSignedIn(ana)).toBe(true);
    at(8 * DAY + HOUR + MINUTE);
    await expectSentToSignIn(ana);
  });

  it("is renewed by every route handler that reads it, whose answer carries the renewed cookie, a refusal's included", async () => {
    const { app } = await completeSetup();
    const ana = await signIn(app, "omar");
    const kim = await addUser(server!.owner, { login: "kim" });
    const pages: [string, number][] = [
      ["/", 200],
      [MEMBERS_PATH, 200],
      [INVITES_PATH, 200],
      [GITHUB_ADMIN_PATH, 200],
      [`${CONFIRM_PATH}members.change_role?${new URLSearchParams({ input: JSON.stringify({ userId: kim, role: "admin" }) })}`, 200],
      // A review page for an input that fails the schema is refused, and still renews the session it read.
      [`${CONFIRM_PATH}members.change_role?input=${encodeURIComponent("{}")}`, 400],
    ];
    for (const [index, [path, status]] of pages.entries()) {
      // Each page is the first use a day or more after the session was last extended.
      at((index + 1) * DAY);
      const answer = await ana.get(path, { accept: "text/html" });
      expect({ path, status: answer.status }).toEqual({ path, status });
      expect({ path, renews: renews(answer) }).toEqual({ path, renews: true });
      expect((await sessionOf(ana))!.expiresAt).toBe(start + (index + 8) * DAY);
    }
  });

  it("is renewed by a server action's write, which passes the renewed cookie on, and never by a server component's read", async () => {
    const { app } = await completeSetup();
    const ana = await signIn(app, "omar");
    const install = server!;
    const headers = new Headers({ cookie: ana.jar.header() });
    const web = createWebCommands({
      execute: install.execute,
      session: (renewal) => install.signIn.session(headers, renewal),
      url: install.url,
      secret: () => install.authSecret,
    });

    // A day after the sign-in, a server component reads, and gets the page's CSRF token: neither renews the session.
    at(DAY);
    expect(await web.read("members.list", {})).toMatchObject({ ok: true });
    const csrf = await web.csrfToken();
    expect((await sessionOf(ana))!.expiresAt).toBe(start + 7 * DAY);

    // A server action's write renews it, and hands on the cookie that renews it.
    const renewal = new Headers();
    const userId = (await sessionUser(ana))!;
    const written = await web.write(
      "users.set_bot_flag",
      { userId, bot: false },
      { origin: install.url, fetchSite: "same-origin", csrfToken: csrf ?? "" },
      { renewal },
    );
    expect(written).toMatchObject({ ok: true });
    expect(renews(new Response(null, { headers: renewal }))).toBe(true);
    expect((await sessionOf(ana))!.expiresAt).toBe(start + 8 * DAY);
    // The server action sets it through Next.js's cookies(), by its parts: the same cookie, for 7 days.
    const value = decodeURIComponent(/(?:^|; )__Secure-tiehall\.session_token=([^;]+)/.exec(ana.jar.header())?.[1] ?? "");
    expect(sessionCookiesOf(renewal)).toEqual([
      { name: SESSION_COOKIE, value, maxAge: 7 * 24 * 60 * 60, path: "/", httpOnly: true, secure: true, sameSite: "lax" },
    ]);
  });

  it("that the setup screen's sign-in created follows the same rules", async () => {
    const { omar } = await completeSetup();
    const session = (await sessionOf(omar))!;
    expect(session.expiresAt).toBe(start + 7 * DAY);

    // Used a day later: extended to 7 days after that use; not used for 7 days after it: expired.
    at(DAY);
    const used = await openHome(omar);
    expect(renews(used.answer)).toBe(true);
    expect((await sessionOf(omar))!.expiresAt).toBe(start + 8 * DAY);
    at(8 * DAY - MINUTE);
    expect(await stillSignedIn(omar)).toBe(true);
    at(8 * DAY + MINUTE);
    await expectSentToSignIn(omar);
    expect(await sessionRows(session.id)).toBe(0);
  });

  it("that the setup screen's sign-in created ends 30 days after it, however often it is used", async () => {
    const { omar } = await completeSetup();
    const session = (await sessionOf(omar))!;
    for (let day = 1; day < 30; day += 1) {
      at(day * DAY);
      expect((await openHome(omar)).signedIn).toBe(true);
    }
    at(30 * DAY);
    await expectSentToSignIn(omar);
    expect(await sessionRows(session.id)).toBe(0);
  });
});

/** The user the browser's web session acts for. */
async function sessionUser(person: Browser): Promise<string | undefined> {
  const session = await sessionOf(person);
  if (session === undefined) return undefined;
  const { rows } = await server!.owner.query<{ user_id: string }>("SELECT user_id FROM web_sessions WHERE id = $1", [session.id]);
  return rows[0]?.user_id;
}
