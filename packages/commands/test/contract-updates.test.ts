import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CiCaller, WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, CONTRACT_WORKFLOW, PAYMENTS_REPOSITORY, reportOf, runDueUpdates, type ClassifiedChange } from "./support/contract.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Applying a change set's update (contract-changes: Each update adds a packet
// revision and a system message; requests: System actions need no proposal
// or confirmation; handoff-packet: Packet changes that are commitments;
// requests: Provenance is stamped by the server; design.md, Decisions this
// change rests on: D28 #74; D30 (3), (4)). Each update of a change set adds
// the report's contract section as the next packet revision of every request
// of the change set that is not in a terminal state, and a system message,
// written by Tiehall, that states how the number of breaking changes changed,
// such as "diff updated: 2 → 3 breaking", both recorded with the actor kind
// system and the surface github and taking effect with no proposal and no
// confirmation, also while the request is claimed. A pending packet change
// based on an earlier revision is cancelled as stale. A request of the change
// set in a terminal state gets only a notice of the update. The reports come
// through the real contract.report, and the worker's job applies each burst
// once it has ended, on the test's clock.

let install: TestInstall;
let clock = new Date("2026-10-06T08:00:00Z");
let acmeId: number;
let pullRequest = 500;
let deniz: string;
let bob: string;
const teams: Record<string, string> = {};

