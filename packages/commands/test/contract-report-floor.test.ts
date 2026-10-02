import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { PROBLEM_TYPE_BASE } from "@tiehall/core";
import { createRestHandler, type CiCaller, type Caller, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, sessionOf, tokenOf } from "./support/requests.ts";

// contract.report has its own version floor (public-api: `contract.report` has
// its own version floor; public-api: The CLI sends its version and the server
// keeps a minimum; contract-changes: The Action fails open; design.md, Design
// rules: Public API). Companies' CI runs the CLI version the contract Action
// pins, so contract.report holds the CLI to a floor of its own, which is never
// above the install's general minimum and is raised only with 180 days'
// notice: a pinned CLI that the general minimum has left behind keeps
// reporting while it is not below the floor, and one below the floor gets 400
// with the problem type upgrade-required, and the report is not recorded.
// Every other operation keeps the general minimum. The minimums are the
// install's own; these tests give the route others, so that a CLI can sit
// between them.

/** The general minimum and the floor these tests run with. */
const MINIMUMS = { general: "0.5.0", contractReport: "0.2.0" };

let install: TestInstall;
let ci: CiCaller;
let lee: Caller;

beforeAll(async () => {
  install = await startTestInstall();
  const ada: WebSessionCaller = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  lee = tokenOf(await addUser(install.owner, { login: "lee" }));
  const pay = await addTeam(install.owner, "PAY");
  const { accountId } = await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] });
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
  ci = { kind: "ci", repositoryId: "7001", repositoryOwnerId: String(accountId), jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main" };
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("DELETE FROM contract_reports");
});

/** Calls the route as the caller, from a CLI of this version, with these minimums. */
async function call(caller: Caller, version: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const route = createRestHandler({ catalog: CATALOG, document: OPENAPI_JSON, execute: install.execute, authenticate: async () => caller, logger: install.logger, cliMinimums: MINIMUMS });
  const response = await route(
    new Request(`${URL_OF_INSTALL}${path}`, {
      method,
      headers: { "tiehall-cli-version": version, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const report = {
  api: "payments-api",
  pullRequest: { number: 310 },
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "new-payment-fields", sha: "b".repeat(40) },
  engine: { name: "oasdiff", version: "1.32.1" },
  changes: [{ id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" }],
};

async function storedReports(): Promise<number> {
  return (await install.owner.query("SELECT count(*)::int AS n FROM contract_reports")).rows[0].n;
}

describe("a pinned CLI", () => {
  it("above the floor but below the general minimum keeps reporting, while the general minimum refuses it everywhere else", async () => {
    expect(await call(ci, "0.3.0", "POST", "/api/v1/contract-reports", report)).toMatchObject({ status: 200, body: { api: "payments-api" } });
    expect(await storedReports()).toBe(1);

    const elsewhere = await call(lee, "0.3.0", "GET", "/api/v1/whoami");
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}upgrade-required` });
  });

  it("at the floor keeps reporting", async () => {
    expect((await call(ci, "0.2.0", "POST", "/api/v1/contract-reports", report)).status).toBe(200);
  });

  it("below the floor gets 400 upgrade-required, which says to raise the pinned version, and the report is not recorded", async () => {
    const answer = await call(ci, "0.1.9", "POST", "/api/v1/contract-reports", report);

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}upgrade-required`, detail: expect.stringContaining("the contract Action pins") });
    expect(await storedReports()).toBe(0);
  });
});
