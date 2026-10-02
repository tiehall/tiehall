import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { PROBLEM_TYPE_BASE } from "@tiehall/core";
import { createActionsOidc, type ActionsOidc, type ActionsRun } from "@tiehall/testing/oidc";
import { createAgentTokenCheck, createApiCallerCheck, createCiTokenCheck, createRestHandler, type CiCaller, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, sessionOf, tokenOf } from "./support/requests.ts";

// One report operation that never takes a whole spec (contract-changes: One
// report operation that never takes a whole spec; contract-changes: Admins
// register APIs, each bound to one repository; agent-access: CI authenticates
// with GitHub Actions OIDC bound to registered repositories; agent-access:
// OAuth scopes are coarse; public-api: Each operation carries a stability
// level; design.md, Design rules: Contract changes). contract.report is the
// one way contract changes reach Tiehall: a CI run of the contract Action
// reports, for a registered API, the provider pull request, the base and head
// refs with their commit SHAs, the diff engine's name and version, and the
// engine's classified changes, each with its engine id, its level and its
// operation. Its input schema is strict: it has no field for an OpenAPI
// document, and a body with any field it does not know is refused with 400.
// It accepts the CI caller alone, for the APIs registered to its repository,
// and stores each report it accepts, for routing. It is offered on REST and
// the CLI, and is stable from its first release.

let install: TestInstall;
let oidc: ActionsOidc;
let ada: WebSessionCaller;
let danaId: string;
let acmeId: number;
let paymentsApi: string;

const CONTRACT_WORKFLOW = "acme/payments/.github/workflows/contract.yml@refs/heads/main";

/** A CI run in acme/payments, as its token names it. */
const paymentsRun = (run: Partial<ActionsRun> = {}): ActionsRun => ({
  audience: URL_OF_INSTALL,
  repository: "acme/payments",
  repositoryId: 7001,
  repositoryOwnerId: acmeId,
  jobWorkflowRef: CONTRACT_WORKFLOW,
  ...run,
});

/** The same run, as the CI caller its token stands for. */
const paymentsCaller = (): CiCaller => ({ kind: "ci", repositoryId: "7001", repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW });

/** A report of PR #310 with two ERR-level changes and one INFO-level change. */
function reportOf(changes: unknown[] = CHANGES, api = "payments-api"): Record<string, unknown> {
  return {
    api,
    pullRequest: { number: 310 },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { ref: "new-payment-fields", sha: "b".repeat(40) },
    engine: { name: "oasdiff", version: "1.32.1" },
    changes,
  };
}

/**
 * A job_workflow_ref of 1,012 characters, under the 1,024 the token check
 * accepts, whose workflow file name is 960 CJK characters picked by a fixed
 * xorshift sequence: about 2.9 KB in UTF-8 that do not compress.
 */
function longWorkflowRef(): string {
  let state = 0x2545f491;
  const name = Array.from({ length: 960 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return String.fromCodePoint(0x4e00 + ((state >>> 0) % 0x5000));
  }).join("");
  return `acme/payments/.github/workflows/${name}.yml@refs/heads/main`;
}

const CHANGES = [
  { id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" },
  { id: "request-parameter-became-required", level: "ERR", operation: "POST /payments" },
  { id: "endpoint-added", level: "INFO", operation: "GET /refunds" },
];

/** The REST route of the install as the web role builds it, with the test issuer's keys in place of GitHub Actions'. */
function api(): (request: Request) => Promise<Response> {
  return createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute: install.execute,
    authenticate: createApiCallerCheck({
      agent: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db }),
      ci: createCiTokenCheck({ url: URL_OF_INSTALL, database: install.db, keys: async () => oidc.jwks }),
    }),
    logger: install.logger,
  });
}

