import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequestListsRoute, REQUEST_LISTS_PATH, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";

// The web UI's request lists, at /requests (requests: Every member sees every
// request; agent-surfaces: The MCP tools; design.md, Decisions this change
// rests on: D28 #3, #56). A member finds three lists there: the requests
// addressed to their teams, which list_inbox reads, the requests they opened,
// and every request of the install, which every member sees whatever teams
// they belong to; each newest first, optionally only those in one state, a
// page at a time. Each row links to the request's page at its URL and says
// its state, its teams, who opened it and who holds its claim, and whether it
// waits for a person. The page reads the lists through execute(), as the
// member's web session, in read-only transactions; the list of the requests a
// member opened is an internal read that no agent surface offers.
//
// Three requests are seeded. Alice opened FE-1 from BE to FE, Bob opened BE-1
// from FE to BE, and Carol opened FE-2 from OPS to FE. Dave is a member of QA,
// a team that none of them involves.

let install: TestInstall;
let alice: WebSessionCaller;
let bob: WebSessionCaller;
let carol: WebSessionCaller;
let dave: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const ops = await addTeam(install.owner, "OPS");
  const qa = await addTeam(install.owner, "QA");
  alice = sessionOf(await addUser(install.owner, { login: "alice" }));
  bob = sessionOf(await addUser(install.owner, { login: "bob" }));
  carol = sessionOf(await addUser(install.owner, { login: "carol" }));
  dave = sessionOf(await addUser(install.owner, { login: "dave" }));
  await joinTeams(install.owner, alice.userId, be);
  await joinTeams(install.owner, bob.userId, fe);
  await joinTeams(install.owner, carol.userId, ops);
  await joinTeams(install.owner, dave.userId, qa);
  await openRequestInTheWebUi(install, alice.userId, { targetTeam: "FE", title: "Add a <b>dark</b> mode" });
  await openRequestInTheWebUi(install, bob.userId, { targetTeam: "BE", title: "Expose the settings API" });
  await openRequestInTheWebUi(install, carol.userId, { targetTeam: "FE", title: "Fix the footer" });
  // Requests are listed newest first; the seeds are opened within the same millisecond at times, so their order is set.
  await install.owner.query("UPDATE requests SET created_at = now() - interval '10 minutes' WHERE title LIKE 'Add a%'");
  await install.owner.query("UPDATE requests SET created_at = now() - interval '5 minutes' WHERE title = 'Expose the settings API'");
  await install.owner.query("UPDATE requests SET created_at = now() - interval '1 minute' WHERE title = 'Fix the footer'");
});

afterAll(async () => {
  await install?.close();
});

const route = (session: WebSessionCaller | undefined, pageSize?: number) =>
  createRequestListsRoute(
    { execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger },
    pageSize === undefined ? {} : { pageSize },
  );

/** The lists page, as the member's browser opens it with this query. */
async function open(session: WebSessionCaller | undefined, query = "", pageSize?: number): Promise<{ status: number; html: string; headers: Headers }> {
  const answer = await route(session, pageSize)(new Request(`${URL_OF_INSTALL}${REQUEST_LISTS_PATH}${query}`, { headers: { accept: "text/html" } }));
  return { status: answer.status, html: await answer.text(), headers: answer.headers };
}

/** The keys of the requests the page lists, in the order it lists them. */
function keysOf(html: string): string[] {
  return [...html.matchAll(/<td class="cell-key"><a class="key" href="\/([A-Z][A-Z0-9]*-[0-9]+)">/g)].map(([, key]) => key ?? "");
}

/** The row of a request, by its key. */
function rowOf(html: string, key: string): string {
  return new RegExp(`<tr>\\s*<td class="cell-key"><a class="key" href="/${key}">${key}</a></td>.*?</tr>`, "s").exec(html)?.[0] ?? "";
}