/** A CI run of the contract Action in acme/payments. */
const ciRun = (): CiCaller => ({ kind: "ci", repositoryId: String(PAYMENTS_REPOSITORY.id), repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

/** The breaking pair's changes with the level of one changed: its WARN-level change rated INFO, which leaves two ERR-level ones. */
const oneLevelChanged = (): ClassifiedChange[] => changesOf("breaking").map((change) => (change.level === "WARN" ? { ...change, level: "INFO" } : change));

/** The breaking pair's changes with a third ERR-level change, as a later push adds it. */
const threeBreaking = (): ClassifiedChange[] => [
  ...changesOf("breaking"),
  { id: "response-property-type-changed", level: "ERR", operation: "GET /payments/{id}" },
];

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  deniz = await addUser(install.owner, { login: "deniz" });
  bob = await addUser(install.owner, { login: "bob" });
  for (const key of ["PAY", "FE", "MOBILE"]) teams[key] = await addTeam(install.owner, key);
  await joinTeams(install.owner, deniz, teams["PAY"] ?? "");
  await joinTeams(install.owner, bob, teams["FE"] ?? "");
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [PAYMENTS_REPOSITORY] }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: teams["PAY"], repository: PAYMENTS_REPOSITORY.fullName })).status).toBe(200);
  for (const team of ["FE", "MOBILE"]) {
    await install.owner.query(
      `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
         SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
      [teams[team], deniz],
    );
  }
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
  pullRequest += 1;
});

/** The CI run reports the pull request with these changes, and the worker applies the update once its burst has ended. */
async function pushReports(changes: readonly ClassifiedChange[], head = "b"): Promise<void> {
  await install.execute("contract.report", ciRun(), reportOf("payments-api", changes, { pullRequest, head: head.repeat(40) }));
  clock = new Date(clock.getTime() + 3 * 60 * 1000);
  await runDueUpdates(install, clock);
}

interface ContractRequest {
  id: string;
  key: string;
  state: string;
}

/** The pull request's request to a team. */
async function requestTo(team: string): Promise<ContractRequest> {
  const { rows } = await install.owner.query<ContractRequest>(
    `SELECT r.id, t.key || '-' || r.number AS key, r.state
       FROM contract_change_requests c
       JOIN contract_change_sets s ON s.id = c.change_set_id
       JOIN requests r ON r.id = c.request_id
       JOIN teams t ON t.id = r.target_team_id
      WHERE s.pull_request_number = $1 AND t.key = $2`,
    [pullRequest, team],
  );
  const [request] = rows;
  if (request === undefined || rows.length !== 1) throw new Error(`The pull request has ${rows.length} requests to ${team}.`);
  return request;
}

/** The request's packet revisions: each one's number, how many ERR-level changes its contract section holds, and who added it. */
async function revisionsOf(requestId: string): Promise<{ number: number; breaking: number; actor_kind: string; surface: string | null }[]> {
  const { rows } = await install.owner.query(
    `SELECT number,
            (SELECT count(*)::int FROM json_array_elements(packet -> 'untrusted' -> 'contract' -> 'changes') c WHERE c ->> 'level' = 'ERR') AS breaking,
            actor_kind, surface
       FROM packet_revisions WHERE request_id = $1 ORDER BY number`,
    [requestId],
  );
  return rows;
}

/** The request's thread, oldest first: each message's kind, provenance and text. */
async function threadOf(requestId: string): Promise<{ kind: string; actor_kind: string; surface: string | null; actor_user_id: string | null; body: string }[]> {
  const { rows } = await install.owner.query(
    `SELECT m.kind, m.actor_kind, m.surface, m.actor_user_id, v.body
       FROM messages m JOIN message_versions v ON v.message_id = m.id AND v.version = 1
      WHERE m.request_id = $1 ORDER BY m.number`,
    [requestId],
  );
  return rows;
}

/** The request's proposals: each one's kind, state and why it was cancelled. */
async function proposalsOf(requestId: string): Promise<{ id: string; kind: string; state: string; cancel_reason: string | null }[]> {
  const { rows } = await install.owner.query("SELECT id, kind, state, cancel_reason FROM proposals WHERE request_id = $1 ORDER BY created_at", [requestId]);
  return rows;
}

/** The events about the request after this number, with their provenance. */
async function eventsAfter(requestId: string, after: number): Promise<{ type: string; actor_kind: string; surface: string | null; data: Record<string, unknown> }[]> {
  const { rows } = await install.owner.query(
    "SELECT type, actor_kind, surface, data FROM events WHERE data ->> 'requestId' = $1 AND number > $2 ORDER BY number",
    [requestId, after],
  );
  return rows;
}

async function latestEvent(): Promise<number> {
  const { rows } = await install.owner.query<{ number: string | null }>("SELECT max(number) AS number FROM events");
  return Number(rows[0]?.number ?? 0);
}

describe("a push that adds a breaking change", () => {
  it("adds a packet revision to a claimed request at once, with no proposal and no confirmation", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });

    await pushReports(threeBreaking(), "c");

    expect(await revisionsOf(fe.id)).toEqual([
      { number: 1, breaking: 2, actor_kind: "system", surface: "github" },
      { number: 2, breaking: 3, actor_kind: "system", surface: "github" },
    ]);
    expect(await proposalsOf(fe.id)).toEqual([]);
    expect((await requestTo("FE")).state).toBe("claimed");
  });

  // agent-surfaces: Requests missing a team's required fields are refused, "A report's revision is exempt"
  // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (41)): a team's required fields hold
  // the revisions people and agents add, never the ones a report adds.
  it("adds a report's revision to a request whose packet lacks a field its team requires", async () => {
    await install.owner.query("UPDATE teams SET required_fields = ARRAY['acceptance_criteria', 'code_refs'] WHERE key = 'FE'");
    try {
      await pushReports(changesOf("breaking"));
      const fe = await requestTo("FE");
      await pushReports(threeBreaking(), "c");
      expect((await revisionsOf(fe.id)).map(({ number, breaking, actor_kind }) => ({ number, breaking, actor_kind }))).toEqual([
        { number: 1, breaking: 2, actor_kind: "system" },
        { number: 2, breaking: 3, actor_kind: "system" },
      ]);
    } finally {
      await install.owner.query("UPDATE teams SET required_fields = '{}' WHERE key = 'FE'");
    }
  });

  it("posts one system message that states the earlier and the new count of breaking changes, recorded as the system from GitHub", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    const before = await latestEvent();

    await pushReports(threeBreaking(), "c");

    const thread = await threadOf(fe.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ kind: "comment", actor_kind: "system", surface: "github", actor_user_id: null });
    expect(thread[0]?.body).toContain("Diff updated: 2 → 3 breaking");
    expect(thread[0]?.body).toContain(`acme/payments#${pullRequest}`);
    const events = await eventsAfter(fe.id, before);
    expect(events.map(({ type, actor_kind, surface }) => ({ type, actor_kind, surface }))).toEqual([
      { type: "request.packet_revised", actor_kind: "system", surface: "github" },
      { type: "request.message_posted", actor_kind: "system", surface: "github" },
    ]);
  });

  it("revises every request of the change set that has not ended, and says when the count stays the same", async () => {
    await pushReports(changesOf("breaking"));
    await pushReports(oneLevelChanged(), "d");

    for (const team of ["FE", "MOBILE"]) {
      const request = await requestTo(team);
      expect((await revisionsOf(request.id)).map(({ number }) => number)).toEqual([1, 2]);
      const [message] = await threadOf(request.id);
      expect(message?.body).toContain("Diff updated: 2 → 2 breaking");
    }
  });
});