/** Sends a report with the token, as the contract Action's CLI does, with the headers given. */
async function report(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const { method = "POST", path = "" } = CATALOG.get("contract.report") ?? {};
  const response = await api()(
    new Request(`${URL_OF_INSTALL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** The stored reports. */
async function stored(): Promise<Record<string, unknown>[]> {
  const { rows } = await install.owner.query(
    `SELECT api_id, pull_request_number, base_ref, base_sha, head_ref, head_sha, engine_name, engine_version, changes,
            repository_id::text AS repository_id, repository_owner_id::text AS repository_owner_id, job_workflow_ref
       FROM contract_reports ORDER BY received_at`,
  );
  return rows;
}

beforeAll(async () => {
  install = await startTestInstall();
  oidc = createActionsOidc();
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  danaId = await addUser(install.owner, { role: "member", login: "dana" });
  const pay = await addTeam(install.owner, "PAY");
  await joinTeams(install.owner, danaId, pay);
  ({ accountId: acmeId } = await addInstallation(install.owner, {
    account: "acme",
    repositories: [
      { fullName: "acme/payments", id: 7001 },
      { fullName: "acme/web", id: 7002 },
    ],
  }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
  expect(
    (await install.confirm(ada, "apis.register", { name: "billing-api", team: pay, repository: "acme/payments", jobWorkflowRef: CONTRACT_WORKFLOW })).status,
  ).toBe(200);
  paymentsApi = (await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'")).rows[0]?.id ?? "";
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("DELETE FROM contract_reports");
});

describe("a contract report", () => {
  it("from a CI run in the registered repository is accepted through the real operation and stored for routing", async () => {
    const answer = await report(oidc.token(paymentsRun()), reportOf());

    expect(answer.status).toBe(200);
    // The install has no GitHub App to read the pull request's author through, so the provider team requests the changes.
    expect(answer.body).toEqual({ id: expect.any(String), api: "payments-api", receivedAt: expect.any(String), requester: { kind: "team", team: "PAY" } });
    expect(await stored()).toEqual([
      {
        api_id: paymentsApi,
        pull_request_number: 310,
        base_ref: "main",
        base_sha: "a".repeat(40),
        head_ref: "new-payment-fields",
        head_sha: "b".repeat(40),
        engine_name: "oasdiff",
        engine_version: "1.32.1",
        changes: CHANGES,
        repository_id: "7001",
        repository_owner_id: String(acmeId),
        job_workflow_ref: CONTRACT_WORKFLOW,
      },
    ]);
  });

  it.each([
    ["a run in another repository", { repository: "acme/web", repositoryId: 7002 }, "payments-api"],
    ["another workflow of a bound API's repository", { jobWorkflowRef: "acme/payments/.github/workflows/nightly.yml@refs/heads/main" }, "billing-api"],
    ["a run for an API that is not registered", {}, "ledger-api"],
  ])("from %s is refused with 403 and stores nothing", async (_case, run, apiName) => {
    const answer = await report(oidc.token(paymentsRun(run)), reportOf(CHANGES, apiName));

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}ci-caller-refused` });
    expect(await stored()).toEqual([]);
  });

  it("from a CI run in a repository no API is registered to is refused with 403 before its body is judged, whatever it holds", async () => {
    // Any GitHub user can have a workflow of their own ask for a token whose audience is the install's URL.
    const stranger = oidc.token({ audience: URL_OF_INSTALL, repository: "mallory/anything", repositoryId: 9_999_001, repositoryOwnerId: 9_999_000 });

    // 100,000 empty changes: a body of 0.29 MiB, far under the limit, that fails the schema 300,000 times.
    const answer = await report(stranger, reportOf(Array.from({ length: 100_000 }, () => ({}))));

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}ci-caller-refused` });
    expect(await stored()).toEqual([]);
  }, 60_000);

  it("repeated with its Idempotency-Key gets the first answer, but not from another workflow of a bound API's repository", async () => {
    const body = reportOf(CHANGES, "billing-api");
    const key = { "idempotency-key": "contract-run-9100200300" };
    const first = await report(oidc.token(paymentsRun()), body, key);
    expect(first.status).toBe(200);

    expect(await report(oidc.token(paymentsRun()), body, key)).toEqual(first);
    const nightly = await report(oidc.token(paymentsRun({ jobWorkflowRef: "acme/payments/.github/workflows/nightly.yml@refs/heads/main" })), body, key);

    expect(nightly.status).toBe(403);
    expect(nightly.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}ci-caller-refused` });
    expect(await stored()).toHaveLength(1);
  });

  it("repeated with its Idempotency-Key from a workflow whose ref is as long as a token may name gets the first answer", async () => {
    const jobWorkflowRef = longWorkflowRef();
    // Within the token check's 1,024 characters, but more bytes than a Postgres index entry holds.
    expect(jobWorkflowRef.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(jobWorkflowRef)).toBeGreaterThan(2800);
    const key = { "idempotency-key": "contract-run-9100200301" };

    const first = await report(oidc.token(paymentsRun({ jobWorkflowRef })), reportOf(), key);
    expect(first.status).toBe(200);

    expect(await report(oidc.token(paymentsRun({ jobWorkflowRef })), reportOf(), key)).toEqual(first);
    expect(await stored()).toEqual([expect.objectContaining({ job_workflow_ref: jobWorkflowRef })]);
  });

  it("with a token for another audience, or a replayed one, is refused with 401 invalid_token and stores nothing more", async () => {
    expect((await report(oidc.token(paymentsRun({ audience: "https://tiehall.other.example" })), reportOf())).status).toBe(401);
    const token = oidc.token(paymentsRun());
    expect((await report(token, reportOf())).status).toBe(200);

    const replayed = await report(token, reportOf());

    expect(replayed).toMatchObject({ status: 401, body: { type: `${PROBLEM_TYPE_BASE}invalid-token` } });
    expect(await stored()).toHaveLength(1);
  });

  it("from a CI run is accepted while the admin has switched personal access tokens off, which applies to no CI caller", async () => {
    await install.owner.query("DELETE FROM install_settings");
    await install.owner.query("INSERT INTO install_settings (org_id, personal_access_tokens_on) SELECT id, false FROM orgs");
    try {
      // A member's token is refused while the switch is off.
      const member = await callApi(install, { ...tokenOf(danaId), scopes: ["requests:read", "requests:write", "contracts:report"] }, "POST", "/api/v1/contract-reports", reportOf());
      expect(member.body).toMatchObject({ status: 403, type: `${PROBLEM_TYPE_BASE}personal-access-tokens-off` });

      expect((await report(oidc.token(paymentsRun()), reportOf())).status).toBe(200);
      expect(await stored()).toHaveLength(1);
    } finally {
      await install.owner.query("DELETE FROM install_settings");
    }
  });

  it("from a member's personal access token or OAuth token, whatever scopes it carries, is refused with 403 and stores nothing", async () => {
    const allScopes = ["requests:read", "requests:write", "contracts:report"] as const;
    for (const caller of [
      { ...tokenOf(danaId), scopes: allScopes },
      { ...oauthTokenOf(danaId, "https://agent.example.net/client.json", "api"), scopes: allScopes },
    ]) {
      const answer = await callApi(install, caller, "POST", "/api/v1/contract-reports", reportOf());
      expect(answer.status, caller.kind).toBe(403);
    }
    expect(await stored()).toEqual([]);
  });

  it.each([
    ["a field that holds an OpenAPI document", { ...reportOf(), spec: { openapi: "3.1.0", paths: {} } }],
    ["any field it does not know", { ...reportOf(), comment: "Breaking for the web team." }],
    ["a change without its level", reportOf([{ id: "response-property-removed", operation: "GET /payments/{id}" }])],
    ["a change at a level the engine does not give", reportOf([{ id: "response-property-removed", level: "ERROR", operation: "GET /payments/{id}" }])],
    ["a change without its operation", reportOf([{ id: "response-property-removed", level: "ERR" }])],
    ["a change with a field it does not know", reportOf([{ ...CHANGES[0], text: "removed the property 'amount'" }])],
    ["a commit SHA that is not one", { ...reportOf(), head: { ref: "new-payment-fields", sha: "HEAD" } }],
    ["no engine version", { ...reportOf(), engine: { name: "oasdiff" } }],
  ])("with %s is refused with 400 and stores nothing", async (_case, body) => {
    const answer = await callApi(install, paymentsCaller(), "POST", "/api/v1/contract-reports", body);

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}invalid-input` });
    expect(await stored()).toEqual([]);
  });

  it("with more changes than a report holds is refused with 400 that names the list, and stays small whatever the body holds", async () => {
    // 100,000 empty changes: a body of 0.29 MiB, far under the limit, that would fail the schema 300,000 times.
    const response = await api()(
      new Request(`${URL_OF_INSTALL}/api/v1/contract-reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${oidc.token(paymentsRun())}`, "content-type": "application/json" },
        body: JSON.stringify(reportOf(Array.from({ length: 100_000 }, () => ({})))),
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text.length).toBeLessThan(1024 * 1024);
    expect(JSON.parse(text)).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}invalid-input`,
      errors: [{ path: ["changes"], message: "Too big: expected array to have <=1000 items" }],
    });
    expect(await stored()).toEqual([]);
  }, 60_000);

  it("with as many changes as a report holds, each failing the schema, is refused with 400 that names at most 100 places", async () => {
    const answer = await callApi(install, paymentsCaller(), "POST", "/api/v1/contract-reports", reportOf(Array.from({ length: 1000 }, () => ({}))));

    expect(answer.status).toBe(400);
    expect(answer.body.errors).toHaveLength(100);
    expect(await stored()).toEqual([]);
  });

  it.each([
    ["a NUL character in a ref", { ...reportOf(), base: { ref: "main\u0000", sha: "a".repeat(40) } }],
    ["a NUL character in the engine's name", { ...reportOf(), engine: { name: "oasdiff\u0000", version: "1.32.1" } }],
    ["a NUL character in a change's operation", reportOf([{ id: "response-property-removed", level: "ERR", operation: "GET /payments\u0000" }])],
    ["a lone surrogate in a change's operation", reportOf([{ id: "response-property-removed", level: "ERR", operation: "GET /pay\ud800ments" }])],
    ["a lone low surrogate in a change's id", reportOf([{ id: "\udc00removed", level: "ERR", operation: "GET /payments" }])],
  ])("with text that cannot be stored, %s, is refused with 400 and stores nothing", async (_case, body) => {
    const answer = await callApi(install, paymentsCaller(), "POST", "/api/v1/contract-reports", body);

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}invalid-input` });
    expect(await stored()).toEqual([]);
  });

  it("keeps text with characters beyond the Basic Multilingual Plane exactly as sent", async () => {
    const changes = [{ id: "response-property-removed", level: "ERR", operation: "GET /payments/{id} \u{1F4B8}" }];

    expect((await callApi(install, paymentsCaller(), "POST", "/api/v1/contract-reports", reportOf(changes))).status).toBe(200);
    expect(await stored()).toEqual([expect.objectContaining({ changes })]);
  });

  it("with no change at all is accepted, since a fix can remove every breaking change", async () => {
    const answer = await callApi(install, paymentsCaller(), "POST", "/api/v1/contract-reports", reportOf([]));
    expect(answer.status).toBe(200);
    expect(await stored()).toEqual([expect.objectContaining({ changes: [] })]);
  });
});

describe("the published operation", () => {
  const document = JSON.parse(OPENAPI_JSON) as { paths: Record<string, Record<string, Record<string, any>>> };
  const operation = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .find(({ operationId }) => operationId === "contract.report");

  it("is stable, at POST /api/v1/contract-reports, on REST and the CLI's contract report", () => {
    expect(document.paths["/api/v1/contract-reports"]?.["post"]).toBe(operation);
    expect(operation?.["x-stability-level"]).toBe("stable");
    expect(operation?.["x-tiehall-cli"]).toEqual({ commands: [{ command: "contract report" }] });
    expect(CATALOG.get("contract.report")?.surfaces).toEqual(["rest", "cli"]);
  });

  it("lists 502, which a CI run gets when GitHub Actions' keys cannot be read, as no other operation does but requests.link_pr, which reads the pull request from GitHub", () => {
    expect(operation?.["responses"]["502"]).toMatchObject({
      description: expect.stringContaining("GitHub Actions"),
      content: { "application/problem+json": { schema: expect.any(Object) } },
    });
    const others = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .filter(({ operationId, responses }) => operationId !== "contract.report" && responses?.["502"] !== undefined);
    expect(others.map(({ operationId }) => operationId)).toEqual(["requests.link_pr"]);
  });

  it("has no field for a spec: its input is the API, the pull request, the refs, the engine and the classified changes, and nothing more", () => {
    const schema = operation?.["requestBody"].content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(["api", "base", "changes", "engine", "head", "pullRequest"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.changes.items.properties).sort()).toEqual(["id", "level", "operation"]);
    expect(schema.properties.changes.items.additionalProperties).toBe(false);
  });
});
