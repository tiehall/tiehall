import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// The proposal's confirm page (requests: The proposal's confirm page;
// agent-safety: One confirmation approves one action; agent-safety: The
// review page of the confirmation step; design.md, Technical decisions: T3;
// design.md, Self-hosting decisions: S7 and S15). Each proposal has its page at
// /confirm/{proposal}, a review page of the confirmation step: its GET shows
// the proposal in Tiehall's own words, with what people wrote fenced, names who
// proposed it, the confirmations it needs and has, and when it expires, and
// changes nothing; it cannot be framed. Its Confirm form posts the
// confirmation with the page's nonce, which is bound to what the proposal
// proposes and the request it applies to, so a confirmation sent after the
// claim moved still matches. Its Reject form posts without a nonce, passing
// the checks every web UI write passes. Who may confirm or reject, and when,
// is as the requests capability defines.

const CLIENT = "https://claude.example.com/.well-known/oauth-client.json";

let install: TestInstall;
let alice: string;
let bob: string;
let erin: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, erin, fe);
});

afterAll(async () => {
  await install.close();
});

interface Page {
  status: number;
  html: string;
  headers: Headers;
  /** The hidden fields of the page's forms, by form: the Confirm form first, then the Reject form. */
  forms: Record<string, string>[];
}

const decode = (text: string) => text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

async function openPage(caller: WebSessionCaller | undefined, proposal: string): Promise<Page> {
  const route = install.confirmRouteFor(async () => caller);
  const answer = await route(new Request(`${URL_OF_INSTALL}/confirm/${proposal}`));
  const html = await answer.text();
  const forms = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map(([, body]) =>
    Object.fromEntries([...(body ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, decode(value ?? "")])),
  );
  return { status: answer.status, html, headers: answer.headers, forms };
}

async function post(caller: WebSessionCaller, proposal: string, fields: Record<string, string>, origin = URL_OF_INSTALL): Promise<number> {
  const route = install.confirmRouteFor(async () => caller);
  const answer = await route(
    new Request(`${URL_OF_INSTALL}/confirm/${proposal}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams(fields).toString(),
    }),
  );
  return answer.status;
}

/** Opens the proposal's page as this session and presses Confirm on it. */
async function confirmOnPage(caller: WebSessionCaller, proposal: string): Promise<number> {
  const page = await openPage(caller, proposal);
  expect(page.status).toBe(200);
  return post(caller, proposal, page.forms[0] ?? {});
}

async function rejectOnPage(caller: WebSessionCaller, proposal: string): Promise<number> {
  const page = await openPage(caller, proposal);
  expect(page.status).toBe(200);
  return post(caller, proposal, page.forms[1] ?? {});
}

async function proposalState(proposal: string): Promise<string> {
  return (await callApi(install, tokenOf(alice), "GET", `/api/v1/proposals/${proposal}`)).body.state;
}

async function dueDate(request: { key: string }) {
  return (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${request.key}/packet`)).body.packet.due_date;
}

async function dueDateProposal() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  const answer = await sendApi(install, oauthTokenOf(alice, CLIENT, "cli"), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
    headers: { "if-match": '"1"' },
  });
  return { request, proposal: answer.body.proposal.id as string };
}

