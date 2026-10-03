import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubIssues, createInstallGitHub, mirrorRequest, syncMirror, type GitHubAppAccess, type WebSessionCaller } from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// Mirror updates on GitHub Issues (tracker-mirrors: One comment per state
// change and per question notice; tracker-mirrors: Terminal requests close
// their GitHub mirror issue; agent-safety: Tracker mirrors carry a summary and
// a link, not the packet). Each state change of a mirrored request, and each
// question on it, adds exactly one comment Tiehall writes, as the App's bot,
// and the state label follows the new state; a question's comment says that a
// question waits and links the request, and holds none of its text. A request
// that is done closes its issue as completed, one that is declined or
// withdrawn as not planned, and an undone decline reopens it. The GitHub stub
// plays GitHub; FE maps acme/fe-intake.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let app: GitHubAppAccess;
let alice: string;
let ayse: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse"], { repositories: ["acme/fe-intake"] });
  app = (await provider.github.app())!;
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, fe);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

const sync = (requestId: string, through: GitHubAppAccess = app) =>
  syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app: through, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);

const confirm = (user: string, proposal: string) => install.confirm(sessionOf(user), "proposals.confirm", { proposal });

/** The request's mirror issue on the stub. */
async function issueOf(requestId: string) {
  const { rows } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [requestId]);
  return stub.issue("acme/fe-intake", Number(rows[0]?.issue));
}

/** A request Alice opens to FE and Ayşe claims, with its mirror issue made. */
async function mirroredRequest(): Promise<{ key: string; id: string }> {
  const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE", title: "Show the invoice total" });
  await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
  await sync(request.id);
  return request;
}

/** The comments Tiehall added to the request's issue, after its marker line is set aside. */
async function commentsOf(requestId: string): Promise<string[]> {
  return (await issueOf(requestId)).comments.map(({ body }) => body.replace(/\n\n<!-- tiehall:mirror-comment [0-9a-f-]{36} -->$/, ""));
}

describe("a state change", () => {
  it("adds exactly one comment, by the App's bot, that names the new state and links the request, and the label follows", async () => {
    const request = await mirroredRequest();
    expect(await commentsOf(request.id)).toEqual([]);

    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
    await sync(request.id);
    await sync(request.id);

    const issue = await issueOf(request.id);
    expect(await commentsOf(request.id)).toEqual([`${request.key} is now in_progress in Tiehall: ${URL_OF_INSTALL}/${request.key}`]);
    expect(issue.comments.map(({ author }) => author)).toEqual([{ kind: "bot", app: provider.app }]);
    expect(issue.labels).toEqual(["tiehall:in_progress"]);
    expect(issue.state).toBe("open");
  });

  it("each get their own comment when several land before the job runs, in order", async () => {
    const request = await mirroredRequest();
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "open" });

    await sync(request.id);

    expect(await commentsOf(request.id)).toEqual([
      `${request.key} is now in_progress in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
      `${request.key} is now open in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
    ]);
    expect((await issueOf(request.id)).labels).toEqual(["tiehall:open"]);
  });

  it("is commented once when GitHub made the comment but its answer never reached Tiehall, and the job runs again", async () => {
    const request = await mirroredRequest();
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
    let dropped = false;
    const losing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!dropped && (init?.method ?? "GET") === "POST" && url.pathname.endsWith("/comments")) {
        dropped = true;
        throw new TypeError("fetch failed: the connection was reset");
      }
      return response;
    };
    const lossy = createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: losing, logger: install.logger });

    await expect(sync(request.id, (await lossy.app())!)).rejects.toThrow();
    await sync(request.id);

    expect(await commentsOf(request.id)).toEqual([`${request.key} is now in_progress in Tiehall: ${URL_OF_INSTALL}/${request.key}`]);
  });
});

