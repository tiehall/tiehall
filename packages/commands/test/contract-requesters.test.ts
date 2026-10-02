import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInstallGitHub, type CiCaller, type WebSessionCaller } from "../src/index.ts";
import { changesOf, CONTRACT_WORKFLOW, providerOnStub, reportOf, runDueUpdates, type StubProvider } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, tokenOf } from "./support/requests.ts";

// The provider PR's author is the requester (contract-changes: The provider
// PR's author is the requester; requester-loop: What whats_new covers;
// design.md, Decisions this change rests on: D14, D37; D28 #75; design.md,
// Self-hosting decisions: S4, S5). The requester of a contract-change request
// is the Tiehall user whose GitHub account authored the provider pull
// request, while that user is a member of the install, with the provider team
// as the requesting team; consumers' questions then reach the author through
// the requester loop. When the author's GitHub account belongs to no Tiehall
// user, or to one who is not a member, the provider team alone is the
// requester, and the report's answer says so, for the contract Action to
// comment on the pull request. Tiehall reads the pull request's author from
// GitHub with the install's App, through the installation that covers the
// repository, before it takes the report: the App maps PR authors to users.
// Here the GitHub stub plays GitHub, with acme/payments and its pull
// requests.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let clock = new Date("2026-10-05T08:00:00Z");
let ada: WebSessionCaller;
let deniz: string;
let mehmet: string;

const CI = (): CiCaller => ({ kind: "ci", repositoryId: String(provider.repositoryId), repositoryOwnerId: String(provider.ownerId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  stub = await startGitHubStub();
  // deniz is a member of the install; removed was one and is no more; outsider never signed in.
  provider = await providerOnStub(install, stub, ["deniz", "removed", "outsider", "mehmet"]);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
  await addUser(install.owner, { login: "removed", githubAccountId: provider.account("removed"), role: null });
  mehmet = await addUser(install.owner, { login: "mehmet", githubAccountId: provider.account("mehmet") });
  const pay = await addTeam(install.owner, "PAY");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, deniz, pay);
  await joinTeams(install.owner, mehmet, fe);
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
  await install.owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
    [fe, mehmet],
  );
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

/** A pull request on acme/payments that this GitHub user opened; returns its number. */
async function pullRequestBy(login: string): Promise<number> {
  return (await stub.openPullRequest("acme/payments", { title: "New payment fields", head: `${login}-payment-fields`, author: login })).number;
}

/** The CI run reports breaking changes of the pull request; returns the report's answer. */
async function report(pullRequest: number): Promise<{ requester: { kind: string; team: string } }> {
  return (await install.execute("contract.report", CI(), reportOf("payments-api", changesOf("breaking"), { pullRequest }))) as { requester: { kind: string; team: string } };
}

/** Applies the change set's update, once the report's burst has ended. */
async function applyUpdates(): Promise<void> {
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

/** The request the pull request's report opened to FE: its key, id, requesting user and requesting team. */
async function feRequestOf(pullRequest: number): Promise<{ id: string; key: string; requesting_user_id: string | null; requesting_team: string }> {
  const { rows } = await install.owner.query(
    `SELECT r.id, 'FE-' || r.number AS key, r.requesting_user_id, t.key AS requesting_team
       FROM requests r JOIN teams t ON t.id = r.requesting_team_id
       JOIN packet_revisions p ON p.request_id = r.id AND p.number = 1
      WHERE (p.packet -> 'untrusted' -> 'contract' -> 'provider_pr' ->> 'number')::int = $1`,
    [pullRequest],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("a provider pull request whose author is a member of the install", () => {
  it("makes its author the requesting user, with the provider team as the requesting team, and the report's answer says so", async () => {
    const pullRequest = await pullRequestBy("deniz");

    const answer = await report(pullRequest);
    await applyUpdates();

    expect(answer.requester).toEqual({ kind: "author", team: "PAY" });
    expect(await feRequestOf(pullRequest)).toMatchObject({ requesting_user_id: deniz, requesting_team: "PAY" });
  });

  it("sends the consumers' questions to the author's whats_new", async () => {
    const pullRequest = await pullRequestBy("deniz");
    await report(pullRequest);
    await applyUpdates();
    const request = await feRequestOf(pullRequest);

    const question = await callApi(install, tokenOf(mehmet), "POST", `/api/v1/requests/${request.key}/messages`, { kind: "question", body: "Does the amount move to amount_minor?", blocking: true });
    expect(question.status).toBe(200);

    const updates = (await install.execute("updates.read", tokenOf(deniz), { limit: 50 })) as { events: { type: string; request: { id: string } }[] };
    expect(updates.events.filter(({ request: { id } }) => id === request.id).map(({ type }) => type)).toContain("request.message_posted");
  });
});

describe("a provider pull request whose author is no member of the install", () => {
  it("makes the provider team alone the requester when the author never signed in, and the report's answer says so", async () => {
    const pullRequest = await pullRequestBy("outsider");

    const answer = await report(pullRequest);
    await applyUpdates();

    expect(answer.requester).toEqual({ kind: "team", team: "PAY" });
    expect(await feRequestOf(pullRequest)).toMatchObject({ requesting_user_id: null, requesting_team: "PAY" });
  });

  it("falls back to the provider team when the author's Tiehall user was removed from the install", async () => {
    const pullRequest = await pullRequestBy("removed");

    const answer = await report(pullRequest);
    await applyUpdates();

    expect(answer.requester).toEqual({ kind: "team", team: "PAY" });
    expect(await feRequestOf(pullRequest)).toMatchObject({ requesting_user_id: null, requesting_team: "PAY" });
  });
});

describe("the author's look-up on GitHub", () => {
  it("is refused with 502 when GitHub does not answer, and no report is taken, so the Action fails open and its next run reports again", async () => {
    const pullRequest = await pullRequestBy("deniz");
    const before = Number((await install.owner.query("SELECT count(*) FROM contract_reports")).rows[0].count);
    install.useGitHub(createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: "http://127.0.0.1:9", fetch, logger: install.logger, timeoutMs: 1000 }));
    try {
      const refused = await report(pullRequest).catch((error: unknown) => error);
      expect(refused).toMatchObject({ status: 502 });
    } finally {
      install.useGitHub(createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch, logger: install.logger }));
    }
    expect(Number((await install.owner.query("SELECT count(*) FROM contract_reports")).rows[0].count)).toBe(before);
  });
});
