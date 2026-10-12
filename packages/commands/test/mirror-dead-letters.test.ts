import { setTimeout as sleep } from "node:timers/promises";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLogger,
  createMirrorRetryRoute,
  MIRROR_RETRY_PATH,
  mirrorRequest,
  mirrorRequests,
  startWorker,
  type Banner,
  type WebSessionCaller,
  type Worker,
} from "../src/index.ts";
import { providerOnStub } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// A failing mirror job through the real job queue and worker
// (tracker-mirrors: Failed mirror jobs are shown with a Retry button; design.md,
// Technical decisions: T6). GitHub refuses to create the mirror issue of a
// claimed request: the job is tried again 4 times, each 14 minutes after the
// attempt before failed, so its fifth attempt comes between 50 and 70 minutes
// after the first, and when that one fails too, the job moves to the
// dead-letter queue, which the worker works to show it as a banner. The test
// does not wait the 14 minutes: it reads when the queue would run each next
// attempt, then lets it run at once. A change of the request made after does
// not wait behind the failed job (decisions-from-groups-15-28: design.md,
// Decisions this change rests on: D55 (76)): its newer job runs at once and
// takes the failed one out of the queue, and the banner stays while the newer
// job fails and goes once it succeeds, showing the request as it is then.
// Without a change, Retry runs the failed job again once GitHub works, which
// creates the issue, and the banner goes.

let install: TestInstall;
let stub: GitHubStub;
let worker: Worker | undefined;
let ada: WebSessionCaller;
let ayse: WebSessionCaller;
let mo: WebSessionCaller;
let alice: string;
/** Whether GitHub refuses to create issues in acme/fe-intake. */
let refusing = true;
/** When GitHub refused each create, by the worker's clock. */
const refusals: number[] = [];

/** The fetch the worker reaches GitHub through: GitHub's own, but refusing to create an issue in acme/fe-intake while `refusing`. */
const flakyGitHub: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (refusing && method === "POST" && url.pathname === "/repos/acme/fe-intake/issues") {
    refusals.push(Date.now());
    return new Response(JSON.stringify({ message: "Server Error" }), { status: 502, headers: { "content-type": "application/json" } });
  }
  return fetch(input, init);
};

