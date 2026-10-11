import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInboxRoute, INBOX_PATH } from "../src/index.ts";
import { startBrowserHarness, type BrowserHarness } from "./support/browser.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// The standing list of the web inbox, in a browser (requester-loop: The web
// inbox; requests: Where a proposal waits; requests: Receipts; design.md,
// Decisions this change rests on: D30 (2), (4); design.md, Self-hosting
// decisions: S7). Beside the update feed, each member's web inbox at /inbox
// holds the standing list: the proposals that wait for a confirmation they
// may give now, each with a link to its confirm page and a form that rejects
// it, and the receipts of their confirmations, which show how a proposal that
// waited for the other side ended. Acknowledging the feed never clears it. Each
// person uses their own browser, signed in with their own web session; the
// confirm pages are the install's own.

let install: TestInstall;
let browser: BrowserHarness;
let sam: string;
let bob: string;
let erin: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  sam = await addUser(install.owner, { login: "sam" });
  bob = await addUser(install.owner, { login: "bob" });
  erin = await addUser(install.owner, { login: "erin" });
  await joinTeams(install.owner, sam, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, erin, fe);
  browser = await startBrowserHarness(install, {
    pages: {
      [INBOX_PATH]: (session, origin) => createInboxRoute({ execute: install.execute, session, url: origin, secret: () => install.authSecret, logger: install.logger }),
    },
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await install?.close();
}, 60_000);

/** Opens the person's web inbox in their own browser. */
async function inbox(userId: string): Promise<Page> {
  const page = await browser.pageOf(sessionOf(userId));
  const answer = await page.goto(`${browser.origin}${INBOX_PATH}`);
  expect(answer?.status()).toBe(200);
  return page;
}

/** The keys of the requests whose proposals the page lists as waiting for its reader. */
async function waitingOn(page: Page): Promise<string[]> {
  return page.locator("#waiting li").evaluateAll((items) => items.map((item) => item.querySelector("a")?.textContent ?? ""));
}

/** The receipts the page lists, as their text. */
async function receiptsOn(page: Page): Promise<string[]> {
  return page.locator("#receipts li").allTextContents();
}

/** The standing list's item of the request on the page. */
function itemOf(page: Page, key: string) {
  return page.locator("#waiting li").filter({ has: page.locator(`a[href="/${key}"]`) });
}

/** A due date the requester side proposes on a new request to FE, at its first revision; returns its key and the proposal. */
async function requesterDueDate(): Promise<{ key: string; proposal: string }> {
  const request = await openRequest(install, tokenOf(sam), { targetTeam: "FE" });
  const proposed = await sendApi(install, tokenOf(sam), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
    headers: { "if-match": '"1"' },
  });
  expect(proposed.status).toBe(202);
  return { key: request.key, proposal: proposed.body.proposal.id };
}

/** Follows the item's link to its confirm page and confirms there; returns the page after the confirmation's answer. */
async function confirmFrom(page: Page, key: string): Promise<void> {
  await Promise.all([page.waitForNavigation(), itemOf(page, key).getByRole("link", { name: "Review and confirm" }).click()]);
  await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Confirm" }).click()]);
}

describe("the standing list", { timeout: 60_000 }, () => {
  // requester-loop: The web inbox, "A due date waits in the other side's web inboxes".
  it("moves a due date to the other side's lists once its accountable human confirms, and clears it from both once one of them confirms", async () => {
    const { key } = await requesterDueDate();
    const samsPage = await inbox(sam);
    expect(await waitingOn(samsPage)).toContain(key);
    await confirmFrom(samsPage, key);
    await samsPage.goto(`${browser.origin}${INBOX_PATH}`);
    expect(await waitingOn(samsPage)).not.toContain(key);
    expect(await receiptsOn(samsPage)).toContainEqual(expect.stringContaining(`You confirmed setting the due date of ${key} to 2026-10-15`));
    await samsPage.context().close();

    const erinsPage = await inbox(erin);
    expect(await waitingOn(erinsPage)).toContain(key);
    const bobsPage = await inbox(bob);
    expect(await waitingOn(bobsPage)).toContain(key);
    await confirmFrom(bobsPage, key);
    await bobsPage.goto(`${browser.origin}${INBOX_PATH}`);
    expect(await waitingOn(bobsPage)).not.toContain(key);
    await erinsPage.reload();
    expect(await waitingOn(erinsPage)).not.toContain(key);
    expect((await callApi(install, tokenOf(sam), "GET", `/api/v1/requests/${key}/packet`)).body.packet.due_date).toBe("2026-10-15");
    await bobsPage.context().close();
    await erinsPage.context().close();
  });

  // requester-loop: The web inbox, "A waiting proposal outlasts the acknowledged feed".
  it("still lists a waiting proposal after its reader acknowledges every update in the feed", async () => {
    const request = await openRequest(install, tokenOf(sam), { targetTeam: "FE" });
    const declined = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    expect(declined.status).toBe(202);
    const page = await inbox(bob);
    expect(await waitingOn(page)).toContain(request.key);
    // Every page of the feed, acknowledged in turn.
    while ((await page.getByRole("button", { name: "Acknowledge these updates" }).count()) > 0) {
      await Promise.all([page.waitForNavigation(), page.getByRole("button", { name: "Acknowledge these updates" }).click()]);
    }
    expect(await page.textContent("body")).toContain("No new updates.");
    expect(await waitingOn(page)).toContain(request.key);
    await page.context().close();
  });

  // requester-loop: The web inbox, "A receipt shows how a half-confirmed proposal ended".
  it("shows in the accountable human's receipt that a due date they confirmed was rejected by the other side, from the other side's list", async () => {
    const { key, proposal } = await requesterDueDate();
    expect((await install.confirm(sessionOf(sam), "proposals.confirm", { proposal })).status).toBe(200);
    const bobsPage = await inbox(bob);
    await Promise.all([bobsPage.waitForNavigation(), itemOf(bobsPage, key).getByRole("button", { name: "Reject" }).click()]);
    expect(new URL(bobsPage.url()).pathname).toBe(INBOX_PATH);
    expect(await waitingOn(bobsPage)).not.toContain(key);
    await bobsPage.context().close();
    const samsPage = await inbox(sam);
    const receipt = (await receiptsOn(samsPage)).find((text) => text.includes(`the due date of ${key}`));
    expect(receipt).toContain("It was rejected, so it did not take effect.");
    await samsPage.context().close();
  });

  it("names what each waiting proposal proposes, who proposed it and when it expires, in Tiehall's words", async () => {
    const request = await openRequest(install, tokenOf(sam), { targetTeam: "FE" });
    const declined = await callApi(install, tokenOf(erin), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
    const expiresAt: string = declined.body.proposal.expiresAt;
    const page = await inbox(erin);
    const text = await itemOf(page, request.key).textContent();
    // Each waiting proposal is a card: its key, what it proposes, who proposed it and when it expires (web-ui: The page shell and its navigation).
    expect(text).toContain(request.key);
    expect(text).toContain("A proposal to decline it");
    expect(text).toContain("Made by erin's agent through the API.");
    expect(text).toContain(`It expires at ${expiresAt}.`);
    expect(await itemOf(page, request.key).getByRole("link", { name: "Review and confirm" }).getAttribute("href")).toBe(`/confirm/${declined.body.proposal.id}`);
    await page.context().close();
  });
});
