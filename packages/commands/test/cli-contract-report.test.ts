import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { createActionsOidc, type ActionsOidc } from "@tiehall/testing/oidc";
import { createAgentTokenCheck, createApiCallerCheck, createCiTokenCheck, createRestHandler } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import type { TiehallCli } from "./support/cli.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, sessionOf } from "./support/requests.ts";

// tiehall contract report against the install (agent-surfaces: CLI contract
// and hook commands; contract-changes: One report operation that never takes
// a whole spec; contract-changes: Admins register APIs, each bound to one
// repository; agent-access: CI authenticates with GitHub Actions OIDC bound to
// registered repositories). The CLI runs in this process as the contract
// Action runs it in a provider's CI, with the GitHub Actions event of a pull
// request, an oasdiff changelog, and GitHub Actions' token service, played
// here by a test issuer, which gives the run a fixture OIDC token for the
// audience the CLI asks for. The install checks that token against the test
// issuer's keys, which stand in for GitHub Actions', through the real REST
// route and contract.report, and stores the report the CLI sent.

const TOKEN_SERVICE = "https://pipelines.actions.example.net/oidc/token?api-version=2.0";
const CONTRACT_WORKFLOW_FILE = "acme/payments/.github/workflows/contract.yml";
const CONTRACT_WORKFLOW = `${CONTRACT_WORKFLOW_FILE}@refs/heads/main`;

let install: TestInstall;
let oidc: ActionsOidc;
let acmeId: number;
let scratch: string;
let changelog: string;
let event: string;
/** The workflow the run belongs to, as its token names it. */
let workflow = CONTRACT_WORKFLOW;
/** The audiences the run asked GitHub Actions' token service for. */
const asked: string[] = [];

beforeAll(async () => {
  install = await startTestInstall();
  oidc = createActionsOidc();
  const ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  const pay = await addTeam(install.owner, "PAY");
  ({ accountId: acmeId } = await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] }));
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments", workflow: CONTRACT_WORKFLOW_FILE })).status).toBe(200);
  scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-report-"));
  changelog = join(scratch, "changelog.json");
  writeFileSync(
    changelog,
    JSON.stringify([
      { id: "request-parameter-became-required", text: "the `query` request parameter `currency` became required", level: 3, operation: "POST", path: "/payments", section: "paths" },
      { id: "endpoint-added", text: "endpoint added", level: 1, operation: "GET", path: "/refunds", section: "paths" },
    ]),
  );
  event = join(scratch, "event.json");
  writeFileSync(event, JSON.stringify({ number: 310, pull_request: { number: 310, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "new-payment-fields", sha: "b".repeat(40) } } }));
}, 60_000);

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await install?.close();
});

beforeEach(async () => {
  workflow = CONTRACT_WORKFLOW;
  asked.length = 0;
  await install.owner.query("DELETE FROM contract_reports");
});

/** The REST route of the install as the web role builds it, with the test issuer's keys in place of GitHub Actions'. */
const route = () =>
  createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute: install.execute,
    authenticate: createApiCallerCheck({
      agent: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db }),
      ci: createCiTokenCheck({ url: URL_OF_INSTALL, database: install.db, keys: async () => oidc.jwks }),
    }),
    logger: install.logger,
  });

/** Runs `tiehall contract report` in a GitHub Actions job of acme/payments, with this audience asked of the token service unless told. */
async function runInActions(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cli = (await import("tiehall")) as unknown as TiehallCli;
  let stdout = "";
  let stderr = "";
  const rest = route();
  const code = await cli.run({
    argv: ["contract", "report", ...args],
    env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: event, ACTIONS_ID_TOKEN_REQUEST_URL: TOKEN_SERVICE, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.origin === new URL(TOKEN_SERVICE).origin) {
        // GitHub Actions' token service: a token for the audience the run asks for, for a run of this workflow.
        if (request.headers.get("authorization") !== "Bearer request-token-1") return new Response("", { status: 401 });
        const audience = url.searchParams.get("audience") ?? "";
        asked.push(audience);
        return Response.json({ value: oidc.token({ audience, repository: "acme/payments", repositoryId: 7001, repositoryOwnerId: acmeId, jobWorkflowRef: workflow }) });
      }
      if (url.origin === URL_OF_INSTALL) return rest(request);
      throw new TypeError(`fetch failed: ${url.origin} cannot be reached`);
    },
  });
  return { code, stdout, stderr };
}

describe("tiehall contract report, run as the contract Action runs it", () => {
  it("reports the pull request's classified changes to the install with the run's OIDC token for its URL, and the install stores them", async () => {
    const result = await runInActions(["--install", URL_OF_INSTALL, "--api", "payments-api", "--changes", changelog, "--engine-version", "1.32.1"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(asked).toEqual([URL_OF_INSTALL]);
    expect(result.stdout).toMatch(/^Reported 2 classified changes of payments-api in pull request #310 to https:\/\/tiehall\.example\.com: 1 breaking, 0 potentially breaking and 1 informational\. Tiehall took it as report [0-9a-f-]{36}\.\n$/);
    const { rows } = await install.owner.query("SELECT pull_request_number, base_sha, head_ref, engine_name, engine_version, changes, job_workflow_ref FROM contract_reports");
    expect(rows).toEqual([
      {
        pull_request_number: 310,
        base_sha: "a".repeat(40),
        head_ref: "new-payment-fields",
        engine_name: "oasdiff",
        engine_version: "1.32.1",
        changes: [
          { id: "request-parameter-became-required", level: "ERR", operation: "POST /payments" },
          { id: "endpoint-added", level: "INFO", operation: "GET /refunds" },
        ],
        job_workflow_ref: CONTRACT_WORKFLOW,
      },
    ]);
  });

  it("prints the install's refusal of a run of another workflow than the API's, exits with 1, and nothing is stored", async () => {
    workflow = "acme/payments/.github/workflows/nightly.yml@refs/heads/main";

    const result = await runInActions(["--install", URL_OF_INSTALL, "--api", "payments-api", "--changes", changelog, "--engine-version", "1.32.1"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^Not allowed for a CI caller: This CI run may not report for that API/);
    expect((await install.owner.query("SELECT count(*)::int AS n FROM contract_reports")).rows[0].n).toBe(0);
  });

});
