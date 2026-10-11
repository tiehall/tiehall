import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { EXAMPLE_AGENT, seedRequestPages, type RequestPagesSeed } from "./support/request-pages.ts";
import { callApi, oauthTokenOf, openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The request pages as the design draws them (web-ui: A request's state looks
// the same everywhere; web-ui: The request page shows who works on it and
// what happened; web-ui: Pages are accessible; design.md, Design: The page
// families; design.md, Design: The request page's activity; D57 (1), (8),
// (15)): a request's page, with its key in a mono tag, its state as a chip in
// words with its state's class, the needs_human chip, its due date, its two
// teams joined by their line, the banner of who wrote on it last, its timeline
// with a lamp per entry in the color of the state it left the request in, its
// packet, its thread with each message's author, team, actor kind and client,
// and its actions and commitments; the request lists, each row's state as a
// chip; the form that opens a request, with From and To, the target team's
// notes and required fields, each field's label saying whether it is
// required, and by whom, or optional, and a refused form that names each
// refused field beside it; and a team's intake page with its APIs and
// declarations. The pages are read as the web app serves them to Pia, an
// admin in FE.

/** What a browser sends, which names text/html. */
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let seed: RequestPagesSeed;
let pia: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  seed = await seedRequestPages(install, stub);
  web = await startWebApp(install);
  pia = (await (await startSignIn(install, stub, { url: web.url })).signIn("pia")).jar.header();
}, 300_000);

afterAll(async () => {
  await web?.close();
  await stub?.close();
  await install?.close();
}, 300_000);

/** A page as Pia's browser opens it. */
async function open(path: string): Promise<{ status: number; html: string }> {
  const answer = await web.fetch(path, { headers: { cookie: pia, accept: BROWSER } });
  return { status: answer.status, html: await answer.text() };
}

/** The markup of one element of a page, by its opening tag, up to its own end tag. */
function element(html: string, opening: RegExp, tag: string): string {
  const start = html.search(opening);
  if (start < 0) return "";
  let depth = 0;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  pattern.lastIndex = start;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, pattern.lastIndex);
  }
  return html.slice(start);
}

