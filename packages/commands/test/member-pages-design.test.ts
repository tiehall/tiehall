import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import {
  createEmailSettingsRoute,
  createHomeRoute,
  createInboxRoute,
  createMembersRoute,
  createTokensRoute,
  type Execute,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { controlProblems, element, mainOf } from "./support/markup.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// The inbox and the member's pages as the design draws them (web-ui: The page
// shell and its navigation; web-ui: A request's state looks the same
// everywhere; web-ui: Pages are accessible; web-ui: Motion, and reduced
// motion; design.md, Design: The page families; design.md, Design:
// Accessibility; D57 (1), (4), (6), (8)): the home page shows the banners,
// then the four cards with the waiting count; the inbox shows what waits for
// the member first, under the signal lamp, each proposal as a card with its
// key, what it proposes, who proposed it, when it expires, what it still
// needs, its review link and its reject form; then the updates with their
// count and the acknowledge form, the receipts with the undo link while the
// window is open, and the WARN digests and re-confirmation requests; and the
// members, email settings and connected agents and tokens pages put every
// action in a button or a link and label every field. The inbox is read from
// a standing list and a feed the test gives it, so every part shows at once;
// the other pages from a test install.

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let stub: GitHubStub;
let ada: WebSessionCaller;
let bob: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  const fe = await addTeam(install.owner, "FE");
  ada = sessionOf(await addUser(install.owner, { login: "ada", role: "admin" }));
  bob = sessionOf(await addUser(install.owner, { login: "bob" }));
  await joinTeams(install.owner, ada.userId, fe);
  await joinTeams(install.owner, bob.userId, fe);
}, 300_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
}, 300_000);

const user = (login: string) => ({ id: randomUUID(), login, kind: "human" as const, bot: false });

/** A proposal to decline FE-7, made by Erin's agent, which waits for the reader and then for a member of BE. */
function waitingProposal(reader: WebSessionCaller) {
  return {
    id: randomUUID(),
    request: { id: randomUUID(), key: "FE-7" },
    kind: "decline",
    state: "pending",
    change: {},
    proposedBy: { user: user("erin"), actorKind: "agent", surface: "api" },
    confirmations: {
      needed: [
        { step: "accountable_human", user: { ...user("reader"), id: reader.userId }, rules: [], team: null },
        { step: "other_side", user: null, rules: ["requester_side"], team: { id: randomUUID(), key: "BE" } },
      ],
      received: [],
    },
    createdAt: iso(-DAY),
    expiresAt: iso(6 * DAY + 60_000),
    endedAt: null,
    cancelReason: null,
    untrusted: { client: null, packet: null },
  };
}

