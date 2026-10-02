import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CiCaller, WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams } from "./support/requests.ts";

// Breaking changes open one request per consuming team (contract-changes:
// Breaking changes open one request per consuming team; contract-changes:
// INFO-level changes appear only on existing requests; requests: Provenance
// is stamped by the server; design.md, Decisions this change rests on: D14;
// D28 #70, #71; D30 (3)). A contract report of a provider pull request
// against a registered API is one report of that change set: the pull
// request against the API. Its update opens one request to each team that
// declared it consumes the API, keyed by the change set and the team, when
// the report holds an ERR-level change, with every classified change, each
// with its level, in the packet's contract section; a rerun and a later
// report of the change set open no second request; a pull request against two
// APIs makes two change sets; a report with only INFO-level changes, or only
// WARN-level ones while the API's WARN switch is off, opens nothing. Opening
// a request from a report is a system action, recorded with the actor kind
// system and the surface github. The changes are those the pinned oasdiff
// classified for the fixture pairs of task 23.1. A CI run reports through
// the real contract.report, and the worker's job applies its change set's
// update once its burst of reports has ended, 2 minutes after its first
// report (contract-bursts.test.ts), on the test's clock.

let install: TestInstall;
let clock = new Date("2026-10-05T08:00:00Z");
let ada: WebSessionCaller;
let deniz: string;
let acmeId: number;
const teams: Record<string, string> = {};

