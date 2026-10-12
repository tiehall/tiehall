import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetUrl } from "../src/asset-urls.ts";
import { createHallRoute, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { element, mainOf } from "./support/markup.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// The live hall's page as it is served (web-ui: The live hall; web-ui: Light
// and dark themes follow the system; web-ui: Motion, and reduced motion;
// web-ui: The content security policy of each kind of page; web-ui: Pages
// are accessible; agent-safety: The web UI renders no raw HTML and no remote
// images; design.md, Design: The live hall; D57 (5), (6), (9), (11), (13)).
// /hall renders, in the app shell with Live hall marked as the current page
// and in the dark theme whatever the system prefers, the toolbar: the heading,
// the live lamp, which says that the page updates only with scripts on until
// its script runs, the Team and Agents only filters in a form that a GET
// submits, Pause motion, hidden until the script shows it, and the link that
// opens a request; then, from hall.state, the people and agents at work, the
// feed "On the line", the teams with their lamps and counts in words, and the
// lines between teams with the requests on them, every title, name, login and
// client name as text. It is sent with the live hall's policy, and a browser
// without a session is sent to sign in and brought back.

/** The live hall's policy, as design.md's table gives it: a page of the web role's, which runs its one script from the install. */
const HALL_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const EXAMPLE_AGENT = "https://client.example.com/tiehall.json";
/** The characters that hide or reverse text, as the agent view strips them: a name holding U+202E would reverse the mark beside it. */
const HIDDEN_OR_REVERSING = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
const MARKUP_CLIENT = randomUUID();

let install: TestInstall;
let ada: WebSessionCaller;
const person: Record<string, string> = {};

beforeAll(async () => {
  install = await startTestInstall();
  const team: Record<string, string> = {};
  for (const [key, name] of [
    ["BE", "Backend"],
    ["FE", "Frontend"],
    // The characters that hide or reverse text, which the hall drops from every name and title it shows.
    ["OPS", "\u2067Operations\u200B"],
    ["PAY", "Payments & <Billing>"],
  ] as const) {
    team[key] = await addTeam(install.owner, key);
    await install.owner.query("UPDATE teams SET name = $2 WHERE id = $1", [team[key], name]);
  }
  for (const [login, teamKey, role] of [
    ["ada", "FE", "admin"],
    ["mert", "FE", "member"],
    ["selin", "BE", "member"],
    ["ayse", "PAY", "member"],
  ] as const) {
    person[login] = await addUser(install.owner, { login, role });
    await joinTeams(install.owner, person[login] ?? "", team[teamKey] ?? "");
  }
  ada = sessionOf(person["ada"] ?? "");
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, '\u202AExample Agent\u202C', 'cimd', ARRAY['https://client.example.com/callback'] FROM orgs",
    [EXAMPLE_AGENT],
  );
  await install.owner.query("INSERT INTO oauth_clients (org_id, client_id, name, redirect_uris) SELECT id, $1, '<img src=x onerror=alert(1)>', ARRAY['http://127.0.0.1/callback'] FROM orgs", [MARKUP_CLIENT]);
  // FE-1, from BE, on which Mert's agent works; PAY-1, from FE, on which Ayşe's agent asked a blocking question; FE-2, from BE, open, whose title is markup.
  await openRequest(install, tokenOf(person["selin"] ?? ""), { targetTeam: "FE", title: "Add a forgot\u202E password link" });
  const mertsAgent = oauthTokenOf(person["mert"] ?? "", EXAMPLE_AGENT, "mcp");
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/status", { state: "in_progress" })).status).toBe(200);
  // Ada comments on FE-1 in the web UI.
  expect(await install.web(ada).write("messages.post", { key: "FE-1", kind: "comment", body: "Looks good." }, install.fromThePage(ada))).toMatchObject({ ok: true });
  await openRequest(install, tokenOf(person["mert"] ?? ""), { targetTeam: "PAY", title: "Send a refund webhook" });
  const aysesAgent = oauthTokenOf(person["ayse"] ?? "", MARKUP_CLIENT, "mcp");
  expect((await callApi(install, aysesAgent, "POST", "/api/v1/requests/PAY-1/claim")).status).toBe(200);
  expect((await callApi(install, aysesAgent, "POST", "/api/v1/requests/PAY-1/messages", { kind: "question", body: "Which currency?", blocking: true })).status).toBe(200);
  await openRequest(install, tokenOf(person["selin"] ?? ""), { targetTeam: "FE", title: "<script>alert(2)</script>" });
  await install.owner.query("UPDATE requests SET needs_human = true WHERE number = 2 AND target_team_id = $1", [team["FE"]]);
}, 120_000);