describe("the web UI's request lists", () => {
  it("lists the requests addressed to the member's teams by default, newest first", async () => {
    const { status, html, headers } = await open(bob);
    expect(status).toBe(200);
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("<h1>Requests</h1>");
    expect(html).toContain("Addressed to your teams");
    expect(keysOf(html)).toEqual(["FE-2", "FE-1"]);
    expect(keysOf((await open(alice)).html)).toEqual(["BE-1"]);
  });

  it("lists the requests the member opened", async () => {
    expect(keysOf((await open(alice, "?list=opened")).html)).toEqual(["FE-1"]);
    expect(keysOf((await open(bob, "?list=opened")).html)).toEqual(["BE-1"]);
    expect(keysOf((await open(carol, "?list=opened")).html)).toEqual(["FE-2"]);
  });

  it("lists every request of the install, newest first, to every member", async () => {
    for (const member of [alice, bob, carol]) expect(keysOf((await open(member, "?list=all")).html)).toEqual(["FE-2", "BE-1", "FE-1"]);
  });

  it("shows a member of a third team every request, while none is addressed to their team or opened by them", async () => {
    const all = await open(dave, "?list=all");
    expect(all.status).toBe(200);
    expect(keysOf(all.html)).toEqual(["FE-2", "BE-1", "FE-1"]);
    const mine = await open(dave);
    expect(keysOf(mine.html)).toEqual([]);
    expect(mine.html).toContain("No unfinished request is addressed to your teams.");
    const opened = await open(dave, "?list=opened");
    expect(keysOf(opened.html)).toEqual([]);
    expect(opened.html).toContain("You have opened no request.");
  });

  it("links each request to its page and says its title, state, teams, requester and claimant, with its title escaped", async () => {
    expect((await callApi(install, tokenOf(bob.userId), "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
    const { html } = await open(dave, "?list=all");
    const row = rowOf(html, "FE-1");
    expect(row).toContain("Add a &#60;b&#62;dark&#60;/b&#62; mode");
    expect(row).not.toContain("<b>");
    expect(row).toContain('<span class="chip claimed">Claimed</span>');
    expect(row).toContain('<td data-label="To"><span class="key">FE</span></td>');
    expect(row).toContain('<td data-label="From">alice for BE</td>');
    expect(row).toContain('<td data-label="Claimed by">bob</td>');
    expect(rowOf(html, "FE-2")).toContain('<td data-label="Claimed by">nobody</td>');
  });

  it("marks a request that waits for a person", async () => {
    await install.owner.query("UPDATE requests SET needs_human = true WHERE title = 'Expose the settings API'");
    try {
      const { html } = await open(dave, "?list=all");
      expect(rowOf(html, "BE-1")).toContain('<span class="chip waits">Waits for a person</span>');
      expect(rowOf(html, "FE-2")).not.toContain("Waits for a person");
    } finally {
      await install.owner.query("UPDATE requests SET needs_human = false WHERE title = 'Expose the settings API'");
    }
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (28): the list addressed to the
  // member's teams reads list_inbox, which leaves out finished requests unless a state names one.
  it("leaves finished requests out of the list addressed to the member's teams unless a state names one, and says so", async () => {
    await install.owner.query("UPDATE requests SET state = 'done' WHERE title = 'Fix the footer'");
    try {
      const mine = await open(bob);
      expect(keysOf(mine.html)).toEqual(["FE-1"]);
      expect(mine.html).toContain('<option value="" selected>Not finished</option>');
      expect(keysOf((await open(bob, "?state=done")).html)).toEqual(["FE-2"]);
      const all = await open(bob, "?list=all");
      expect(keysOf(all.html)).toEqual(["FE-2", "BE-1", "FE-1"]);
      expect(all.html).toContain('<option value="" selected>Any state</option>');
    } finally {
      await install.owner.query("UPDATE requests SET state = 'open' WHERE title = 'Fix the footer'");
    }
  });

  it("lists only the requests in the state it is given", async () => {
    expect(keysOf((await open(dave, "?list=all&state=claimed")).html)).toEqual(["FE-1"]);
    expect(keysOf((await open(bob, "?state=open")).html)).toEqual(["FE-2"]);
    expect(keysOf((await open(alice, "?list=opened&state=open")).html)).toEqual([]);
  });

  it("shows a page at a time, with links to the older and the newer requests", async () => {
    const first = await open(dave, "?list=all", 2);
    expect(keysOf(first.html)).toEqual(["FE-2", "BE-1"]);
    expect(first.html).toContain('<a class="button secondary" href="/requests?list=all&#38;page=2">Older requests</a>');
    expect(first.html).not.toContain("Newer requests");
    const second = await open(dave, "?list=all&page=2", 2);
    expect(keysOf(second.html)).toEqual(["FE-1"]);
    expect(second.html).toContain('<a class="button secondary" href="/requests?list=all">Newer requests</a>');
    expect(second.html).not.toContain("Older requests");
    expect((await open(dave, "?list=all&state=claimed&page=1", 2)).html).not.toContain("Older requests");
  });

  it("links the three lists to one another and to the form that opens a request", async () => {
    const { html } = await open(dave, "?list=all");
    expect(html).toContain('<a href="/requests">Addressed to your teams</a>');
    expect(html).toContain('<a href="/requests?list=opened">Opened by you</a>');
    expect(html).toContain('<a class="button" href="/requests/new">Open a request</a>');
    expect(html).toContain('<a href="/requests?list=all" aria-current="page">All requests</a>');
  });

  it("refuses a list, a state or a page it does not know with 400", async () => {
    expect((await open(dave, "?list=everything")).status).toBe(400);
    expect((await open(dave, "?state=lost")).status).toBe(400);
    expect((await open(dave, "?page=0")).status).toBe(400);
    expect((await open(dave, "?page=two")).status).toBe(400);
  });

  it("sends a browser without a session to sign in first, and it comes back to the lists", async () => {
    const answer = await open(undefined);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(REQUEST_LISTS_PATH)}`);
  });

  it("reads the requests a member opened through an internal read that no agent surface offers", async () => {
    await expect(install.execute("requests.list_opened", tokenOf(alice.userId), {})).rejects.toMatchObject({ reason: "route-not-found", status: 404 });
    await expect(install.execute("requests.list_opened", alice, {})).resolves.toMatchObject({ "requests": [{ key: "FE-1" }] });
  });
});
