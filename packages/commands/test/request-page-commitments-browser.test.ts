import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The commitment actions on the web UI's page of a request (requests:
// Commitments become proposals; requests: Which side may act on a request;
// requests: Cross-team commitments need a confirmation from each side;
// handoff-packet: Packet changes that are commitments; design.md, Decisions
// this change rests on: D23; design.md, Self-hosting decisions: S7). A member
// of the target team declines a request, marks it done or reassigns it; the
// requester side withdraws it or changes its packet; either side proposes a
// due date or its removal. Each runs the operation an agent would run, as the
// member's web session, and a commitment leaves the request as it is and waits
// as a proposal, which the page lists with a link to its confirm page, where
// the person who proposed it reviews it. A packet change before the request is
// claimed is no commitment: it is the packet's next revision at once. The page
// runs in the installed Chrome against the web app as the image runs it
// (web-app.ts), signed in with real web sessions.

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let signIn: SignInHarness;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await addTeam(install.owner, "QA");
  alice = await addUser(install.owner, { login: "alice", githubAccountId: stub.addUser({ login: "alice" }).id });
  bob = await addUser(install.owner, { login: "bob", githubAccountId: stub.addUser({ login: "bob" }).id });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  // FE-1 is claimed by Bob; FE-2 stays open.
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Add a dark mode" });
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Fix the footer" });
  expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
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

/** The pending proposals of a request, newest first, as /api/v1 reads them, by kind and proposer. */
async function pendingOf(key: string): Promise<{ id: string; kind: string; by: string }[]> {
  const { rows } = await install.owner.query<{ id: string; kind: string; login: string }>(
    `SELECT p.id, p.kind, u.github_login AS login FROM proposals p JOIN requests r ON r.id = p.request_id JOIN teams t ON t.id = r.target_team_id JOIN users u ON u.id = p.accountable_user_id
      WHERE t.key || '-' || r.number = $1 AND p.state = 'pending' ORDER BY p.created_at DESC`,
    [key],
  );
  return rows.map(({ id, kind, login }) => ({ id, kind, by: login }));
}

/** Clicks the button, then waits until the page lists a pending proposal of this kind, and returns the proposal; the request's state is unchanged. */
async function propose(page: Page, key: string, button: string, listed: string, kind: string): Promise<string> {
  const before = (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`)).body.state;
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("region", { name: "Proposals" }).getByText(`${listed}, pending`).first().waitFor();
  const [proposal] = await pendingOf(key);
  expect(proposal?.kind).toBe(kind);
  expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`)).body.state).toBe(before);
  // The page links the proposal to its confirm page, where the person who proposed it reviews it.
  const href = `/confirm/${proposal!.id}`;
  expect(await page.getByRole("region", { name: "Proposals" }).locator(`a[href="${href}"]`).count()).toBe(1);
  return href;
}

/** Opens a proposal's confirm page in the same browser, and returns what it says. */
async function review(page: Page, href: string): Promise<string> {
  const answer = await page.goto(`${web.url}${href}`);
  expect(answer?.status()).toBe(200);
  await page.getByRole("button", { name: "Confirm" }).waitFor();
  return page.locator("main").innerText();
}

describe("the commitment actions on a request's page", () => {
  it("lets the target team propose to decline, mark done and reassign, each waiting for its confirmation", { timeout: 120_000 }, async () => {
    const page = await pageOf("bob", "FE-1");
    await propose(page, "FE-1", "Decline", "A decline", "decline");
    await propose(page, "FE-1", "Mark done", "Marking it done", "done");
    await page.getByLabel("Team to reassign it to").selectOption("QA");
    const href = await propose(page, "FE-1", "Reassign", "A reassignment", "reassign");
    expect(await review(page, href)).toMatch(/reassign/i);
    await page.context().close();
  });

  it("lets the requester side propose to withdraw, and either side propose a due date or its removal", { timeout: 120_000 }, async () => {
    const page = await pageOf("alice", "FE-1");
    await propose(page, "FE-1", "Withdraw", "A withdrawal", "withdraw");
    await page.getByLabel("Due date").fill("2026-12-01");
    const href = await propose(page, "FE-1", "Propose the due date", "A due date", "due_date");
    expect(await page.getByText("It proposes the due date 2026-12-01.").count()).toBe(1);
    expect(await review(page, href)).toMatch(/due date/i);
    await page.context().close();

    await callApi(install, tokenOf(alice), "POST", "/api/v1/proposals", { kind: "withdraw_proposal", proposal: (await pendingOf("FE-1")).find(({ kind }) => kind === "due_date")!.id });
    const bobs = await pageOf("bob", "FE-1");
    await bobs.getByLabel("Due date").fill("2026-12-24");
    await propose(bobs, "FE-1", "Propose the due date", "A due date", "due_date");
    await bobs.context().close();
  });

  it("proposes a change of the packet while the request is claimed, and adds it at once while it is not", { timeout: 120_000 }, async () => {
    const claimed = await pageOf("alice", "FE-1");
    await claimed.getByLabel("Need").fill("Follow the system's dark mode on every page.");
    await propose(claimed, "FE-1", "Change the packet", "A scope change", "scope");
    expect((await callApi(install, tokenOf(alice), "GET", "/api/v1/requests/FE-1/packet")).body).toMatchObject({ revision: 1 });
    await claimed.context().close();

    const open = await pageOf("alice", "FE-2");
    await open.getByLabel("Need").fill("The footer overlaps the content on phones.");
    await open.getByLabel("Acceptance criteria").fill("It never overlaps.\nIt stays at the bottom.");
    await open.getByRole("button", { name: "Change the packet", exact: true }).click();
    await open.getByText("Revision 2, with no due date.").waitFor();
    const packet = await callApi(install, tokenOf(alice), "GET", "/api/v1/requests/FE-2/packet");
    expect(packet.body).toMatchObject({
      revision: 2,
      packet: { kind: "request", untrusted: { need: "The footer overlaps the content on phones.", acceptance_criteria: ["It never overlaps.", "It stays at the bottom."] } },
    });
    expect(await pendingOf("FE-2")).toEqual([]);
    await open.context().close();
  });

  it("offers the requester side no decline and the target team no withdrawal", { timeout: 120_000 }, async () => {
    const alices = await pageOf("alice", "FE-2");
    await alices.getByRole("region", { name: "Commitments" }).waitFor();
    expect(await alices.getByRole("button", { name: "Decline", exact: true }).count()).toBe(0);
    expect(await alices.getByRole("button", { name: "Withdraw", exact: true }).count()).toBe(1);
    await alices.context().close();
    const bobs = await pageOf("bob", "FE-2");
    await bobs.getByRole("region", { name: "Commitments" }).waitFor();
    expect(await bobs.getByRole("button", { name: "Withdraw", exact: true }).count()).toBe(0);
    expect(await bobs.getByRole("button", { name: "Decline", exact: true }).count()).toBe(1);
    await bobs.context().close();
  });
});