// An update whose classified changes, each change's id, level and operation, equal the last update's adds nothing
// (contract-changes: Each update adds a packet revision and a system message; decisions-from-groups-15-28, D55 (64)).
describe("a rerun that changes nothing", () => {
  it("adds no revision, no message and no notice to any request of the change set, and cancels no pending packet change", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    const { rows } = await install.owner.query<{ packet: Record<string, any> }>("SELECT packet FROM packet_revisions WHERE request_id = $1 AND number = 1", [fe.id]);
    const packet = rows[0]?.packet ?? {};
    const proposed = (await install.execute("packets.add_revision", sessionOf(deniz), {
      key: fe.key,
      expectedRevision: 1,
      packet: { ...packet, untrusted: { ...packet["untrusted"], need: "Move to the new payment fields before the release on Friday." } },
    })) as { proposal: { id: string } };
    // MOBILE's request ends, so an update that changed something would give it a notice.
    const mobile = await requestTo("MOBILE");
    await install.owner.query("UPDATE requests SET state = 'withdrawn' WHERE id = $1", [mobile.id]);
    const before = await latestEvent();

    // The same workflow run again, and a push that leaves the API's changes as they were, in another order.
    await pushReports(changesOf("breaking"), "b");
    await pushReports([...changesOf("breaking")].reverse(), "d");

    expect((await revisionsOf(fe.id)).map(({ number }) => number)).toEqual([1]);
    expect(await threadOf(fe.id)).toEqual([]);
    expect(await proposalsOf(fe.id)).toEqual([{ id: proposed.proposal.id, kind: "scope", state: "pending", cancel_reason: null }]);
    expect((await revisionsOf(mobile.id)).map(({ number }) => number)).toEqual([1]);
    expect(await threadOf(mobile.id)).toEqual([]);
    expect(await eventsAfter(fe.id, before)).toEqual([]);
    expect(await eventsAfter(mobile.id, before)).toEqual([]);
    expect((await requestTo("FE")).state).toBe("claimed");
  });

  it("adds a revision once one change's level changes", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await pushReports(changesOf("breaking"), "c");
    expect((await revisionsOf(fe.id)).map(({ number }) => number)).toEqual([1]);

    await pushReports(oneLevelChanged(), "d");

    expect((await revisionsOf(fe.id)).map(({ number }) => number)).toEqual([1, 2]);
    expect((await threadOf(fe.id)).map(({ body }) => body)).toEqual([expect.stringContaining("Diff updated: 2 → 2 breaking")]);
  });

  it("adds a revision once a change's operation changes, or a change is added", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");

    await pushReports(changesOf("breaking").map((change, index) => (index === 0 ? { ...change, operation: "PUT /payments" } : change)), "c");
    await pushReports([...changesOf("breaking"), { id: "endpoint-added", level: "INFO", operation: "GET /refunds/{id}" }], "d");

    expect((await revisionsOf(fe.id)).map(({ number }) => number)).toEqual([1, 2, 3]);
  });
});

