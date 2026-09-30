import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The direct actions on the web UI's page of a request (public-api: One
// definition per operation, the same on every surface; requests: Claiming and
// starting work need no proposal; requests: Thread messages and blocking
// questions; design.md, Technical decisions: T3). A member claims a request,
// starts work on it, releases the claim and posts in its thread from the
// page, through server actions that run requests.claim, requests.set_status
// and messages.post through execute(), as the member's web session. Each
// changes the request as its REST operation does: the tests make each change
// on one request through the page and on its twin through /api/v1, as the
// same user, and find both requests alike. A refused action shows the
// refusal the same call gets from /api/v1: its status, title and detail. The
// page runs in the installed Chrome against the web app as the image runs it
// (web-app.ts), signed in with real web sessions.

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let signIn: SignInHarness;
let alice: string;
let bob: string;
let fe: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const be = await addTeam(install.owner, "BE");
  fe = await addTeam(install.owner, "FE");
  const qa = await addTeam(install.owner, "QA");
  alice = await addUser(install.owner, { login: "alice", githubAccountId: stub.addUser({ login: "alice" }).id });
  bob = await addUser(install.owner, { login: "bob", githubAccountId: stub.addUser({ login: "bob" }).id });
  const carol = await addUser(install.owner, { login: "carol", githubAccountId: stub.addUser({ login: "carol" }).id });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, carol, qa);
  // Twins: FE-1 changes through the page, FE-2 through /api/v1. FE-3 to FE-5 are for the refusals and the thread.
  for (let index = 0; index < 5; index += 1) await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: `Request ${index + 1}` });
  web = await startWebApp(install);
  signIn = await startSignIn(install, stub, { url: web.url });
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await stub?.close();
  await install?.close();
}, 60_000);

