import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The web UI's page of a request, at its URL (agent-surfaces: Negotiated
// request URLs; agent-safety: The needs_human flag is visible and reaches the
// people on the request; requests: Every member sees every request; requests:
// What a proposal records and shows; design.md, Technical decisions: T3). It
// is a server component of the running web app, which reads the request, its
// packet and its proposals through execute() in the app's own process, as the
// signed-in member's web session, and shows the request's state, its teams
// and its claimant, its packet, its thread, oldest message first, and its
// proposals, newest first, each pending one with a link to its confirm page;
// a request agents flagged needs_human shows that it waits for a person. The
// tests seed requests through /api/v1, as agents write them, and read the
// page as Carol, a member of a third team, in the web app as the image runs
// it (web-app.ts).

/** What a browser sends, which names text/html. */
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const TITLE = "Add a dark mode to the settings page";

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
/** Carol's browser, signed in to the web app. */
let carol: string;
let alice: string;
let bob: string;
/** The decline Bob proposed on FE-1, which waits for its confirmation. */
let decline: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const qa = await addTeam(install.owner, "QA");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  const account = stub.addUser({ login: "carol" });
  const carolId = await addUser(install.owner, { login: "carol", githubAccountId: account.id });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, carolId, qa);

  // FE-1: a full packet, claimed by Bob, a blocking question and its answer, and a decline waiting for its confirmation.
  await openRequest(install, tokenOf(alice), {
    targetTeam: "FE",
    title: TITLE,
    packet: {
      schema_version: "1-beta",
      kind: "request",
      due_date: "2026-11-02",
      untrusted: {
        need: "The settings page should follow the system's dark mode.",
        acceptance_criteria: ["It follows the system setting.", "A toggle overrides it."],
        code_refs: [{ repository: "acme/web", path: "src/settings", ref: "main" }],
        links: [{ url: "https://design.example.com/dark", title: "Dark mode spec" }],
      },
    },
  });
  expect((await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  const question = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-1/messages", { kind: "question", body: "Which browsers must it support?", blocking: true });
  expect(question.status).toBe(200);
  const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests/FE-1/messages", { kind: "answer", body: "The last two versions of each.", questionId: question.body.message.id });
  expect(answer.status).toBe(200);
  const declined = await callApi(install, tokenOf(bob), "POST", "/api/v1/requests/FE-1/status", { state: "declined" });
  expect(declined.status).toBe(202);
  decline = declined.body.proposal.id;

  // FE-2, which agents flagged needs_human.
  await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Move the banner" });
  await install.owner.query("UPDATE requests SET needs_human = true WHERE number = 2");

  web = await startWebApp(install);
  const signIn = await startSignIn(install, stub, { url: web.url });
  carol = (await signIn.signIn("carol")).jar.header();
}, 300_000);

afterAll(async () => {
  await web?.close();
  await stub?.close();
  await install?.close();
});

/** The request's page, as Carol's browser opens it. */
async function open(key: string): Promise<{ status: number; html: string; etag: string | null }> {
  const answer = await web.fetch(`/${key}`, { headers: { cookie: carol, accept: BROWSER } });
  return { status: answer.status, html: await answer.text(), etag: answer.headers.get("etag") };
}

/** The HTML's text, with its markup and entities taken out and its white space collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the web UI's page of a request", () => {
  it("shows the request's key and title, its state, its teams and its claimant", async () => {
    const { status, html } = await open("FE-1");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1>FE-1: Add a dark mode to the settings page<\/h1>/);
    const text = textOf(html);
    expect(text).toContain("FE-1 is claimed, addressed to team FE.");
    expect(text).toContain("Requested by alice for team BE");
    expect(text).toContain("Claimed by bob.");
  });

  it("shows the packet: its revision, due date, need, acceptance criteria, code refs and links", async () => {
    const text = textOf((await open("FE-1")).html);
    expect(text).toContain("Packet");
    expect(text).toContain("Revision 1, due 2026-11-02.");
    expect(text).toContain("The settings page should follow the system's dark mode.");
    expect(text).toContain("It follows the system setting.");
    expect(text).toContain("A toggle overrides it.");
    expect(text).toContain("acme/web src/settings main");
    expect(text).toContain("Dark mode spec https://design.example.com/dark");
  });

  it("shows the thread, oldest message first, with what each message is and who posted it", async () => {
    const text = textOf((await open("FE-1")).html);
    expect(text).toContain("Thread");
    const question = text.indexOf("Which browsers must it support?");
    const answer = text.indexOf("The last two versions of each.");
    expect(question).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(question);
    expect(text).toContain("A blocking question, answered, from bob for team FE");
    expect(text).toContain("An answer, from alice for team BE");
  });

  it("shows the proposals, each pending one with a link to its confirm page", async () => {
    const { html } = await open("FE-1");
    const text = textOf(html);
    expect(text).toContain("Proposals");
    expect(text).toContain("A decline, pending, proposed by bob");
    expect(text).toContain("It needs the confirmation of bob, and has none yet.");
    expect(html).toContain(`<a href="/confirm/${decline}">Review it, then confirm or reject it</a>`);
  });

  it("shows no notice on a request that does not wait for a person", async () => {
    expect(textOf((await open("FE-1")).html)).not.toContain("waits for a person");
  });

  // Either human action clears the flag: a message posted in the web UI, or a proposal on the request confirmed there
  // (agent-safety: Runaway agent loops flag the request needs_human; design.md, Decisions: D46 (7)), and the notice
  // names both.
  it("shows that a request agents flagged needs_human waits for a person, and what a person does to clear it", async () => {
    const { status, html } = await open("FE-2");
    expect(status).toBe(200);
    expect(textOf(html)).toContain(
      "FE-2 waits for a person: agents made so many writes on it that their writes are refused until a member posts a message on it here or confirms a proposal on it in the web UI.",
    );
  });

  it("gives the page a new ETag when a proposal is made on the request, since the page lists it", async () => {
    const before = (await open("FE-1")).etag;
    expect(before).not.toBeNull();
    expect((await open("FE-1")).etag).toBe(before);
    const withdrawal = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests/FE-1/proposals", { kind: "withdraw" });
    expect(withdrawal.status).toBe(202);
    const after = await open("FE-1");
    expect(after.etag).not.toBe(before);
    expect(textOf(after.html)).toContain("A withdrawal, pending, proposed by alice");
  });
});