describe("a pending packet change", () => {
  it("is cancelled as stale when an update adds a revision past its base revision", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    // PAY, the requester side, proposes to change the need of the claimed request, a scope change based on revision 1.
    const { rows } = await install.owner.query<{ packet: Record<string, any> }>("SELECT packet FROM packet_revisions WHERE request_id = $1 AND number = 1", [fe.id]);
    const packet = rows[0]?.packet ?? {};
    const answer = (await install.execute("packets.add_revision", sessionOf(deniz), {
      key: fe.key,
      expectedRevision: 1,
      packet: { ...packet, untrusted: { ...packet["untrusted"], need: "Move to the new payment fields before the release on Friday." } },
    })) as { proposal: { id: string } };
    expect(await proposalsOf(fe.id)).toEqual([{ id: answer.proposal.id, kind: "scope", state: "pending", cancel_reason: null }]);
    const before = await latestEvent();

    await pushReports(threeBreaking(), "c");

    expect(await proposalsOf(fe.id)).toEqual([{ id: answer.proposal.id, kind: "scope", state: "cancelled", cancel_reason: "stale" }]);
    const ended = (await eventsAfter(fe.id, before)).filter(({ type }) => type === "proposal.ended");
    expect(ended).toEqual([
      { type: "proposal.ended", actor_kind: "system", surface: "github", data: { requestId: fe.id, proposalId: answer.proposal.id, how: "cancelled", reason: "stale" } },
    ]);
    await expect(install.confirm(sessionOf(deniz), "proposals.confirm", { proposal: answer.proposal.id }).then((response) => response.status)).resolves.toBe(409);
  });
});

describe("a request in a terminal state", () => {
  it("gets only a notice of the update: its packet keeps its revision and it stays done", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("requests.claim", sessionOf(bob), { key: fe.key });
    const done = (await install.execute("requests.set_status", sessionOf(bob), { key: fe.key, state: "done" })) as { proposal: { id: string } };
    expect((await install.confirm(sessionOf(bob), "proposals.confirm", { proposal: done.proposal.id })).status).toBe(200);
    expect((await requestTo("FE")).state).toBe("done");
    const before = await latestEvent();

    await pushReports(threeBreaking(), "c");

    expect((await requestTo("FE")).state).toBe("done");
    expect((await revisionsOf(fe.id)).map(({ number }) => number)).toEqual([1]);
    const thread = await threadOf(fe.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ kind: "comment", actor_kind: "system", surface: "github", actor_user_id: null });
    expect(thread[0]?.body).toContain("Diff updated: 2 → 3 breaking");
    expect(thread[0]?.body).toContain(`${fe.key} is done`);
    expect((await eventsAfter(fe.id, before)).map(({ type }) => type)).toEqual(["request.message_posted"]);
    // The other request of the change set, still open, gets its revision.
    expect((await revisionsOf((await requestTo("MOBILE")).id)).map(({ number }) => number)).toEqual([1, 2]);
  });

  it("gets only a notice when it ends while the update waits for its row", async () => {
    await pushReports(changesOf("breaking"));
    const fe = await requestTo("FE");
    await install.execute("contract.report", ciRun(), reportOf("payments-api", threeBreaking(), { pullRequest, head: "c".repeat(40) }));
    clock = new Date(clock.getTime() + 3 * 60 * 1000);

    // Another write holds the request's row while the update starts, and ends the request before it lets go.
    const holder = new pg.Client({ connectionString: install.databaseUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM requests WHERE id = $1 FOR UPDATE", [fe.id]);
      const applying = runDueUpdates(install, clock);
      await waitForAWaitingLock(holder);
      await holder.query("UPDATE requests SET state = 'withdrawn' WHERE id = $1", [fe.id]);
      await holder.query("COMMIT");
      await applying;
    } finally {
      await holder.end();
    }

    expect((await revisionsOf(fe.id)).map(({ number }) => number)).toEqual([1]);
    const thread = await threadOf(fe.id);
    expect(thread.map(({ body }) => body)).toEqual([expect.stringContaining(`${fe.key} is withdrawn, so its packet stays at revision 1.`)]);
    expect((await revisionsOf((await requestTo("MOBILE")).id)).map(({ number }) => number)).toEqual([1, 2]);
  });
});

/** Waits until a session of the database waits for a lock, such as the update for a row another write holds. */
async function waitForAWaitingLock(client: pg.Client): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    const { rows } = await client.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await sleep(50);
  }
  throw new Error("No session waited for a lock within 15 seconds.");
}