/** A page of this person's own browser, signed in to the web app, at a request's URL. */
async function pageOf(login: string, key: string): Promise<Page> {
  const [name = "", value = ""] = ((await signIn.signIn(login)).jar.header().split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").split(/=(.*)/s);
  const context = await browser.newContext();
  await context.addCookies([{ name, value, url: web.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${web.url}/${key}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}

/** What a request is, as /api/v1 reads it, without what differs between twins: its id, key, title, times and ids. */
async function shapeOf(key: string): Promise<unknown> {
  const { body } = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`);
  return {
    state: body.state,
    claimant: body.claimant?.login ?? null,
    needsHuman: body.needsHuman,
    messages: body.messages.map((message: any) => ({ kind: message.kind, blocking: message.blocking, answered: message.answered, body: message.untrusted.body, by: message.provenance.user?.login })),
  };
}

/** The request's events, oldest first, by their type, actor kind and surface. */
async function eventsOf(number: number): Promise<{ type: string; actor_kind: string; surface: string | null }[]> {
  const { rows } = await install.owner.query(
    "SELECT e.type, e.actor_kind, e.surface FROM events e JOIN requests r ON r.id::text = e.data->>'requestId' WHERE r.number = $1 AND e.type <> 'request.opened' ORDER BY e.number",
    [number],
  );
  return rows;
}

/** The refusal the page shows, once it is there. */
async function refusalOn(page: Page): Promise<string> {
  const alert = page.getByRole("alert").filter({ hasText: "Refused" });
  await alert.waitFor();
  return alert.innerText();
}

describe("the direct actions on a request's page", () => {
  it("claims, starts, posts and releases as the REST operations do, recorded as the web session's", { timeout: 120_000 }, async () => {
    const page = await pageOf("bob", "FE-1");

    await page.getByRole("button", { name: "Claim" }).click();
    await page.getByText("Claimed by bob.").waitFor();
    expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-2/claim")).status).toBe(200);
    expect(await shapeOf("FE-1")).toEqual(await shapeOf("FE-2"));

    await page.getByRole("button", { name: "Start work" }).click();
    await page.getByText("FE-1 is in_progress").waitFor();
    expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-2/status", { state: "in_progress" })).status).toBe(200);
    expect(await shapeOf("FE-1")).toEqual(await shapeOf("FE-2"));

    await page.getByLabel("Kind").selectOption("question");
    await page.getByLabel("Blocking").check();
    await page.getByLabel("Message").fill("Which browsers must it support?");
    await page.getByRole("button", { name: "Post" }).click();
    await page.getByText("FE-1 is needs_info").waitFor();
    await page.getByRole("region", { name: "Thread" }).getByText("Which browsers must it support?").waitFor();
    expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-2/messages", { kind: "question", blocking: true, body: "Which browsers must it support?" })).status).toBe(200);
    expect(await shapeOf("FE-1")).toEqual(await shapeOf("FE-2"));

    await page.getByRole("button", { name: "Release the claim" }).click();
    await page.getByText("Nobody has claimed it.").waitFor();
    expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-2/status", { state: "open" })).status).toBe(200);
    expect(await shapeOf("FE-1")).toEqual(await shapeOf("FE-2"));

    // The same events, recorded as the web session's on the web, where the twin's are the agent's through the API.
    const page1 = await eventsOf(1);
    const rest = await eventsOf(2);
    expect(page1.map(({ type }) => type)).toEqual(rest.map(({ type }) => type));
    expect(page1.map(({ type }) => type)).toEqual(expect.arrayContaining(["request.claimed", "request.started", "request.message_posted", "request.released"]));
    expect(new Set(page1.map(({ actor_kind, surface }) => `${actor_kind} ${surface}`))).toEqual(new Set(["web_session web"]));
    expect(new Set(rest.map(({ actor_kind, surface }) => `${actor_kind} ${surface}`))).toEqual(new Set(["agent api"]));
    await page.context().close();
  });

  it("answers a blocking question from the page, which returns the request to where it was", { timeout: 120_000 }, async () => {
    const asked = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-5/messages", { kind: "question", blocking: true, body: "Is the footer in scope?" });
    expect(asked.status).toBe(200);
    const page = await pageOf("alice", "FE-5");
    await page.getByText("FE-5 is needs_info").waitFor();
    await page.getByLabel("Kind").selectOption("answer");
    await page.getByLabel("Question it answers").selectOption(asked.body.message.id);
    await page.getByLabel("Message").fill("No, only the settings page.");
    await page.getByRole("button", { name: "Post" }).click();
    await page.getByText("FE-5 is open").waitFor();
    const { body } = await callApi(install, tokenOf(alice), "GET", "/api/v1/requests/FE-5");
    expect(body.messages.map((message: any) => [message.kind, message.questionId, message.answered])).toEqual([
      ["question", null, true],
      ["answer", asked.body.message.id, null],
    ]);
    await page.context().close();
  });

  it("shows the 409 that /api/v1 gives when the request was claimed after the page was opened", { timeout: 120_000 }, async () => {
    const page = await pageOf("bob", "FE-3");
    expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-3/claim")).status).toBe(200);
    await page.getByRole("button", { name: "Claim" }).click();
    const shown = await refusalOn(page);
    const rest = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-3/claim");
    expect(rest.status).toBe(409);
    expect(shown).toContain("409");
    expect(shown).toContain(rest.body.title);
    expect(shown).toContain(rest.body.detail);
    await page.context().close();
  });

  it("shows the 403 that /api/v1 gives when the member left the target team after the page was opened, and changes nothing", { timeout: 120_000 }, async () => {
    const page = await pageOf("bob", "FE-4");
    await install.owner.query("DELETE FROM team_members WHERE user_id = $1 AND team_id = $2", [bob, fe]);
    try {
      await page.getByRole("button", { name: "Claim" }).click();
      const shown = await refusalOn(page);
      const rest = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-4/claim");
      expect(rest.status).toBe(403);
      expect(shown).toContain("403");
      expect(shown).toContain(rest.body.title);
      expect(shown).toContain(rest.body.detail);
      expect(await shapeOf("FE-4")).toMatchObject({ state: "open", claimant: null });
    } finally {
      await joinTeams(install.owner, bob, fe);
    }
    await page.context().close();
  });

  it("offers a member of a third team no action, and neither the claim nor the thread's form", { timeout: 120_000 }, async () => {
    const page = await pageOf("carol", "FE-4");
    await page.getByRole("region", { name: "Thread" }).waitFor();
    expect(await page.getByRole("button", { name: "Claim" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Post" }).count()).toBe(0);
    expect(await page.getByText("Only the two sides of the request post in its thread.").count()).toBe(1);
    await page.context().close();
  });
});
