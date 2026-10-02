import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "@tiehall/catalog";
import { PROBLEM_TYPE_BASE } from "@tiehall/core";
import type { Caller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, packetOf, tokenOf } from "./support/requests.ts";

// Request bodies have a size limit (public-api: Request bodies have a size
// limit; public-api: One error model for Tiehall's own refusals;
// contract-changes: One report operation that never takes a whole spec),
// through the real REST route and execute(). A body may be 2 MiB, 2,097,152
// bytes, and one byte more is answered 413 with the problem type
// payload-too-large, whose detail names the limit, before the body is parsed:
// nothing runs, nothing changes, no event is appended and no Idempotency-Key is
// kept. A contract.report body may be 16 MiB. The bodies here are valid JSON
// padded with spaces to the size a case needs, so only their size is judged.

const MiB = 1024 * 1024;

// Each case sends bodies of several MiB through the route and the database, and
// the contract report's cases send 10 and 17 MiB: a timeout that holds on a
// slower CI runner, not the project's default of 5 seconds.
const LARGE_BODIES = { timeout: 30_000 };

let install: TestInstall;
let alice: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  await joinTeams(install.owner, alice, be);
});

afterAll(async () => {
  await install.close();
});

/** This JSON value as a body of exactly this many bytes, padded with spaces after it. */
function bodyOf(value: unknown, bytes: number): string {
  const json = JSON.stringify(value);
  const length = Buffer.byteLength(json);
  if (length > bytes) throw new Error(`The JSON is ${length} bytes, more than ${bytes}.`);
  return json + " ".repeat(bytes - length);
}

/** Sends this body as the caller, with these headers besides its JSON content type. */
async function send(caller: Caller, method: string, path: string, body: string, headers: Record<string, string> = {}) {
  const response = await install.api(caller)(
    new Request(`${URL_OF_INSTALL}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body }),
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

/** The install's requests, events, kept Idempotency-Keys and contract reports, which a body over the limit leaves as they were. */
async function counts(): Promise<unknown> {
  const { rows } = await install.owner.query(
    `SELECT (SELECT count(*) FROM requests) AS requests,
            (SELECT count(*) FROM packet_revisions) AS revisions,
            (SELECT count(*) FROM events) AS events,
            (SELECT count(*) FROM idempotency_keys) AS idempotency_keys,
            (SELECT count(*) FROM contract_reports) AS contract_reports`,
  );
  return rows[0];
}

describe("a packet revision at the limit", LARGE_BODIES, () => {
  it("is not refused for its size at exactly 2 MiB, and one byte more gets 413 and adds nothing", async () => {
    const opened = await openRequestInTheWebUi<{ key: string }>(install, alice, { targetTeam: "FE" });
    const path = `/api/v1/requests/${opened.key}/packet/revisions`;
    const packet = { ...packetOf(), untrusted: { need: "Add a dark mode to the settings page.", acceptance_criteria: ["The toggle is on the settings page."] } };

    const exact = await send(tokenOf(alice), "POST", path, bodyOf({ packet }, 2 * MiB), { "if-match": '"1"' });
    expect(exact.status).toBe(200);
    expect(exact.body).toMatchObject({ revision: 2 });

    const before = await counts();
    const over = await send(tokenOf(alice), "POST", path, bodyOf({ packet }, 2 * MiB + 1), {
      "if-match": '"2"',
      "idempotency-key": "revision-over-the-limit",
    });
    expect(over.status).toBe(413);
    expect(over.headers.get("content-type")).toBe("application/problem+json");
    expect(over.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}payload-too-large`, status: 413, detail: expect.stringContaining("2 MiB") });
    expect(await counts()).toEqual(before);
  });
});

// contract.report, which add-tiehall-oss-v1's task 22.5 defines, takes a body
// of up to 16 MiB, because it carries classified OpenAPI diffs, which can be
// large; a body under it reaches the operation's input validation.
describe("a contract report, whose limit is 16 MiB", LARGE_BODIES, () => {
  const ci: Caller = { kind: "ci", repositoryId: "100200300", repositoryOwnerId: "9919", jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main" };

  /** contract.report's method and path, from the catalog. */
  function reportOperation(): { method: string; path: string } {
    const report = CATALOG.get("contract.report");
    expect(report, "contract.report, which add-tiehall-oss-v1's task 22.5 defines").toBeDefined();
    return { method: report?.method ?? "", path: report?.path ?? "" };
  }

  it("is not refused for its size at 10 MiB, and reaches the operation's input validation", async () => {
    const { method, path } = reportOperation();
    const answer = await send(ci, method, path, bodyOf({}, 10 * MiB));
    expect(answer.status).not.toBe(413);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}invalid-input`, errors: expect.any(Array) });
  });

  it("gets 413 at 17 MiB, with a detail that names 16 MiB, and opens nothing", async () => {
    const { method, path } = reportOperation();
    const before = await counts();
    const answer = await send(ci, method, path, bodyOf({}, 17 * MiB));
    expect(answer.status).toBe(413);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}payload-too-large`, status: 413, detail: expect.stringContaining("16 MiB") });
    expect(await counts()).toEqual(before);
  });
});