/** Runs the inbox route on a standing list and a feed the test gives, for this reader. */
async function inboxOf(reader: WebSessionCaller): Promise<{ html: string; waiting: ReturnType<typeof waitingProposal>; receipt: string }> {
  const waiting = waitingProposal(reader);
  const receipt = randomUUID();
  const requestId = randomUUID();
  const outputs: Readonly<Record<string, unknown>> = {
    "web.shell": { login: "ada", kind: "human", bot: false, admin: false, waiting: 1 },
    "inbox.standing_list": {
      waiting: [waiting],
      receipts: [{ id: randomUUID(), text: "You confirmed the decline of FE-3; it took effect.", undoUntil: iso(12 * 60_000), proposal: { ...waitingProposal(reader), id: receipt } }],
      reminders: [{ id: randomUUID(), text: "Your personal access token Deploy expires on 2026-10-20." }],
      warnDigests: [
        {
          team: { id: randomUUID(), key: "FE" },
          day: "2026-10-10",
          text: "FE's WARN digest of 2026-10-10: 1 potentially breaking change.",
          changeSets: [{ api: "payments-api", pullRequest: { repository: "acme/payments", number: 88, url: "https://github.com/acme/payments/pull/88" }, untrusted: { changes: [{ id: "response-property-type-changed", operation: "GET /orders" }] } }],
        },
      ],
      reconfirmations: [{ api: { id: randomUUID(), name: "payments-api" }, team: { id: randomUUID(), key: "FE" }, text: "FE declared that it consumes payments-api, last confirmed on 2026-07-01." }],
    },
    "inbox.updates": {
      events: [
        { number: 41, type: "request.opened", occurredAt: iso(-3 * 60_000), data: { requestId }, request: { id: requestId, key: "FE-7", targetTeam: { id: randomUUID(), key: "FE" }, url: `${URL_OF_INSTALL}/FE-7` } },
        { number: 42, type: "request.state_changed", occurredAt: iso(-60_000), data: { requestId, state: "needs_info", previousState: "claimed" }, request: { id: requestId, key: "FE-7", targetTeam: { id: randomUUID(), key: "FE" }, url: `${URL_OF_INSTALL}/FE-7` } },
      ],
      // The key is quoted, so the source-citation check does not take it for a citation of the capability.
      "requests": [{ id: requestId, untrusted: { title: "Add a <b>dark</b> mode" } }],
      cursor: 40,
      more: false,
    },
  };
  const execute = (async (commandId: string) => outputs[commandId]) as Execute;
  const route = createInboxRoute({ execute, session: async () => reader, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
  const html = await (await route(new Request(`${URL_OF_INSTALL}/inbox`, { headers: { accept: "text/html" } }))).text();
  return { html, waiting, receipt };
}

describe("the home page", () => {
  it("shows the banners first, then the four cards, the inbox's with the waiting count beside its lamp", async () => {
    const route = createHomeRoute({
      session: async () => ada,
      secret: () => install.authSecret,
      shell: async () => ({ login: "ada", kind: "human", bot: false, admin: true, waiting: 2 }) as never,
      banners: async () => [{ text: "GitHub's webhook deliveries fail.", link: { href: "/admin/github", text: "The GitHub page" } }] as never,
    });
    const html = await (await route(new Request(`${URL_OF_INSTALL}/`, { headers: { accept: "text/html" } }))).text();
    const main = mainOf(html);
    const banners = main.indexOf('<section class="banners" aria-label="Alerts">');
    const cards = main.indexOf('<ul class="cards">');
    expect(banners).toBeGreaterThan(0);
    expect(cards).toBeGreaterThan(banners);
    expect(element(main, /<section class="banners"/, "section")).toContain('<div class="notice banner">');
    const titles = [...element(main, /<ul class="cards">/, "ul").matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map(([, title = ""]) => title.replace(/<[^>]+>/g, ""));
    expect(titles).toEqual(["Waiting for you", "Requests", "Live hall", "New request"]);
    expect(main).toContain('<h2><span class="lamp needs-info blink" aria-hidden="true"></span>Waiting for you</h2>');
    expect(main).toContain("2 proposals wait for your confirmation.");
    expect(controlProblems(main)).toEqual([]);
  });
});

describe("the inbox", () => {
  it("shows what waits for the member first, under the signal lamp, with the count in words", async () => {
    const { html } = await inboxOf(ada);
    const main = mainOf(html);
    const waiting = element(main, /<section class="waiting"/, "section");
    expect(main.indexOf(waiting)).toBeLessThan(main.indexOf('aria-labelledby="updates"'));
    expect(waiting).toMatch(/<div class="section-head">\s*<span class="lamp needs-info blink" aria-hidden="true"><\/span>\s*<h2 id="waiting-heading">Waiting for you<\/h2>\s*<span class="muted">1 waiting<\/span>/);
  });

  it("shows each waiting proposal as a card: its key, what it proposes, who proposed it, when it expires, what it still needs, its review link and its reject form", async () => {
    const { html, waiting } = await inboxOf(ada);
    const card = element(mainOf(html), /<li class="card waiting-card">/, "li");
    expect(card).toContain('<a class="key" href="/FE-7">FE-7</a>');
    expect(card).toMatch(new RegExp(`Expires <time datetime="${waiting.expiresAt}">in 6 days</time>`));
    expect(card).toContain("<h3>A proposal to decline it</h3>");
    expect(card).toContain("<p>Made by erin&#39;s agent through the API.</p>");
    expect(card).toContain(`It still needs the confirmation of you, then the requesting user or a member of team BE. It expires at ${waiting.expiresAt}.`);
    expect(card).toContain(`<a class="button" href="/confirm/${waiting.id}">Review and confirm</a>`);
    expect(card).toMatch(new RegExp(`<form method="post" action="/inbox">\\s*<input type="hidden" name="action" value="reject">\\s*<input type="hidden" name="proposal" value="${waiting.id}">[\\s\\S]*<button type="submit" class="secondary">Reject</button>`));
  });

  it("shows the updates with their count, each in Tiehall's words with its request's title as text, and the form that acknowledges them", async () => {
    const updates = element(mainOf((await inboxOf(ada)).html), /<section class="panel updates" aria-labelledby="updates"/, "section");
    expect(updates).toContain("2 updates since you last acknowledged, oldest first.");
    expect(updates).toMatch(/<input type="hidden" name="action" value="acknowledge">\s*<input type="hidden" name="upTo" value="42">[\s\S]*<button type="submit" class="secondary">Acknowledge these updates<\/button>/);
    const rows = [...updates.matchAll(/<li class="update slide-in">([\s\S]*?)<\/li>/g)].map(([, row = ""]) => row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(rows).toEqual([
      expect.stringMatching(/^FE-7 It was opened Add a &#60;b&#62;dark&#60;\/b&#62; mode Update 41 · team FE · 3 min ago$/),
      expect.stringMatching(/^FE-7 It moved from claimed to needs info Add a &#60;b&#62;dark&#60;\/b&#62; mode Update 42 · team FE · 1 min ago$/),
    ]);
  });

  it("shows the receipts with the undo link while its window is open, then the reminders, the WARN digests and the declarations to re-confirm", async () => {
    const { html, receipt } = await inboxOf(ada);
    const main = mainOf(html);
    const receipts = element(main, /<section class="panel" aria-labelledby="receipts-heading"/, "section");
    expect(receipts).toMatch(new RegExp(`<li class="receipt"><svg class="receipt-mark"[^>]*aria-hidden="true"[\\s\\S]*<p>You confirmed the decline of FE-3; it took effect.</p> <a class="button secondary" href="/confirm/${receipt}/undo">Undo it until `));
    const order = ["receipts-heading", "reminders-heading", "warn-digests-heading", "reconfirmations-heading"].map((id) => main.indexOf(`aria-labelledby="${id}"`));
    expect(order.every((at, index) => at > 0 && (index === 0 || at > (order[index - 1] ?? 0)))).toBe(true);
    expect(element(main, /<section class="panel" aria-labelledby="warn-digests-heading"/, "section")).toContain('(<a href="https://github.com/acme/payments/pull/88" rel="noreferrer">the provider pull request</a>)');
    expect(element(main, /<section class="panel" aria-labelledby="reconfirmations-heading"/, "section")).toMatch(/<input type="hidden" name="action" value="reconfirm">[\s\S]*<button type="submit" class="secondary">Re-confirm that FE consumes payments-api<\/button>/);
    expect(controlProblems(main)).toEqual([]);
  });

  it("says that nothing waits, with no lamp, when nothing does", async () => {
    const execute = (async (commandId: string) =>
      ({
        "web.shell": { login: "bob", kind: "human", bot: false, admin: false, waiting: 0 },
        "inbox.standing_list": { waiting: [], receipts: [], reminders: [], warnDigests: [], reconfirmations: [] },
        "inbox.updates": { events: [], "requests": [], cursor: 0, more: false },
      })[commandId]) as Execute;
    const route = createInboxRoute({ execute, session: async () => bob, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const main = mainOf(await (await route(new Request(`${URL_OF_INSTALL}/inbox`, { headers: { accept: "text/html" } }))).text());
    expect(element(main, /<section class="waiting"/, "section")).not.toContain("lamp");
    expect(main).toContain('<p class="empty">Nothing waits for your confirmation.</p>');
    expect(main).toContain('<p class="empty">No new updates.</p>');
    expect(main).toContain('<p class="empty">No receipts yet.</p>');
  });
});

/** A page of the web role, as the session's browser opens it. */
async function open(route: (request: Request) => Promise<Response>, path: string): Promise<string> {
  const answer = await route(new Request(`${URL_OF_INSTALL}${path}`, { headers: { accept: "text/html" } }));
  expect(answer.status).toBe(200);
  return answer.text();
}

const options = (session: WebSessionCaller) => ({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

describe("the member's pages", () => {
  it("members: a table with column headers, each member's role as a tag and teams as keys; an admin's actions as links and buttons", async () => {
    for (const session of [bob, ada]) {
      const main = mainOf(await open(createMembersRoute(options(session)), "/members"));
      expect(main).toContain('<table class="members stacked">');
      expect(main).toMatch(/<th scope="col">Member<\/th><th scope="col">Role<\/th><th scope="col">Teams<\/th>/);
      expect(main).toMatch(/<td data-label="Role"><span class="chip tag good">admin<\/span><\/td>\s*<td data-label="Teams"><a class="key" href="\/FE">FE<\/a><\/td>/);
      expect(controlProblems(main)).toEqual([]);
    }
    const admin = mainOf(await open(createMembersRoute(options(ada)), "/members"));
    expect(admin).toMatch(/<a class="button secondary" href="\/confirm\/members\.change_role\?input=[^"]+">Make bob an admin<\/a>/);
    expect(admin).toContain('<button type="submit" class="secondary">Mark bob as a bot</button>');
    expect(admin).toContain('<nav class="tabs" aria-label="Admin">');
    expect(admin).toContain('<a href="/members" aria-current="page">Members</a>');
  });

  it("email settings: each setting in a panel with its state and its one button", async () => {
    const main = mainOf(await open(createEmailSettingsRoute(options(bob), { emailSetUp: true }), "/settings/email"));
    for (const id of ["digest", "requester-emails", "always"]) expect(main).toContain(`<section class="panel" aria-labelledby="${id}">`);
    expect(main).toMatch(/<p class="setting-text"><span class="chip tag good">On<\/span> The daily digest is on\./);
    expect(main).toContain('<button type="submit" class="secondary">Turn the daily digest off</button>');
    expect(main).toMatch(/<span class="chip tag">Off<\/span> <span class="key">FE<\/span> <span>Emails to FE as a requester are off\.<\/span>/);
    expect(controlProblems(main)).toEqual([]);
  });

  it("connected agents and tokens: every field labelled, the scopes under their legend, and each revoke a form's button", async () => {
    expect((await install.confirm(bob, "personal_access_tokens.create", { name: "Deploy", scopes: ["requests:read"], expiresInDays: 30 })).status).toBe(200);
    const main = mainOf(await open(createTokensRoute(options(bob)), "/tokens"));
    for (const id of ["grants", "tokens", "create-token"]) expect(main).toContain(`<section class="panel" aria-labelledby="${id}">`);
    expect(main).toContain('<label for="token-name">Label</label>');
    expect(main).toMatch(/<fieldset class="choices">\s*<legend>Scopes<\/legend>/);
    expect(main).toMatch(/<p class="check"><input type="checkbox" id="scope-requests-read" name="scope" value="requests:read"> <label for="scope-requests-read">/);
    expect(main).toContain('<button type="submit" class="secondary">Revoke this token</button>');
    expect(controlProblems(main)).toEqual([]);
  });
});
