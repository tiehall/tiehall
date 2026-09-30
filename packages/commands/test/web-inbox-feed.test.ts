import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID, createInboxRoute, INBOX_PATH, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// The web inbox's update feed (requester-loop: The web inbox; requester-loop:
// The pull readers; requester-loop: What whats_new covers; design.md,
// Decisions this change rests on: D28 #62; D29 (5); design.md, Design rules:
// Requester loop). The feed lists the user's updates after the web inbox's own
// cursor, from the whats_new scope plus the events on the requests whose
// requesting team is one of the user's teams, and is acknowledged like any
// pull reader: acknowledging it moves only the web inbox's cursor, never the
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

/** The hidden fields of the page's form that acknowledges the updates it shows. */
function acknowledgeForm(html: string): Record<string, string> {
  const form = /<form method="post" action="\/inbox">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
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
    const before = await feed(kim);
    const last = before.events.at(-1)?.number ?? 0;
    expect(before.events.some(({ data }) => data["requestId"] === request.id)).toBe(true);
    const session = kim;
    const acknowledged = await install.web(session).write<{ cursor: number; events: Update[] }>("inbox.updates", { acknowledge: last }, install.fromThePage(session));
    expect(acknowledged).toMatchObject({ ok: true, output: { cursor: last, events: [] } });
    // Kim's CLI and an MCP client of Kim's still read the question.
    for (const client of [CLI_CLIENT_ID, `https://agent.example/${randomUUID()}.json`]) {
      const answer = await callApi(install, oauthTokenOf(kim.userId, client, "api"), "POST", "/api/v1/updates", { limit: 50 });
      expect(answer.status).toBe(200);
      expect(answer.body.cursor).toBe(0);
    }
    const { rows } = await install.owner.query<{ reader: string; acknowledged: string }>("SELECT reader, acknowledged FROM read_cursors WHERE user_id = $1", [kim.userId]);
    expect(rows).toEqual([{ reader: "web", acknowledged: String(last) }]);
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
    expect(html).toContain(`<a href="/${request.key}">${request.key}</a>`);
    expect(html).toContain("a question");
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