/** Text as a page shows it: its markup and entities taken out, its white space collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;|&#38;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("a request's page", () => {
  it("shows the key in a mono tag, the state as a chip in words, the due date and the title as the heading", async () => {
    const { status, html } = await open("/FE-1");
    expect(status).toBe(200);
    const head = element(html, /<header class="request-head">/, "header");
    expect(head).toContain('<span class="request-key">FE-1</span>');
    expect(head).toContain('<span class="chip in-progress">In progress</span>');
    expect(head).toContain('<span class="chip due">Due Nov 2, 2026</span>');
    expect(head).toContain('<h1>Add a &quot;Forgot password&quot; link to the sign-in page</h1>');
    expect(head).not.toContain("chip waits");
  });

  it("shows a second chip on a request that waits for a person", async () => {
    const head = element((await open("/FE-2")).html, /<header class="request-head">/, "header");
    expect(head).toContain('<span class="chip open">Open</span>');
    expect(head).toContain('<span class="chip waits">Waits for a person</span>');
  });

  it("joins the two teams' keys by their line, which flows while work is under way, and says who opened it and who holds its claim", async () => {
    const teams = element((await open("/FE-1")).html, /<div class="request-teams">/, "div");
    expect(teams).toMatch(/<span class="key">BE<\/span><span class="team-name">Backend<\/span>[\s\S]*<svg class="team-line"[^>]*aria-hidden="true"[\s\S]*<path class="line-flow"[\s\S]*<span class="key">FE<\/span><span class="team-name">Frontend<\/span>/);
    expect(textOf(teams)).toContain("From team BE to team FE:");
    expect(textOf(teams)).toMatch(/Opened by alice for team BE, (\d+ s ago|just now|\d+ min ago) · claimed by mert/);
    expect(element((await open("/FE-2")).html, /<div class="request-teams">/, "div")).not.toContain("line-flow");
  });

  it("says in its banner that the agent at work is working on it, with the client, and when it last wrote", async () => {
    const banner = element((await open("/FE-1")).html, /<div class="activity at-work">/, "div");
    expect(textOf(banner)).toMatch(/^ME mert's agent is working on FE-1 · Example Agent \(client\.example\.com\) Last write 4\d s ago$/);
    // The client's name, its own claim, is isolated in a bdi, apart from the host Tiehall verified, so no character of it can reorder the host.
    expect(banner).toContain('<bdi class="client-name">Example Agent</bdi> <span class="client-mark">(client.example.com)</span>');
    expect(banner).toMatch(/<span class="typing" aria-hidden="true">/);
    expect(banner).toMatch(/<time dateTime="\d{4}-\d\d-\d\dT[\d:.]+Z">4\d s ago<\/time>/);
    const flagged = element((await open("/FE-2")).html, /<div class="activity">/, "div");
    expect(textOf(flagged)).toMatch(/^PI Last write by pia's agent · personal access token Last write (just now|\d+ s ago)$/);
  });

  it("lists the timeline newest first, each entry with a lamp in the color of the state it left the request in, that state in words, who and when", async () => {
    const timeline = element((await open("/FE-1")).html, /<ol class="timeline">/, "ol");
    const entries = [...timeline.matchAll(/<li class="event ([a-z-]+)"><span class="lamp ([a-z-]+)" aria-hidden="true"><\/span><div><p class="event-what">([^<]+)<\/p><p class="event-who"><span class="event-state">([^<]+)<\/span> · ([^<]+) · <time/g)].map(
      ([, entry = "", lamp = "", what = "", state = "", who = ""]) => [entry, lamp, what.replace(/&#x27;/g, "'"), state, who.replace(/&#x27;/g, "'")],
    );
    expect(entries).toEqual([
      ["in-progress", "in-progress", "Work on it started", "In progress", "mert's agent"],
      ["claimed", "claimed", "It moved from needs info to claimed", "Claimed", "alice"],
      ["needs-info", "needs-info", "An answer was posted", "Needs info", "alice"],
      ["needs-info", "needs-info", "It moved from claimed to needs info", "Needs info", "mert's agent"],
      ["claimed", "claimed", "A blocking question was posted", "Claimed", "mert's agent"],
      ["claimed", "claimed", "It was claimed", "Claimed", "mert's agent"],
      ["open", "open", "It was opened", "Open", "alice's agent"],
    ]);
  });

  it("shows the packet: its revision, need, acceptance criteria, code refs and links", async () => {
    const packet = element((await open("/FE-1")).html, /<section aria-labelledby="packet"/, "section");
    expect(packet).toContain('<p class="packet-meta">Revision 1, due 2026-11-02.</p>');
    expect(packet).toContain("Add the link under the sign-in form.");
    expect(packet).toMatch(/<ul class="criteria"><li><span>The link shows under the sign-in form<\/span><\/li><li><span>It opens \/password-reset<\/span><\/li><\/ul>/);
    expect(packet).toContain("<code>acme/web src/pages/login main</code>");
    expect(packet).toContain('<a href="https://design.example.com/login" rel="noopener noreferrer nofollow">Sign-in design</a>');
  });

  it("shows each message of the thread with its author, team, actor kind and client, when, and what it is", async () => {
    const thread = element((await open("/FE-1")).html, /<section aria-labelledby="thread"/, "section");
    const metas = [...thread.matchAll(/<p class="message-meta">([\s\S]*?)<\/p>/g)].map(([, meta = ""]) => textOf(meta));
    expect(metas).toEqual([
      expect.stringMatching(/^mert's agent · team FE · agent · Example Agent \(client\.example\.com\) · (\d+ s ago|just now) Blocking question · answered$/),
      expect.stringMatching(/^alice · team BE · web · (\d+ s ago|just now) Answer$/),
    ]);
    expect(thread).toContain('agent · <bdi class="client-name">Example Agent</bdi> <span class="client-mark">(client.example.com)</span>');
    expect(thread).toContain('<span class="chip kind answered">Blocking question · answered</span>');
    expect(thread).toMatch(/<article id="message-[0-9a-f-]+" class="message blocking answered"><span class="initials agent" aria-hidden="true">ME<\/span>/);
    expect(thread).toContain("Should the link text be English or Turkish?");
    expect(element((await open("/FE-1")).html, /<section aria-labelledby="post"/, "section")).toMatch(/<label for="body">Message<\/label>/);
  });

  it("offers the actions and the commitments as forms, and links each pending proposal to its confirm page", async () => {
    const one = (await open("/FE-1")).html;
    const actions = element(one, /<section aria-labelledby="actions"/, "section");
    expect(actions).toMatch(/<form[^>]*class="stack"[\s\S]*<button type="submit" class="secondary">Release the claim<\/button>/);
    const commitments = element(one, /<section aria-labelledby="commitments"/, "section");
    for (const button of ["Mark done", "Decline", "Reassign", "Propose the due date", "Propose removing the due date"]) expect(commitments).toContain(`>${button}</button>`);
    // A move of the request's state is a strong secondary action, navy; posting to the thread, where a blocking
    // question is answered, is the page's gold main action (D59 (2)).
    expect(commitments).toContain('<button type="submit" class="strong">Mark done</button>');
    expect(element(one, /<section aria-labelledby="post"/, "section")).toContain('<button type="submit">Post</button>');
    expect(commitments).toContain('<label for="team">Team to reassign it to</label>');
    const proposals = element((await open("/FE-2")).html, /<section aria-labelledby="proposals"/, "section");
    expect(textOf(proposals)).toMatch(/A decline, pending, proposed by pia (\d+ s ago|just now) ?\./);
    // Every time in the panel is how long ago or how long until, in a time element, never a raw ISO 8601 date.
    expect(textOf(proposals)).toMatch(/It expires in \d+ days ?\./);
    expect(proposals).toMatch(/<time dateTime="\d{4}-\d\d-\d\dT[\d:.]+Z">in \d+ days<\/time>/);
    expect(textOf(proposals)).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
    expect(proposals).toContain(`<a class="button" href="/confirm/${seed.decline}">Review it, then confirm or reject it</a>`);
  });
});

describe("a request's page and its times", () => {
  it("says every time as how long ago or until, or as a date and time in UTC, never as a raw ISO 8601 date", async () => {
    for (const path of ["/FE-1", "/FE-2"]) {
      const { html } = await open(path);
      const main = element(html, /<main\b/, "main");
      // FE-1's thread holds a question, which the answer's picker names by who asked it and when.
      if (path === "/FE-1") expect(main).toMatch(/<option value="[0-9a-f-]+">[a-z]+, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d\d:\d\d UTC: /);
      expect(textOf(main), path).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
    }
  });
});

describe("the request lists", () => {
  it("show each row's state as a chip in words, with the needs_human chip, each cell named for a card", async () => {
    const { status, html } = await open("/requests?list=all");
    expect(status).toBe(200);
    const rows = [...html.matchAll(/<tr>\s*<td class="cell-key"><a class="key" href="\/(FE-\d)">[\s\S]*?<\/tr>/g)];
    expect(rows.map(([, key]) => key)).toEqual(["FE-2", "FE-1"]);
    const [two = "", one = ""] = rows.map(([row]) => row);
    expect(one).toContain('<td class="cell-state" data-label="State"><span class="chip in-progress">In progress</span></td>');
    expect(two).toContain('<td class="cell-state" data-label="State"><span class="chip open">Open</span> <span class="chip waits">Waits for a person</span></td>');
    for (const label of ["Title", "From", "To", "Claimed by", "Opened"]) expect(one).toContain(`data-label="${label}"`);
    expect(html).toContain('<table class="requests stacked">');
    expect(html).toMatch(/<th scope="col">State<\/th>/);
  });
});

describe("the form that opens a request", () => {
  it("joins From and To by their line, and labels every field with whether it is required or optional", async () => {
    const { html } = await open("/requests/new");
    expect(html).toMatch(/<label for="requestingTeam">From team<\/label>[\s\S]*<svg class="team-line from-to-line"[^>]*aria-hidden="true"[\s\S]*<label for="targetTeam">To team<\/label>/);
    expect(html).toContain('<option value="FE">FE · Frontend</option>');
    expect(html).toContain('<label for="title">Title <span class="need">· required</span></label>');
    expect(html).toContain('<label for="need">What you need <span class="need">· required</span></label>');
    for (const [id, label] of [["acceptanceCriteria", "Acceptance criteria"], ["codeRefs", "Code refs"], ["links", "Links"], ["dueDate", "Due date"]]) {
      expect(html).toContain(`<label for="${id}">${label} <span class="need">· optional</span></label>`);
    }
    // Every field's hint is tied to its control.
    expect(html).toMatch(/<input type="text" id="title" name="title" maxlength="200" required aria-describedby="title-hint"/);
    expect(html).toContain('<p class="hint" id="title-hint">One line the other team sees in their list.</p>');
    expect(html).toMatch(/<textarea id="acceptanceCriteria" name="acceptanceCriteria" aria-describedby="acceptanceCriteria-hint"/);
    expect(textOf(html)).toContain("FE requires the acceptance criteria.");
  });

  it("shows the target team's notes and marks the fields it requires as required by it, when the form names the team", async () => {
    const { html } = await open("/requests/new?team=FE");
    const notice = element(html, /<div class="intake-notice" id="intake">/, "div");
    expect(notice).toContain("<h2>How FE wants requests filed</h2>");
    expect(notice).toContain('<p class="notes">Link the design file, and say which screens change.</p>');
    expect(notice).toContain("<p>FE requires the acceptance criteria.</p>");
    expect(html).toContain('<option value="FE" selected>FE · Frontend</option>');
    expect(html).toContain('<label for="acceptanceCriteria">Acceptance criteria <span class="need">· required by FE</span></label>');
    expect(html).toMatch(/<textarea id="acceptanceCriteria" name="acceptanceCriteria" required aria-describedby="acceptanceCriteria-hint"/);
    expect(html).toContain('<label for="codeRefs">Code refs <span class="need">· optional</span></label>');
  });

  it("comes back refused with what was typed, the refusal at its top and the missing field named beside it", async () => {
    const form = await open("/requests/new?team=FE");
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.html)?.[1] ?? "";
    const answer = await web.fetch("/requests/new", {
      method: "POST",
      headers: { cookie: pia, accept: BROWSER, "content-type": "application/x-www-form-urlencoded", origin: web.url, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ csrf, requestingTeam: "FE", targetTeam: "FE", title: "Fix the footer", need: "The footer overlaps the content.", acceptanceCriteria: "" }).toString(),
    });
    expect(answer.status).toBe(400);
    const html = await answer.text();
    expect(textOf(element(html, /<div role="alert">/, "div"))).toContain("The request was not opened. Team FE requires the acceptance criteria");
    expect(html).toMatch(/<textarea id="acceptanceCriteria" name="acceptanceCriteria" required aria-describedby="acceptanceCriteria-hint acceptanceCriteria-error" aria-invalid="true" rows="3"><\/textarea>/);
    expect(html).toContain('<p class="field-error" id="acceptanceCriteria-error">Team FE requires the acceptance criteria.</p>');
    expect(html).toContain('value="Fix the footer"');
    expect(html).toContain(">The footer overlaps the content.</textarea>");
    expect((await install.owner.query("SELECT count(*)::int AS n FROM requests WHERE title = 'Fix the footer'")).rows).toEqual([{ n: 0 }]);
  });
});

describe("a team's intake page", () => {
  it("shows the team's key and name, its notes, its required fields, a link to the form, and the APIs with its declarations", async () => {
    const { status, html } = await open("/FE");
    expect(status).toBe(200);
    expect(html).toContain("<h1>FE: Frontend</h1>");
    expect(html).toContain('<a class="button" href="/requests/new?team=FE">Open a request to FE</a>');
    expect(element(html, /<section aria-labelledby="notes"/, "section")).toContain('<p class="notes">Link the design file, and say which screens change.</p>');
    expect(textOf(element(html, /<section aria-labelledby="required"/, "section"))).toContain("Team FE requires the acceptance criteria of the requests opened to it.");
    const apis = element(html, /<section aria-labelledby="apis"/, "section");
    expect(apis).toMatch(/<li class="api-card declared"><p class="api-name"><span class="key">payments-api<\/span><span class="chip tag good">Consumed<\/span><\/p>/);
    expect(textOf(apis)).toMatch(/payments-api, provided by PAY: FE consumes it, as pia declared on \d{4}-\d\d-\d\d; last confirmed on \d{4}-\d\d-\d\d\./);
    expect(apis).toContain(">Re-confirm that FE consumes payments-api</button>");
  });
});

// Last in this file, because it opens FE-3, which the lists above do not count.
describe("a blocking question in the thread", () => {
  it("is marked waiting, which the stylesheet fills in the notice colors, until it is answered, and answered after", async () => {
    // FE-1's blocking question was answered: it keeps its kind, and gives up the fill that asks for a person.
    expect(element((await open("/FE-1")).html, /<section aria-labelledby="thread"/, "section")).toMatch(/<article id="message-[0-9a-f-]+" class="message blocking answered">/);
    // FE-3: Mert's agent claims it and asks a blocking question that nobody has answered yet.
    await openRequest(install, tokenOf(seed.alice), {
      targetTeam: "FE",
      title: "Fix the footer",
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Fix the footer's links.", acceptance_criteria: ["Every footer link opens its page"] } },
    });
    const agent = oauthTokenOf(seed.mert, EXAMPLE_AGENT, "mcp");
    expect((await callApi(install, agent, "POST", "/api/v1/requests/FE-3/claim")).status).toBe(200);
    expect((await callApi(install, agent, "POST", "/api/v1/requests/FE-3/messages", { kind: "question", body: "Which footer, the site's or the app's?", blocking: true })).status).toBe(200);
    const thread = element((await open("/FE-3")).html, /<section aria-labelledby="thread"/, "section");
    expect(thread).toMatch(/<article id="message-[0-9a-f-]+" class="message blocking"><span class="initials agent" aria-hidden="true">ME<\/span>/);
    expect(thread).toContain('<span class="chip kind">Blocking question · not answered yet</span>');
  });
});