beforeAll(async () => {
  install = await startTestInstall({ jobTypes: [mirrorRequest] });
  stub = await startGitHubStub();
  const provider = await providerOnStub(install, stub, ["ayse"], { repositories: ["acme/fe-intake"] });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  ayse = sessionOf(await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") }));
  mo = sessionOf(await addUser(install.owner, { login: "mo" }));
  alice = await addUser(install.owner, { login: "alice" });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const mobile = await addTeam(install.owner, "MOBILE");
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse.userId, fe);
  await joinTeams(install.owner, mo.userId, mobile);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  worker = await startWorker({
    connection: { connectionString: install.appDatabase.url, password: install.appDatabase.password },
    jobs: [mirrorRequests],
    secrets: () => install.box,
    github: { apiUrl: stub.apiUrl, fetch: flakyGitHub },
    installUrl: URL_OF_INSTALL,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 1000,
    logger: createLogger({ write: () => {} }),
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await stub?.close();
  await install?.close();
}, 60_000);

async function until<T>(what: string, check: () => Promise<T | undefined>, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The request's mirror job in the queue, as pg-boss holds it: its id, state, attempts so far, and when it may run next. */
async function mirrorJobOf(requestId: string, state: string): Promise<{ id: string; retry_count: number; start_after: Date } | undefined> {
  const { rows } = await install.owner.query<{ id: string; retry_count: number; start_after: Date }>(
    "SELECT id, retry_count, start_after FROM pgboss.job WHERE name = $1 AND singleton_key = $2 AND state::text = $3",
    [mirrorRequest.queue, requestId, state],
  );
  return rows[0];
}

async function deadLettered(requestId: string): Promise<number> {
  const { rows } = await install.owner.query("SELECT id FROM pgboss.job WHERE name = $1 AND data ->> 'requestId' = $2", [mirrorRequest.deadLetterQueue, requestId]);
  return rows.length;
}

async function bannersOf(session: WebSessionCaller): Promise<Banner[]> {
  return ((await install.execute("install.get_banners", session, {}, { readOnly: true })) as { banners: Banner[] }).banners;
}

/**
 * Lets the request's mirror job fail until it reaches the dead-letter queue,
 * running each next attempt at once rather than in 14 minutes; returns how
 * long the queue would have waited before the attempts after the first.
 */
async function failUntilDeadLettered(requestId: string): Promise<number> {
  const from = refusals.length;
  let scheduled = 0;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const retry = await until(`attempt ${attempt} to fail`, async () => {
      const job = await mirrorJobOf(requestId, "retry");
      return job?.retry_count === attempt - 1 ? job : undefined;
    });
    expect(refusals).toHaveLength(from + attempt);
    const wait = retry.start_after.getTime() - refusals[from + attempt - 1]!;
    expect(wait).toBeGreaterThanOrEqual(14 * 60_000 - 5_000);
    expect(wait).toBeLessThanOrEqual(14 * 60_000 + 5_000);
    scheduled += wait;
    // Not in the dead-letter queue yet: it is tried again.
    expect(await deadLettered(requestId)).toBe(0);
    // The test lets the next attempt run now rather than in 14 minutes.
    await install.owner.query("UPDATE pgboss.job SET start_after = now() WHERE id = $1", [retry.id]);
    await until(`attempt ${attempt + 1} to fail`, async () => (refusals.length === from + attempt + 1 ? true : undefined));
  }
  await until("the fifth attempt to fail", () => mirrorJobOf(requestId, "failed"));
  expect(refusals).toHaveLength(from + 5);
  await until("the job to reach the dead-letter queue", async () => ((await deadLettered(requestId)) === 1 ? true : undefined));
  return scheduled;
}

/** The request's mirror issue in acme/fe-intake, once it carries the label of this state. */
async function issueShowing(requestId: string, state: string) {
  return until(`the issue to show ${state}`, async () => {
    const { rows } = await install.owner.query<{ issue: string | null }>("SELECT issue FROM mirrors WHERE request_id = $1", [requestId]);
    const number = rows[0]?.issue;
    if (number === null || number === undefined) return undefined;
    const found = stub.issue("acme/fe-intake", Number(number));
    return found.labels.includes(`tiehall:${state}`) ? found : undefined;
  });
}

describe("a mirror job GitHub keeps failing", () => {
  let request: { key: string; id: string };

  it("is tried again 4 times, 14 minutes after each failure, and moves to the dead-letter queue when its fifth attempt fails, between 50 and 70 minutes after the first", async () => {
    request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", ayse, { key: request.key });

    const scheduled = await failUntilDeadLettered(request.id);

    // Without the test's hurry, the fifth attempt would have come after the 4 waits and the 4 attempts before it, each of which
    // took well under a second here: between 50 and 70 minutes after the first.
    expect(scheduled).toBeGreaterThanOrEqual(50 * 60_000);
    expect(scheduled + 4 * 1000).toBeLessThanOrEqual(70 * 60_000);
  }, 120_000);

  it("is shown as a banner with a Retry button to the admins and the members of FE, and not to a member of MOBILE", async () => {
    const shown = await until("the banner", async () => {
      const banners = await bannersOf(ayse);
      return banners.length > 0 ? banners : undefined;
    });
    expect(shown.map(({ id, button }) => ({ id, button }))).toEqual([
      { id: `mirror_failed:${request.id}`, button: { label: "Retry", action: MIRROR_RETRY_PATH, fields: { requestId: request.id } } },
    ]);
    expect(await bannersOf(ada)).toHaveLength(1);
    expect(await bannersOf(mo)).toEqual([]);
  }, 60_000);

  it("does not hold back the request's later changes: a newer job runs without Retry, and its banner stays while it fails and goes once it succeeds", async () => {
    // A change made after the job failed sends a newer job, which runs at once, without anyone pressing Retry, and takes the
    // failed one out of the queue.
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await until("the newer job to run", async () => (refusals.length === 6 ? true : undefined));
    expect(await mirrorJobOf(request.id, "failed")).toBeUndefined();
    const retry = await until("the newer job to wait for its next attempt", () => mirrorJobOf(request.id, "retry"));
    // GitHub still refuses it: the banner stays.
    expect(await bannersOf(ada)).toHaveLength(1);
    expect(await bannersOf(ayse)).toHaveLength(1);

    // GitHub works again, and the newer job's next attempt makes the issue, showing the request as it is now.
    refusing = false;
    await install.owner.query("UPDATE pgboss.job SET start_after = now() WHERE id = $1", [retry.id]);
    const issue = await issueShowing(request.id, "in_progress");
    expect(issue.labels).not.toContain("tiehall:claimed");
    await until("the banner to go", async () => ((await bannersOf(ada)).length === 0 ? true : undefined));
    expect(await bannersOf(ayse)).toEqual([]);
    // The failed job never ran again, and its dead letter is no longer in the queue.
    expect(refusals).toHaveLength(6);
    expect(await mirrorJobOf(request.id, "failed")).toBeUndefined();
    expect(await deadLettered(request.id)).toBe(1);
  }, 60_000);

  it("with no change since, runs again when Retry is pressed after a fix, and its banner goes", async () => {
    refusing = true;
    const other = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE" });
    await install.execute("requests.claim", ayse, { key: other.key });
    await failUntilDeadLettered(other.id);
    await until("the banner", async () => ((await bannersOf(ayse)).some(({ id }) => id === `mirror_failed:${other.id}`) ? true : undefined));

    refusing = false;
    const route = createMirrorRetryRoute({ execute: install.execute, session: async () => ayse, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const answer = await route(
      new Request(`${URL_OF_INSTALL}${MIRROR_RETRY_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ csrf: install.fromThePage(ayse).csrfToken ?? "", requestId: other.id, back: "/" }).toString(),
      }),
    );
    expect(answer.status).toBe(303);

    await until("the banner to go", async () => ((await bannersOf(ada)).length === 0 ? true : undefined));
    expect(await bannersOf(ayse)).toEqual([]);
    // The retried job made the issue.
    await issueShowing(other.id, "claimed");
    expect(await mirrorJobOf(other.id, "failed")).toBeUndefined();
  }, 120_000);
});