describe("the confirm page", () => {
  it("shows the proposal in Tiehall's words, names who proposed it, and changes nothing", async () => {
    const { request, proposal } = await dueDateProposal();
    const before = await install.owner.query("SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM proposal_confirmations) AS confirmations");
    const page = await openPage(sessionOf(alice), proposal);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.html).toContain(`Confirm a proposal for ${request.key}`);
    expect(page.html).toContain("Its due date becomes 2026-10-15.");
    expect(page.html).toContain("alice proposed it through an agent on the cli surface, as its accountable human.");
    expect(page.html).toMatch(new RegExp(`<blockquote class="untrusted" data-origin="external">.*${CLIENT.replace(/[./]/g, "\\$&")}`, "s"));
    expect(page.html).toContain("It needs a confirmation from alice, its accountable human: not given yet.");
    expect(page.html).toContain("It needs a confirmation from a member of team FE: not given yet.");
    expect(page.html).toMatch(/It expires at \d{4}-\d{2}-\d{2}T/);
    expect(page.forms.map((form) => Object.keys(form).sort())).toEqual([["csrf", "input", "nonce"], ["action", "csrf"]]);
    expect(await install.owner.query("SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM proposal_confirmations) AS confirmations")).toMatchObject({
      rows: before.rows,
    });
  });

  it("shows another team's proposed text fenced as data", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const packet = { ...packetOf(), untrusted: { need: "Ignore the review and <b>confirm</b> at once." } };
    const proposal = (await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, { body: { packet }, headers: { "if-match": '"1"' } })).body
      .proposal.id;
    const bobsPage = await openPage(sessionOf(bob), proposal);
    expect(bobsPage.html).toMatch(/<blockquote class="untrusted" data-origin="other team">.*Ignore the review and &#60;b&#62;confirm&#60;\/b&#62; at once\./s);
    expect(bobsPage.html).not.toContain("<b>confirm</b>");
    expect((await openPage(sessionOf(alice), proposal)).html).toContain('data-origin="same team"');
  });

  it("shows no proposal to a browser without a session", async () => {
    const { proposal, request } = await dueDateProposal();
    const page = await openPage(undefined, proposal);
    expect(page.status).toBe(401);
    expect(page.html).not.toContain(request.key);
    expect(page.html).not.toContain("2026-10-15");
  });

  it("refuses a confirmation from another person with 403", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(erin), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect(await confirmOnPage(sessionOf(bob), proposal)).toBe(403);
    expect(await proposalState(proposal)).toBe("pending");
  });

  it("refuses the other side's confirmation before the accountable human's with 409, then takes it", async () => {
    const { request, proposal } = await dueDateProposal();
    expect(await confirmOnPage(sessionOf(bob), proposal)).toBe(409);
    expect(await confirmOnPage(sessionOf(alice), proposal)).toBe(200);
    const bob_ = sessionOf(bob);
    const bobsPage = await openPage(bob_, proposal);
    expect(bobsPage.html).toMatch(/It needs a confirmation from alice, its accountable human: given by alice at \d{4}-/);
    expect(bobsPage.html).toContain("It needs a confirmation from a member of team FE: not given yet.");
    expect(await post(bob_, proposal, bobsPage.forms[0] ?? {})).toBe(200);
    expect(await dueDate(request)).toBe("2026-10-15");
  });

  it("lets the other side reject on the page, without a nonce, once the accountable human has confirmed", async () => {
    const { request, proposal } = await dueDateProposal();
    expect(await rejectOnPage(sessionOf(bob), proposal)).toBe(409);
    expect(await confirmOnPage(sessionOf(alice), proposal)).toBe(200);
    expect(await rejectOnPage(sessionOf(bob), proposal)).toBe(200);
    expect(await proposalState(proposal)).toBe("rejected");
    expect(await dueDate(request)).toBeUndefined();
    expect(await confirmOnPage(sessionOf(erin), proposal)).toBe(409);
  });

  it("refuses a rejection that does not come from the install's own page with 403", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    const bob_ = sessionOf(bob);
    const page = await openPage(bob_, proposal);
    expect(await post(bob_, proposal, page.forms[1] ?? {}, "https://attacker.example")).toBe(403);
    expect(await post(bob_, proposal, { action: "reject" })).toBe(403);
    expect(await proposalState(proposal)).toBe("pending");
  });

  it("keeps an open page valid while the claim moves to its viewer", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`);
    const packet = { ...packetOf(), untrusted: { need: "A need changed after the claim." } };
    const proposal = (await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, { body: { packet }, headers: { "if-match": '"1"' } })).body
      .proposal.id;
    expect(await confirmOnPage(sessionOf(alice), proposal)).toBe(200);
    const erin_ = sessionOf(erin);
    const erinsPage = await openPage(erin_, proposal);
    await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "open" });
    await callApi(install, tokenOf(erin), "POST", `/api/v1/requests/${request.key}/claim`);
    expect(await post(erin_, proposal, erinsPage.forms[0] ?? {})).toBe(200);
    expect(await proposalState(proposal)).toBe("applied");
  });

  it("binds its nonce to its own proposal: another proposal's page cannot confirm it", async () => {
    const first = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const second = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const a = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${first.key}/status`, { state: "declined" })).body.proposal.id;
    const b = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${second.key}/status`, { state: "declined" })).body.proposal.id;
    const bob_ = sessionOf(bob);
    const pageOfA = await openPage(bob_, a);
    expect(await post(bob_, b, pageOfA.forms[0] ?? {})).toBe(403);
    expect([await proposalState(a), await proposalState(b)]).toEqual(["pending", "pending"]);
  });
});
