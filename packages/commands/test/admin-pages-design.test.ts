import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createActivityLogRoute,
  createAdminRoute,
  createApisRoute,
  createGitHubAdminRoute,
  createInvitesRoute,
  createPersonalAccessTokenSettingsRoute,
  createSignInPolicyRoute,
  createTeamsRoute,
  type Execute,
  type WebSessionCaller,
} from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { controlProblems, element, mainOf } from "./support/markup.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// The admin pages as the design draws them (web-ui: The page shell and its
// navigation; web-ui: Pages are accessible; design.md, Design: The page
// families; design.md, Design: Accessibility; D57 (1), (4), (8)): the admin
// overview, a card per area that links the area's page or holds its state
// and its form, after the banners in the notice colors; and each area's page
// with the admin navigation, the page marked as the current one, its parts as
// panels, its tables with column headers and in boxes that scroll on their
// own, its forms with every field labelled, and the actions that need the
// confirmation step as links to their review pages, as before.

let install: TestInstall;
let ada: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  const fe = await addTeam(install.owner, "FE");
  const pay = await addTeam(install.owner, "PAY");
  await install.owner.query("UPDATE teams SET name = 'Frontend', intake_notes = 'One request per screen.', required_fields = ARRAY['acceptance_criteria'] WHERE key = 'FE'");
  ada = sessionOf(await addUser(install.owner, { login: "ada", role: "admin" }));
  const bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, ada.userId, fe);
  await joinTeams(install.owner, bob, pay);
  await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] });
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
  await openRequest(install, tokenOf(bob), { targetTeam: "FE", title: "Add a dark mode", packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Dark mode.", acceptance_criteria: ["It follows the system."] } } });
  expect((await callApi(install, tokenOf(ada.userId), "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
}, 300_000);

afterAll(async () => {
  await install?.close();
}, 300_000);

/** The routes' options, as the signed-in admin's; the banners of the install are the test's own when it gives them. */
function options(banners?: unknown[]) {
  const execute: Execute = async (commandId, caller, input, runOptions) =>
    commandId === "install.get_banners" && banners !== undefined ? { banners } : install.execute(commandId, caller, input, runOptions);
  return { execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger };
}

/** A page of the admin UI, as the admin's browser opens it: its main content. */
async function open(route: (request: Request) => Promise<Response>, path: string): Promise<string> {
  const answer = await route(new Request(`${URL_OF_INSTALL}${path}`, { headers: { accept: "text/html" } }));
  expect(answer.status, path).toBe(200);
  return mainOf(await answer.text());
}

/** The headings of the panels a page's main content holds. */
function panelHeadings(main: string): string[] {
  return [...main.matchAll(/<section class="panel(?: [a-z-]+)?"[^>]*>\s*<h2[^>]*>([^<]+)<\/h2>/g)].map(([, heading = ""]) => heading.replace(/&#39;/g, "'"));
}

describe("the admin overview", () => {
  it("shows the banners first, in the notice colors, then a card per area", async () => {
    const main = await open(createAdminRoute(options([{ text: "GitHub's webhook deliveries to this install fail.", link: { href: "/admin/github", text: "The GitHub page" } }])), "/admin");
    expect(main.indexOf('<div class="notice banner">')).toBeGreaterThan(0);
    expect(main.indexOf('<div class="notice banner">')).toBeLessThan(main.indexOf('<ul class="cards admin-cards">'));
    const cards = element(main, /<ul class="cards admin-cards">/, "ul");
    const titles = [...cards.matchAll(/<li class="card">\s*<h2>([^<]+)<\/h2>/g)].map(([, title]) => title);
    expect(titles).toEqual(["People and invites", "Teams", "Sign-in policy", "GitHub", "Jira", "Personal access tokens", "Agent writes", "APIs", "Activity log", "Backups"]);
    for (const href of ["/members", "/admin/invites", "/admin/teams", "/admin/sign-in-policy", "/admin/github", "/admin/personal-access-tokens", "/admin/apis", "/admin/activity-log"]) {
      expect(cards).toContain(`<a class="button secondary" href="${href}">`);
    }
    expect(cards).toMatch(/<h2>Backups<\/h2>\s*<p class="notice"><strong>No backup has finished yet\.<\/strong>/);
    expect(cards).toContain('<label for="daily-write-budget">The daily budget of agent writes, from 1 to 1,000,000</label>');
    expect(main).toContain('<a href="/admin" aria-current="page">Admin</a>');
    expect(controlProblems(main)).toEqual([]);
  });
});

describe("each admin page", () => {
  it("invites: the form's fields labelled, in a panel, and the invites that wait in another", async () => {
    const main = await open(createInvitesRoute(options()), "/admin/invites");
    expect(main).toContain('<a href="/admin/invites" aria-current="page">Invites</a>');
    expect(panelHeadings(main)).toEqual(["Invite a person", "Invites waiting to be accepted"]);
    expect(main).toContain('<label for="invite-login">GitHub username</label>');
    expect(main).toContain('<label for="invite-role">Role</label>');
    expect(controlProblems(main)).toEqual([]);
  });

  it("teams: a panel per team, with its people, its name and key, its intake settings and its mirror", async () => {
    const main = await open(createTeamsRoute(options()), "/admin/teams");
    expect(panelHeadings(main)).toEqual(["Create a team", "FE: Frontend", "PAY: PAY"]);
    const fe = element(main, /<section class="panel team-panel">\s*<h2>FE: Frontend<\/h2>/, "section");
    for (const part of ["People", "Name and key", "How FE wants requests filed", "Where FE&#39;s requests are mirrored"]) expect(fe).toContain(`<h3>${part}</h3>`);
    expect(fe).toMatch(/<li class="item">\s*<p><span class="initials" aria-hidden="true">AD<\/span>ada<\/p>[\s\S]*?<button type="submit" class="secondary">Remove ada from FE<\/button>/);
    expect(fe).toContain('<p class="inline-field"><label for="name-');
    expect(fe).toMatch(/<fieldset class="choices inline"><legend>The fields FE requires, besides the need<\/legend>\s*<label><input type="checkbox" name="requiredField" value="acceptance_criteria" checked> Acceptance criteria<\/label>/);
    expect(controlProblems(main)).toEqual([]);
  });

  it("sign-in policy: the policy in force, and the change as a link to its review page", async () => {
    const main = await open(createSignInPolicyRoute(options()), "/admin/sign-in-policy");
    expect(main).toContain('<span class="chip tag good">In force</span> The install&#39;s sign-in policy is organization members and invited people.');
    expect(main).toMatch(/<a class="button secondary" href="\/confirm\/settings\.set_sign_in_policy\?input=[^"]+">Change the policy to invited people only<\/a>/);
    expect(controlProblems(main)).toEqual([]);
  });

  it("personal access tokens: the switch as a link to its review page, and the lifetime's field labelled", async () => {
    const main = await open(createPersonalAccessTokenSettingsRoute(options()), "/admin/personal-access-tokens");
    expect(panelHeadings(main)).toEqual(["The switch", "The longest lifetime"]);
    expect(main).toMatch(/<a class="button secondary" href="\/confirm\/settings\.set_personal_access_tokens\?input=[^"]+">Switch personal access tokens off<\/a>/);
    expect(main).toContain('<label for="max-lifetime">The longest lifetime of a new personal access token, in days, from 1 to 90</label>');
    expect(controlProblems(main)).toEqual([]);
  });

  it("GitHub: its parts as panels, each installation an item with its action", async () => {
    const main = await open(createGitHubAdminRoute(options()), "/admin/github");
    expect(main).toContain('<a href="/admin/github" aria-current="page">GitHub</a>');
    expect(panelHeadings(main)).toEqual(["How GitHub's changes reach Tiehall", "Connected installations", "Installations not connected"]);
    expect(main).toMatch(/<ul class="items">\s*<li class="item">\s*<p>acme: the App&#39;s installation on the organization acme\./);
    expect(main).toContain('<button type="submit" class="secondary">Disconnect acme</button>');
    expect(controlProblems(main)).toEqual([]);
  });

  it("the activity log: its filters labelled in a panel, and the events in a table with column headers, in a box that scrolls on its own", async () => {
    const main = await open(createActivityLogRoute(options()), "/admin/activity-log");
    expect(main).toContain('<a href="/admin/activity-log" aria-current="page">Activity log</a>');
    const filters = element(main, /<div class="panel filters">/, "div");
    for (const [name, label] of [["from", "From"], ["to", "To"], ["actor", "Actor (user id)"], ["request", "Request"], ["type", "Event type"]]) {
      expect(filters).toContain(`<label for="filter-${name}">${label}</label>`);
      expect(filters).toContain(`<input id="filter-${name}" name="${name}" type="text"`);
    }
    expect(main).toMatch(/<div class="table-box">\s*<table class="log">\s*<thead><tr><th scope="col">#<\/th><th scope="col">Time<\/th>/);
    expect(main).toContain('<td><span class="chip tag">domain</span></td>');
    expect(main).toMatch(/<a class="button secondary" href="\/confirm\/activity_log\.export\?input=[^"]+">Export the whole log as JSONL<\/a>/);
    expect(controlProblems(main)).toEqual([]);
  });

  it("APIs: the registered APIs in a table with column headers, each with its forms, and the registration's fields labelled", async () => {
    const main = await open(createApisRoute(options()), "/admin/apis");
    expect(panelHeadings(main)).toEqual(["Registered APIs", "Register an API"]);
    expect(main).toMatch(/<div class="table-box">\s*<table>\s*<thead><tr><th scope="col">API<\/th><th scope="col">Provider team<\/th>/);
    expect(main).toContain('<td><span class="key">payments-api</span></td>');
    expect(main).toContain('<button type="submit" class="secondary">Unregister payments-api</button>');
    for (const [id, label] of [["api-name", "Name, such as payments-api"], ["api-team", "Provider team"], ["api-repository", "GitHub repository, as owner/name"], ["api-workflow", "Only this workflow may report"]]) {
      expect(main).toContain(`<label for="${id}">${label}`);
    }
    expect(controlProblems(main)).toEqual([]);
  });
});