/** A CI run of the contract Action in acme/payments, as its OIDC token names it. */
const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  deniz = await addUser(install.owner, { login: "deniz" });
  for (const key of ["PAY", "FE", "MOBILE", "OPS"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  for (const name of ["payments-api", "billing-api"]) {
    expect((await install.confirm(ada, "apis.register", { name, team: teams["PAY"], repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  }
  // FE and MOBILE consume payments-api, FE billing-api too; OPS consumes nothing.
  for (const [api, team] of [["payments-api", "FE"], ["payments-api", "MOBILE"], ["billing-api", "FE"]] as const) {
    await install.owner.query(
      `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT apis.org_id, apis.id, $2, $3, now(), now() FROM apis WHERE apis.name = $1`,
      [api, teams[team], deniz],
    );
  }
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  install.sentJobs.splice(0);
});

/** Reports, as a CI run of the contract Action in acme/payments does, through the real contract.report. */
async function report(body: Record<string, unknown>): Promise<void> {
  await install.execute("contract.report", ciRun(), body);
}

/** Runs the jobs that apply the change sets' updates once the reports' bursts have ended, as the worker does. */
async function applyReports(): Promise<void> {
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

interface OpenedRequest {
  key: string;
  state: string;
  requesting_team: string;
  requesting_user_id: string | null;
  title: string;
  packet: { kind: string; untrusted: { need: string; contract: Record<string, unknown> } };
}

/** The requests to these teams that the reports of a pull request opened, in team order. */
async function contractRequests(pullRequest: number): Promise<OpenedRequest[]> {
  const { rows } = await install.owner.query<OpenedRequest>(
    `SELECT target.key || '-' || r.number AS key, r.state, requesting.key AS requesting_team, r.requesting_user_id, r.title, p.packet
       FROM requests r
       JOIN teams target ON target.id = r.target_team_id
       JOIN teams requesting ON requesting.id = r.requesting_team_id
       JOIN packet_revisions p ON p.request_id = r.id AND p.number = 1
      WHERE (p.packet -> 'untrusted' -> 'contract' -> 'provider_pr' ->> 'number')::int = $1
      ORDER BY target.key, r.number`,
    [pullRequest],
  );
  return rows;
}

describe("a report with ERR-level changes", () => {
  it("opens one request to each team that declared it consumes the API, with every classified change in its contract section", async () => {
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 310 }));
    await applyReports();

    const opened = await contractRequests(310);
    expect(opened.map(({ key, state, requesting_team }) => ({ key: key.replace(/-\d+$/, ""), state, requesting_team }))).toEqual([
      { key: "FE", state: "open", requesting_team: "PAY" },
      { key: "MOBILE", state: "open", requesting_team: "PAY" },
    ]);
    for (const request of opened) {
      expect(request.packet.kind).toBe("contract_change");
      expect(request.packet.untrusted.contract).toEqual({
        api: "payments-api",
        base: { ref: "main", sha: "a".repeat(40) },
        head: { ref: "new-payment-fields", sha: "b".repeat(40) },
        engine: { name: "oasdiff", version: "1.32.1" },
        changes: changesOf("breaking"),
        provider_pr: { repository: "acme/payments", number: 310, url: "https://github.com/acme/payments/pull/310" },
        provider_status: "open",
      });
      expect(request.title).toBe("Breaking changes to payments-api in acme/payments#310");
      expect(request.packet.untrusted.need).toContain("2 breaking changes");
    }
  });

  it("lists the INFO-level and WARN-level changes of the report in the requests it opens, each with its level", async () => {
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 312 }));
    await applyReports();

    const [request] = await contractRequests(312);
    const levels = (request?.packet.untrusted.contract["changes"] as { level: string }[]).map(({ level }) => level);
    expect(levels).toEqual(["ERR", "ERR", "WARN", "INFO", "INFO"]);
  });

  it("records the opening, the first revision and their events with the actor kind system and the surface github", async () => {
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 313 }));
    await applyReports();

    const { rows } = await install.owner.query(
      `SELECT e.type, e.actor_kind, e.actor_user_id, e.surface, p.actor_kind AS revision_actor_kind, p.surface AS revision_surface
         FROM events e
         JOIN requests r ON r.id::text = e.data ->> 'requestId'
         JOIN packet_revisions p ON p.request_id = r.id AND p.number = 1
        WHERE e.type = 'request.opened' AND (p.packet -> 'untrusted' -> 'contract' -> 'provider_pr' ->> 'number')::int = 313`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual({ type: "request.opened", actor_kind: "system", actor_user_id: null, surface: "github", revision_actor_kind: "system", revision_surface: "github" });
    }
  });

  it("opens nothing new when the same run reports the same changes again", async () => {
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 314 }));
    await applyReports();
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 314 }));
    await applyReports();

    expect((await contractRequests(314)).map(({ key }) => key.replace(/-\d+$/, ""))).toEqual(["FE", "MOBILE"]);
  });

  it("opens two requests to a team that consumes both APIs one pull request changes: one per change set", async () => {
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 315 }));
    await report(reportOf("billing-api", changesOf("breaking"), { pullRequest: 315 }));
    await applyReports();

    const opened = await contractRequests(315);
    expect(opened.filter(({ key }) => key.startsWith("FE-")).map(({ packet }) => packet.untrusted.contract["api"]).sort()).toEqual(["billing-api", "payments-api"]);
    expect(opened.filter(({ key }) => key.startsWith("MOBILE-"))).toHaveLength(1);
  });

  it("opens nothing to a team that has not declared it consumes the API", async () => {
    await report(reportOf("payments-api", changesOf("breaking"), { pullRequest: 316 }));
    await applyReports();

    expect((await contractRequests(316)).filter(({ key }) => key.startsWith("OPS-"))).toEqual([]);
  });
});

describe("a report with no ERR-level change", () => {
  it("opens nothing when it holds only INFO-level changes", async () => {
    await report(reportOf("payments-api", changesOf("informational"), { pullRequest: 320 }));
    await applyReports();

    expect(await contractRequests(320)).toEqual([]);
  });

  it("opens nothing when it holds WARN-level and INFO-level changes while the API's WARN switch is off", async () => {
    await report(reportOf("payments-api", changesOf("warning"), { pullRequest: 321 }));
    await applyReports();

    expect(await contractRequests(321)).toEqual([]);
  });

  it("opens nothing when it holds no change at all", async () => {
    await report(reportOf("payments-api", changesOf("unchanged"), { pullRequest: 322 }));
    await applyReports();

    expect(await contractRequests(322)).toEqual([]);
  });
});