afterAll(async () => {
  await install?.close();
});

/** The route, for this signed-in member, or for a browser signed in as nobody when given null. */
const route = (session: WebSessionCaller | null = ada) =>
  createHallRoute({ execute: install.execute, session: async () => session ?? undefined, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

/** The live hall as this browser opens it at this path: its answer and its markup. */
async function open(path = "/hall", session?: WebSessionCaller): Promise<{ answer: Response; html: string }> {
  const answer = await route(session)(new Request(`${URL_OF_INSTALL}${path}`, { headers: { accept: "text/html" } }));
  return { answer, html: await answer.text() };
}

/** An element's text, its tags dropped, its white space folded and the apostrophes the page escapes read back. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#39;/g, "'").trim();
}

/** A section of the page by the id of its heading. */
function section(html: string, headingId: string): string {
  return element(html, new RegExp(`<section[^>]*aria-labelledby="${headingId}"`), "section");
}

describe("the live hall's page", () => {
  it("is served in the app shell, with Live hall as the current page, and the live hall's policy", async () => {
    const { answer, html } = await open();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toBe(HALL_POLICY);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('<a href="/hall" aria-current="page">Live hall</a>');
    expect(html).toMatch(/<a class="skip" href="#content">Skip to content<\/a>/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<style\b|\sstyle=/i);
  });

  it("loads its one script, a module from the install, named by its digest, and no other", async () => {
    const { html } = await open();
    expect(html.match(/<script\b[^>]*>/g)).toEqual([`<script type="module" src="${assetUrl("/assets/hall.js")}">`]);
    expect(html).toContain(`<script type="module" src="${assetUrl("/assets/hall.js")}"></script>`);
  });

  it("is dark whatever the system prefers: its body carries the class hall, and its head names the dark scheme and theme color alone", async () => {
    const { html } = await open();
    expect(html).toContain('<body class="hall">');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html.match(/<meta name="theme-color"[^>]*>/g)).toEqual(['<meta name="theme-color" content="#071026">']);
    expect(html).not.toContain('content="light dark"');
  });

  it("has the toolbar: the heading, the live lamp's words, the filters in a GET form, Pause motion hidden until the script runs, and the link that opens a request", async () => {
    const main = mainOf((await open()).html);
    expect(main).toMatch(/<h1>Live hall<\/h1>/);
    expect(main).toMatch(/<p class="live-state off" id="live-state"><span class="live-lamp" aria-hidden="true"><\/span><span id="live-words">Not live: updates need JavaScript<\/span><\/p>/);
    // The lamp's place keeps, unseen and unread, a copy of the lamp with the words it says before the script runs, the
    // widest it says as the page comes alive, which holds the title as wide from the first frame on.
    const place = element(main, /<div class="live-place">/, "div");
    expect(place).toMatch(/^<div class="live-place">\s*<p class="live-state off" id="live-state">/);
    expect(place).toMatch(
      /<\/p>\s*<p class="live-state live-reserve" aria-hidden="true"><span class="live-lamp"><\/span><span>Not live: updates need JavaScript<\/span><\/p>\s*<\/div>$/,
    );
    const form = element(main, /<form class="hall-filter"/, "form");
    expect(form).toMatch(/^<form class="hall-filter" method="get" action="\/hall">/);
    expect(form).toContain('<label for="hall-team">Team</label>');
    expect(form).toMatch(/<select id="hall-team" name="team"><option value="" selected>All teams<\/option><option value="BE">BE · Backend<\/option><option value="FE">FE · Frontend<\/option><option value="OPS">OPS · Operations<\/option><option value="PAY">PAY · Payments &#38; &#60;Billing&#62;<\/option><\/select>/);
    expect(form).toContain('<input type="checkbox" id="hall-agents" name="agents" value="1">');
    expect(form).toContain('<label for="hall-agents">Agents only</label>');
    expect(form).toContain('<button type="submit" class="secondary">Show</button>');
    expect(main).toContain('<button type="button" class="secondary" id="pause-motion" aria-pressed="false" hidden>Pause motion</button>');
    // An outline: the top bar's gold New request leads to the same form, and gold marks a page's one main action.
    expect(main).toContain('<a class="button secondary" href="/requests/new">Open a request</a>');
  });

  it("lists the people and agents at work, with the login, the client, the request's key and title, what they did last and when", async () => {
    const atWork = section((await open()).html, "at-work-heading");
    expect(atWork).toContain('<h2 id="at-work-heading">At work</h2>');
    const rows = [...atWork.matchAll(/<li class="worker[^"]*">([\s\S]*?)<\/li>/g)].map(([, row = ""]) => textOf(row));
    expect(rows).toEqual([
      expect.stringMatching(/^SE selin's agent · personal access token FE-2 &#60;script&#62;alert\(2\)&#60;\/script&#62; It was opened · (now|\d+ s)$/),
      expect.stringMatching(/^AY ayse's agent · &#60;img src=x onerror=alert\(1\)&#62; \(unverified\) PAY-1 Send a refund webhook A blocking question was posted · (now|\d+ s)$/),
      expect.stringMatching(/^ME mert's agent · personal access token PAY-1 Send a refund webhook It was opened · (now|\d+ s)$/),
      expect.stringMatching(/^AD ada in the web UI FE-1 Add a forgot password link A comment was posted · (now|\d+ s)$/),
      expect.stringMatching(/^ME mert's agent · Example Agent \(client\.example\.com\) FE-1 Add a forgot password link Work on it started · (now|\d+ s)$/),
    ]);
    // Ayşe's agent asked the blocking question and waits on an answer; Mert's agent, which opened PAY-1, does not.
    expect(atWork.match(/<li class="worker[^"]*">/g)).toEqual(['<li class="worker agent">', '<li class="worker agent waiting">', '<li class="worker agent">', '<li class="worker web">', '<li class="worker agent">']);
    expect(atWork).toMatch(/<span class="initials" aria-hidden="true">AY<\/span>/);
  });

  it("lists the feed, On the line: the latest events, newest first, with the key, how long ago, what happened, who and the title, the newest row of a request that waits in the notice colors", async () => {
    const feed = section((await open()).html, "feed-heading");
    expect(feed).toContain('<h2 id="feed-heading" class="label">On the line</h2>');
    expect(feed).toContain('<ol class="feed" id="feed">');
    const rows = [...feed.matchAll(/<li class="feed-row( waits)?">([\s\S]*?)<\/li>/g)].map(([, waits, row = ""]) => [waits === undefined ? "" : "waits", textOf(row)]);
    expect(rows[0]).toEqual(["waits", expect.stringMatching(/^FE-2 &#60;script&#62;alert\(2\)&#60;\/script&#62; (now|\d+ s) It was opened selin's agent · personal access token$/)]);
    // Only the newest row of a request that waits is in the notice colors, so the feed does not turn gold: FE-2's one
    // row, and of PAY-1's rows the newest, about its blocking question, not the ones before it.
    expect(rows.filter(([waits]) => waits === "waits").map(([, row]) => row?.split(" ")[0])).toEqual(["FE-2", "PAY-1"]);
    const pay = rows.filter(([, row]) => row?.startsWith("PAY-1 "));
    expect(pay.length).toBeGreaterThan(1);
    expect(pay[0]).toEqual(["waits", expect.stringMatching(/A blocking question was posted|needs info/i)]);
    for (const [waits] of pay.slice(1)) expect(waits).toBe("");
    expect(rows.at(-1)).toEqual(["", expect.stringMatching(/^FE-1 Add a forgot password link (now|\d+ s) It was opened selin's agent · personal access token$/)]);
    expect(feed).toMatch(/<a class="key" href="\/FE-2">FE-2<\/a> <bdi class="feed-title">&#60;script&#62;alert\(2\)&#60;\/script&#62;<\/bdi> <time datetime="[0-9T:.Z-]+">/);
    expect(feed).not.toMatch(/class="lamp/);
  });

  it("lists every team with a lamp per live state and the counts in words, a team with nothing live dimmed, and one with a question waiting asking", async () => {
    const teams = section((await open()).html, "teams-heading");
    const rows = [...teams.matchAll(/<li class="(team-row[^"]*)">([\s\S]*?)<\/li>/g)].map(([, classes, row = ""]) => [classes, textOf(row), [...row.matchAll(/class="lamp ([a-z-]+)"/g)].map(([, lamp]) => lamp)]);
    expect(rows).toEqual([
      ["team-row dimmed", "Backend BE Nothing live", []],
      ["team-row", "Frontend FE 1 open · 1 in progress", ["open", "in-progress"]],
      ["team-row dimmed", "Operations OPS Nothing live", []],
      ["team-row asking", "Payments &#38; &#60;Billing&#62; PAY 1 needs info", ["needs-info"]],
    ]);
  });

  it("lists the lines between teams with their counts, and the requests on them with key, title, state chip, claimant and the chip of a request that waits for a person", async () => {
    const lines = section((await open()).html, "lines-heading");
    expect(lines).toContain('<h2 id="lines-heading">Lines between teams</h2>');
    const pairs = [...element(lines, /<table class="hall-lines">/, "table").matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map(([, row = ""]) => textOf(row));
    expect(pairs).toEqual(["BE FE 1 open · 1 in progress", "FE PAY 1 needs info"]);
    const requests = element(lines, /<table class="requests stacked">/, "table");
    expect(requests).toContain('<a class="key" href="/PAY-1">PAY-1</a>');
    expect(requests).toContain('<span class="chip needs-info">Needs info</span>');
    expect(requests).toContain('<span class="chip open">Open</span> <span class="chip waits">Waits for a person</span>');
    expect(requests).toContain("&#60;script&#62;alert(2)&#60;/script&#62;");
    expect(requests).toMatch(/<td data-label="Claimed by">mert<\/td>/);
  });

  it("isolates every client name, title and team name in a bdi, keeps Tiehall's mark apart from a client's name, and drops the characters that hide or reverse text", async () => {
    const { html } = await open();
    expect(html).not.toMatch(HIDDEN_OR_REVERSING);
    const atWork = section(html, "at-work-heading");
    expect(atWork).toContain('<p class="worker-who">ayse&#39;s agent · <bdi class="client-name">&#60;img src=x onerror=alert(1)&#62;</bdi> <span class="client-mark">(unverified)</span></p>');
    expect(atWork).toContain('<p class="worker-who">mert&#39;s agent · <bdi class="client-name">Example Agent</bdi> <span class="client-mark">(client.example.com)</span></p>');
    expect(atWork).toContain('<p class="worker-who">selin&#39;s agent · <bdi class="client-name">personal access token</bdi></p>');
    expect(atWork).toContain('<p class="worker-on"><span class="mono">FE-1</span> <bdi>Add a forgot password link</bdi></p>');
    expect(section(html, "feed-heading")).toContain('<bdi class="feed-title">Add a forgot password link</bdi>');
    expect(section(html, "teams-heading")).toContain('<bdi class="team-name">Operations</bdi> <span class="team-key">OPS</span>');
    expect(JSON.stringify(await install.execute("hall.state", ada, {}, { readOnly: true }))).not.toMatch(HIDDEN_OR_REVERSING);
  });

  it("shows every title, name, login and client name as text, never as markup", async () => {
    const { html } = await open();
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<Billing>");
    expect(html).not.toMatch(/<script\b[^>]*>[^<]/);
  });

  it("narrows to one team and to what agents did, as its address says, with the filters showing it", async () => {
    const pay = await open("/hall?team=PAY");
    expect(element(mainOf(pay.html), /<select id="hall-team"/, "select")).toContain('<option value="PAY" selected>');
    expect([...element(pay.html, /<table class="hall-lines">/, "table").matchAll(/<tr>/g)]).toHaveLength(2);
    expect(section(pay.html, "at-work-heading")).not.toContain("FE-1");
    const agents = await open("/hall?agents=1");
    expect(mainOf(agents.html)).toContain('<input type="checkbox" id="hall-agents" name="agents" value="1" checked>');
    expect(section((await open()).html, "feed-heading")).toContain("ada in the web UI");
    expect(section(agents.html, "feed-heading")).not.toContain("ada in the web UI");
    expect(section(agents.html, "at-work-heading")).not.toContain("ada in the web UI");
  });

  it("says when nobody is at work and nothing is on the line", async () => {
    const ops = await open("/hall?team=OPS");
    expect(section(ops.html, "at-work-heading")).toContain('<p class="empty" id="at-work-empty">Nobody is at work on these requests now.</p>');
    expect(section(ops.html, "feed-heading")).toContain('<p class="empty" id="feed-empty">Nothing has happened on these lines yet.</p>');
    expect(section(ops.html, "lines-heading")).toContain('<p class="empty" id="lines-empty">No request runs between these teams now.</p>');
  });

  it("refuses a team that does not exist with 404, as a page that leads back to the live hall", async () => {
    const { answer, html } = await open("/hall?team=NOPE");
    expect(answer.status).toBe(404);
    expect(html).toContain('href="/hall"');
  });

  it("sends a browser without a session to sign in and back", async () => {
    const answer = await route(null)(new Request(`${URL_OF_INSTALL}/hall?team=FE`, { headers: { accept: "text/html" } }));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/sign-in?return=%2Fhall");
  });
});
