import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBrowserHarness, type BrowserHarness } from "./support/browser.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// The confirm-flow tests in a browser (requests: The proposal's confirm page;
// requests: Cross-team commitments need a confirmation from each side;
// design.md, Self-hosting decisions: S7). A commitment an agent starts
// becomes a proposal, and people confirm it on its confirm page,
// /confirm/{proposal}, each in their own browser signed in with their own web
// session: the page's form posts the confirmation with its nonce, from the
// install's own origin. They are committed as expected failures until task
// 14.10 builds the confirm page; review-page-browser.test.ts checks the
// harness with another action's review page.

let install: TestInstall;
let browser: BrowserHarness;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  browser = await startBrowserHarness(install);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await install?.close();
});

/** Opens a page in the person's own browser and confirms what it reviews; returns the page after the confirmation's answer. */
async function confirmOnPage(userId: string, path: string): Promise<Page> {
  const page = await browser.pageOf(sessionOf(userId));
  const review = await page.goto(`${browser.origin}${path}`);
  expect(review?.status()).toBe(200);
  await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Confirm" }).click()]);
  return page;
}

/** The request's state and its packet's due date, as a member reads them through /api/v1. */
async function stateAndDueDate(key: string): Promise<{ state: string; dueDate: unknown; revision: number }> {
  const request = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}`);
  const packet = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet`);
  return { state: request.body.state, dueDate: packet.body.packet.due_date, revision: packet.body.revision };
}

describe("the confirm flow", { timeout: 60_000 }, () => {
  it.fails("confirms a decline an agent proposed on the proposal's confirm page", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposed = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(proposed.status).toBe(202);
    const proposal: string = proposed.body.proposal.id;
    expect((await stateAndDueDate(request.key)).state).toBe("open");

    const page = await confirmOnPage(bob, `/confirm/${proposal}`);
    expect((await stateAndDueDate(request.key)).state).toBe("declined");
    await page.context().close();
  });

  it.fails("confirms a due date the requester side proposed, first by its accountable human, then by a member of the target team", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposed = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
      body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
      headers: { "if-match": '"1"' },
    });
    expect(proposed.status).toBe(202);
    const proposal: string = proposed.body.proposal.id;

    const alicesPage = await confirmOnPage(alice, `/confirm/${proposal}`);
    expect(await stateAndDueDate(request.key)).toEqual({ state: "open", dueDate: undefined, revision: 1 });
    await alicesPage.context().close();

    const bobsPage = await confirmOnPage(bob, `/confirm/${proposal}`);
    expect(await stateAndDueDate(request.key)).toEqual({ state: "open", dueDate: "2026-10-15", revision: 2 });
    await bobsPage.context().close();
  });
});
