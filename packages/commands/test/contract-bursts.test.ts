import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CiCaller, WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams } from "./support/requests.ts";

// Bursts of reports are merged into one update (contract-changes: Bursts of
// reports are merged into one update; design.md, Design rules: Contract
// changes; design.md, Readings to confirm with the founder: R19). Reports for
// the same change set within 2 minutes of each other make one update, which
// reflects the latest of them. The 2 minutes start with the first report of a
// burst: the update is applied 2 minutes after that report, with the latest
// report received by then, and a report that arrives later starts the next
// burst, so an update never waits more than 2 minutes, however often reports
// come. Each update adds a packet revision to the change set's requests,
// which task 23.11 completes; here a revision shows which report an update
// applied, by its head commit. The clock is the test's, and the worker's job
// that applies an update runs when the time it was sent for has come.

let install: TestInstall;
let clock = new Date("2026-10-05T08:00:00Z");
let acmeId: number;
let pullRequest = 400;

/** A CI run of the contract Action in acme/payments. */
const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  const deniz = await addUser(install.owner, { login: "deniz" });
  const pay = await addTeam(install.owner, "PAY");
  const fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, deniz, pay);
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  await install.owner.query(
    `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
       SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
    [fe, deniz],
  );
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
  pullRequest += 1;
});

/** Sets the clock to this time of 2026-10-05, UTC. */
function at(time: string): void {
  clock = new Date(`2026-10-05T${time}Z`);
}

/** The head commit of a report sent at this time: one per time, so a revision shows which report it applied. */
const headAt = (time: string) => time.replace(/:/g, "").padEnd(40, "0").replace(/[^0-9a-f]/g, "0");

/** The CI run reports the pull request at the clock's time, with breaking changes and the head commit of that time. */
async function reportAt(time: string): Promise<void> {
  at(time);
  await install.execute("contract.report", ciRun(), reportOf("payments-api", changesOf("breaking"), { pullRequest, head: headAt(time) }));
}

/** Runs, at this time, every job of the worker that applies an update and whose time has come, as the worker does. */
async function workerAt(time: string): Promise<void> {
  at(time);
  await runDueUpdates(install, clock);
}

/** The head commit of each packet revision of the pull request's request to FE, in order. */
async function revisionHeads(): Promise<string[]> {
  const { rows } = await install.owner.query<{ head: string }>(
    `SELECT p.packet -> 'untrusted' -> 'contract' -> 'head' ->> 'sha' AS head
       FROM packet_revisions p
       JOIN requests r ON r.id = p.request_id
      WHERE (SELECT (first.packet -> 'untrusted' -> 'contract' -> 'provider_pr' ->> 'number')::int FROM packet_revisions first WHERE first.request_id = r.id AND first.number = 1) = $1
      ORDER BY p.number`,
    [pullRequest],
  );
  return rows.map(({ head }) => head);
}

describe("two reports 40 seconds apart", () => {
  it("make one update, applied 2 minutes after the first, which matches the second", async () => {
    // FE's request exists for the change set, from an earlier burst.
    await reportAt("08:50:00");
    await workerAt("08:52:00");
    expect(await revisionHeads()).toEqual([headAt("08:50:00")]);

    await reportAt("09:00:00");
    await reportAt("09:00:40");
    await workerAt("09:01:59");
    expect(await revisionHeads()).toEqual([headAt("08:50:00")]);

    await workerAt("09:02:00");
    expect(await revisionHeads()).toEqual([headAt("08:50:00"), headAt("09:00:40")]);

    await workerAt("09:10:00");
    expect(await revisionHeads()).toEqual([headAt("08:50:00"), headAt("09:00:40")]);
  });

  it("open the request with the second when the change set has none yet", async () => {
    await reportAt("09:00:00");
    await reportAt("09:00:40");
    await workerAt("09:02:00");
    expect(await revisionHeads()).toEqual([headAt("09:00:40")]);
  });
});

describe("a steady stream of reports", () => {
  it("is applied every 2 minutes, each time with the latest report of its burst, and never merged forever", async () => {
    // Reports every 90 seconds from 09:00:00; the worker runs every 10 seconds.
    const reports = ["09:00:00", "09:01:30", "09:03:00", "09:04:30", "09:06:00"];
    const applied: { at: string; heads: string[] }[] = [];
    for (let second = 0; second <= 7 * 60; second += 10) {
      const time = new Date(Date.parse("2026-10-05T09:00:00Z") + second * 1000).toISOString().slice(11, 19);
      await workerAt(time);
      if (reports.includes(time)) await reportAt(time);
      const heads = await revisionHeads();
      if (heads.length > (applied.at(-1)?.heads.length ?? 0)) applied.push({ at: time, heads });
    }
    expect(applied).toEqual([
      { at: "09:02:00", heads: [headAt("09:01:30")] },
      { at: "09:05:00", heads: [headAt("09:01:30"), headAt("09:04:30")] },
    ]);
    // The report of 09:06:00 started the next burst, which waits until 09:08:00.
    await workerAt("09:07:59");
    expect(await revisionHeads()).toHaveLength(2);
    await workerAt("09:08:00");
    expect(await revisionHeads()).toEqual([headAt("09:01:30"), headAt("09:04:30"), headAt("09:06:00")]);
  });
});

describe("a report that comes while an earlier burst's update is overdue", () => {
  it("starts the next burst once the overdue update is applied with its own burst's latest report", async () => {
    await reportAt("09:00:00");
    await reportAt("09:01:00");
    // The worker was stopped from 09:00:30 until 09:04:00.
    await reportAt("09:03:00");
    await workerAt("09:04:00");
    expect(await revisionHeads()).toEqual([headAt("09:01:00")]);
    await workerAt("09:04:59");
    expect(await revisionHeads()).toEqual([headAt("09:01:00")]);
    await workerAt("09:05:00");
    expect(await revisionHeads()).toEqual([headAt("09:01:00"), headAt("09:03:00")]);
  });
});