describe("a question", () => {
  it("adds exactly one comment that says a question waits and links the request, with none of its text", async () => {
    const request = await mirroredRequest();
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
    await sync(request.id);
    const question = `Which currency? ${randomUUID()}`;
    await install.execute("messages.post", sessionOf(ayse), { key: request.key, kind: "question", blocking: true, body: question });
    expect(install.sentJobs.filter(({ queue }) => queue === mirrorRequest.queue).length).toBeGreaterThan(0);

    await sync(request.id);

    const comments = await commentsOf(request.id);
    expect(comments).toEqual([
      `${request.key} is now in_progress in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
      `A question on ${request.key} waits for an answer in Tiehall, and ${request.key} is now needs_info: ${URL_OF_INSTALL}/${request.key}`,
    ]);
    expect(JSON.stringify((await issueOf(request.id)).comments)).not.toContain(question);
    expect((await issueOf(request.id)).labels).toEqual(["tiehall:needs_info"]);
  });

  it("that does not block adds one notice, and the answer that returns the request adds one for its state", async () => {
    const request = await mirroredRequest();
    await install.execute("messages.post", sessionOf(alice), { key: request.key, kind: "question", blocking: false, body: "Is the total with tax?" });
    await sync(request.id);
    const blocking = (await install.execute("messages.post", sessionOf(ayse), { key: request.key, kind: "question", blocking: true, body: "Which currency?" })) as { message: { id: string } };
    await install.execute("messages.post", sessionOf(alice), { key: request.key, kind: "answer", questionId: blocking.message.id, body: "Euro." });
    await sync(request.id);

    expect(await commentsOf(request.id)).toEqual([
      `A question on ${request.key} waits for an answer in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
      `A question on ${request.key} waits for an answer in Tiehall, and ${request.key} is now needs_info: ${URL_OF_INSTALL}/${request.key}`,
      `${request.key} is now claimed in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
    ]);
    expect((await issueOf(request.id)).labels).toEqual(["tiehall:claimed"]);
  });
});

describe("a request that ends", () => {
  it("closes its issue as completed when it is done", async () => {
    const request = await mirroredRequest();
    const done = (await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "done" })) as { proposal: { id: string } };
    expect((await confirm(ayse, done.proposal.id)).status).toBe(200);

    await sync(request.id);

    const issue = await issueOf(request.id);
    expect({ state: issue.state, stateReason: issue.stateReason, labels: issue.labels }).toEqual({ state: "closed", stateReason: "completed", labels: ["tiehall:done"] });
    expect(await commentsOf(request.id)).toEqual([`${request.key} is now done in Tiehall: ${URL_OF_INSTALL}/${request.key}`]);
  });

  it("closes the issue a retried create finds when it was done before the retry, with the done label and a comment for the move", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE", title: "Show the invoice total" });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    // GitHub makes the issue, but its answer never reaches Tiehall: the job fails and waits for its retry.
    let dropped = false;
    const losing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!dropped && (init?.method ?? "GET") === "POST" && url.pathname.endsWith("/fe-intake/issues")) {
        dropped = true;
        throw new TypeError("fetch failed: the connection was reset");
      }
      return response;
    };
    const lossy = createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: losing, logger: install.logger });
    await expect(sync(request.id, (await lossy.app())!)).rejects.toThrow();
    // Within the 14 minutes before the retry, the request is marked done.
    const done = (await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "done" })) as { proposal: { id: string } };
    expect((await confirm(ayse, done.proposal.id)).status).toBe(200);

    await sync(request.id);
    await sync(request.id);

    const issue = await issueOf(request.id);
    expect({ state: issue.state, stateReason: issue.stateReason, labels: issue.labels }).toEqual({ state: "closed", stateReason: "completed", labels: ["tiehall:done"] });
    expect(await commentsOf(request.id)).toEqual([`${request.key} is now done in Tiehall: ${URL_OF_INSTALL}/${request.key}`]);
  });

  it("closes its issue as not planned when it is withdrawn", async () => {
    const request = await mirroredRequest();
    const withdrawal = (await install.execute("requests.propose", sessionOf(alice), { key: request.key, kind: "withdraw" })) as { proposal: { id: string } };
    expect((await confirm(alice, withdrawal.proposal.id)).status).toBe(200);

    await sync(request.id);

    const issue = await issueOf(request.id);
    expect({ state: issue.state, stateReason: issue.stateReason, labels: issue.labels }).toEqual({ state: "closed", stateReason: "not_planned", labels: ["tiehall:withdrawn"] });
  });

  it("closes its issue as not planned when it is declined, and reopens it with the restored state's label when the decline is undone", async () => {
    const request = await mirroredRequest();
    const decline = (await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "declined" })) as { proposal: { id: string } };
    expect((await confirm(ayse, decline.proposal.id)).status).toBe(200);
    await sync(request.id);
    let issue = await issueOf(request.id);
    expect({ state: issue.state, stateReason: issue.stateReason, labels: issue.labels }).toEqual({ state: "closed", stateReason: "not_planned", labels: ["tiehall:declined"] });

    expect((await install.confirm(sessionOf(ayse), "proposals.undo", { proposal: decline.proposal.id })).status).toBe(200);
    await sync(request.id);

    issue = await issueOf(request.id);
    expect({ state: issue.state, labels: issue.labels }).toEqual({ state: "open", labels: ["tiehall:claimed"] });
    expect(await commentsOf(request.id)).toEqual([
      `${request.key} is now declined in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
      `${request.key} is now claimed in Tiehall: ${URL_OF_INSTALL}/${request.key}`,
    ]);
  });
});
