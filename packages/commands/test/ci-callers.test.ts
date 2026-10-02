import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand, OPENAPI_JSON } from "@tiehall/catalog";
import { PROBLEM_TYPE_BASE, Refusal } from "@tiehall/core";
import { createActionsOidc, GITHUB_ACTIONS_ISSUER, type ActionsOidc, type ActionsRun } from "@tiehall/testing/oidc";
import {
  createApiCallerCheck,
  createAgentTokenCheck,
  createCiTokenCheck,
  createExecute,
  createRestHandler,
  defineHandler,
  GITHUB_ACTIONS_JWKS_URL,
  pruneUsedCiTokens,
  reportableApi,
  type Caller,
  type CiTokenCheckOptions,
  type WebSessionCaller,
} from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, sessionOf } from "./support/requests.ts";

// The CI caller (agent-access: CI authenticates with GitHub Actions OIDC bound
// to registered repositories; agent-access: Six kinds of caller; public-api:
// One error model for Tiehall's own refusals; contract-changes: Admins
// register APIs, each bound to one repository; design.md, Decisions this
// change rests on: D28 #1, #44; D29 (7); design.md, Technical decisions: T7).
// A CI run presents its GitHub Actions OIDC token in the Authorization header,
// with no token exchange. Tiehall checks it against the issuer's keys: its
// issuer is GitHub Actions, its audience exactly the install's URL,
// TIEHALL_URL, it has not expired, and its jti was never seen before; any
// failure gets 401 invalid_token. The run may then report only for an API
// registered to the repository, and the repository's owner, that its token
// names, and, for an API bound to a workflow, only from a run of that
// workflow; any other report gets 403. A CI caller acts for no user, may call
// nothing but contract.report (403 elsewhere), and neither the membership
// re-check nor the PAT switch applies to it.
//
// contract.report itself is defined by task 22.5; until then these tests call
// a stand-in of it, a REST operation with its id that takes the API's name and
// answers with the API the run may report for, as the real one decides it.

let install: TestInstall;
let oidc: ActionsOidc;
let ada: WebSessionCaller;
let acmeId: number;
let paymentsApi: string;
let billingApi: string;

/** The workflow that billing-api is bound to. */
const CONTRACT_WORKFLOW = "acme/payments/.github/workflows/contract.yml@refs/heads/main";

/** A run in acme/payments, as its token names it. */
const paymentsRun = (run: Partial<ActionsRun> = {}): ActionsRun => ({
  audience: URL_OF_INSTALL,
  repository: "acme/payments",
  repositoryId: 7001,
  repositoryOwnerId: acmeId,
  jobWorkflowRef: CONTRACT_WORKFLOW,
  ...run,
});

/** A stand-in of contract.report (task 22.5): the API's name in, the API the CI run may report for out. */
const report = defineCommand({
  id: "contract.report",
  summary: "Report the classified changes of a provider pull request to a registered API.",
  input: z.object({ api: z.string() }),
  output: z.object({ api: z.uuid() }),
  method: "POST",
  path: "/api/v1/contract-reports",
  scopes: ["contracts:report"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "stable",
});
const otherOperation = defineCommand({
  id: "requests.list_stand_in",
  summary: "List requests.",
  input: z.object({}),
  output: z.object({ items: z.array(z.string()) }),
  method: "GET",
  path: "/api/v1/requests",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "beta",
});
const catalog = defineCatalog([report, otherOperation]);

/** The REST route of an install whose CI token check reads the test issuer's keys, or as the options say. */
function api(options: Partial<CiTokenCheckOptions> = {}): (request: Request) => Promise<Response> {
  const execute = createExecute({
    catalog,
    handlers: {
      [report.id]: defineHandler(report, async ({ api: name }, context) => {
        if (context.caller.kind !== "ci") throw new Refusal("forbidden", "Only a CI run reports.");
        // A CI caller acts for no user.
        expect(context.member).toBeUndefined();
        expect(context.provenance).toEqual({ actorKind: "system", surface: "github" });
        return { api: (await reportableApi(context, context.caller, name)).id };
      }),
      [otherOperation.id]: defineHandler(otherOperation, async () => ({ items: [] })),
    },
    store: { database: install.db, jobs: { send: async () => {} } },
  });
  const ci = createCiTokenCheck({ url: URL_OF_INSTALL, database: install.db, keys: async () => oidc.jwks, ...options });
  const agent = createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db });
  return createRestHandler({ catalog, document: OPENAPI_JSON, execute, authenticate: createApiCallerCheck({ agent, ci }), logger: install.logger });
}

/** Reports for the API with the token, as the contract Action's CLI does. */
async function send(token: string, name: string, route = api()): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await route(
    new Request(`${URL_OF_INSTALL}/api/v1/contract-reports`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ api: name }),
    }),
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

beforeAll(async () => {
  install = await startTestInstall();
  oidc = createActionsOidc();
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  const pay = await addTeam(install.owner, "PAY");
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
  const { rows } = await install.owner.query<{ id: string; name: string }>("SELECT id, name FROM apis");
  paymentsApi = rows.find(({ name }) => name === "payments-api")?.id ?? "";
  billingApi = rows.find(({ name }) => name === "billing-api")?.id ?? "";
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("DELETE FROM install_settings");
});

/** The jti values the install has seen, by their count. */
async function seenTokens(): Promise<number> {
  const { rows } = await install.owner.query("SELECT count(*)::int AS n FROM used_ci_tokens");
  return rows[0].n;
}

const invalidToken = { status: 401, body: expect.objectContaining({ type: `${PROBLEM_TYPE_BASE}invalid-token` }) };

describe("a report from a CI run", () => {
  it("is accepted from the registered repository, as a CI caller that acts for no user", async () => {
    const answer = await send(oidc.token(paymentsRun()), "payments-api");

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ api: paymentsApi });
  });

  it("is accepted from any workflow of its repository for an API with no workflow binding", async () => {
    const answer = await send(oidc.token(paymentsRun({ jobWorkflowRef: "acme/payments/.github/workflows/nightly.yml@refs/heads/main" })), "payments-api");
    expect(answer).toMatchObject({ status: 200, body: { api: paymentsApi } });
  });

  it("for an API bound to a workflow is accepted from that workflow and refused with 403 from another of its repository", async () => {
    expect(await send(oidc.token(paymentsRun()), "billing-api")).toMatchObject({ status: 200, body: { api: billingApi } });

    const other = await send(oidc.token(paymentsRun({ jobWorkflowRef: "acme/payments/.github/workflows/nightly.yml@refs/heads/main" })), "billing-api");

    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}ci-caller-refused`, status: 403 });
  });

  it.each([
    ["a repository no registered API is bound to", { repository: "acme/web", repositoryId: 7002 }],
    ["a repository with another owner", { repositoryOwnerId: 424242 }],
  ])("is refused with 403 from %s", async (_case, run) => {
    const answer = await send(oidc.token(paymentsRun(run)), "payments-api");
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}ci-caller-refused` });
  });

  it("is refused with 403 for an API that is not registered, as for one registered to another repository", async () => {
    expect((await send(oidc.token(paymentsRun()), "ledger-api")).status).toBe(403);
  });
});

describe("a CI token that is not valid", () => {
  it("for another audience is refused with 401 invalid_token, and takes no report", async () => {
    const before = await seenTokens();

    const answer = await send(oidc.token(paymentsRun({ audience: "https://tiehall.other.example" })), "payments-api");

    expect(answer).toMatchObject(invalidToken);
    expect(answer.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    expect(await seenTokens()).toBe(before);
  });

  it.each([
    ["has expired", { claims: { exp: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 310 } }],
    ["is signed with a key GitHub Actions does not publish", { signedBy: "another key" as const }],
    ["names another issuer", { claims: { iss: "https://token.actions.example.net" } }],
    ["names the audience among others", { claims: { aud: [URL_OF_INSTALL, "https://tiehall.other.example"] } }],
    ["has no jti", { claims: { jti: undefined } }],
    ["names no repository_id", { claims: { repository_id: undefined } }],
    ["names no repository_owner_id", { claims: { repository_owner_id: undefined } }],
    ["names no job_workflow_ref", { claims: { job_workflow_ref: undefined } }],
  ])("is refused with 401 invalid_token when it %s", async (_case, options) => {
    expect(await send(oidc.token(paymentsRun(), options), "payments-api")).toMatchObject(invalidToken);
  });

  it("is refused with 401 invalid_token when it was seen before: a replayed token takes no report", async () => {
    const token = oidc.token(paymentsRun());
    expect((await send(token, "payments-api")).status).toBe(200);

    expect(await send(token, "payments-api")).toMatchObject(invalidToken);
  });

  it("is refused once alone when two calls replay it at the same time", async () => {
    const token = oidc.token(paymentsRun());

    const answers = await Promise.all([send(token, "payments-api"), send(token, "payments-api")]);

    expect(answers.map(({ status }) => status).sort()).toEqual([200, 401]);
  });

  it("is refused with 401 when it was seen on a report that was itself refused", async () => {
    const token = oidc.token(paymentsRun());
    expect((await send(token, "ledger-api")).status).toBe(403);

    expect(await send(token, "payments-api")).toMatchObject(invalidToken);
  });
});

describe("a CI caller", () => {
  it("is refused with 403 on any other operation, and with 404 on a path that serves none", async () => {
    const route = api();
    const call = (path: string) =>
      route(new Request(`${URL_OF_INSTALL}${path}`, { headers: { authorization: `Bearer ${oidc.token(paymentsRun())}` } }));

    const other = await call("/api/v1/requests");
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ type: `${PROBLEM_TYPE_BASE}ci-caller-refused` });
    expect((await call("/api/v1/apis")).status).toBe(404);
  });

  it("is refused with 403 on every operation of the real catalog but contract.report", async () => {
    const execute = install.execute;
    const ci: Caller = { kind: "ci", repositoryId: "7001", repositoryOwnerId: String(acmeId), jobWorkflowRef: CONTRACT_WORKFLOW };
    for (const definition of CATALOG.commands.filter(({ surfaces, id }) => surfaces.includes("rest") && id !== "contract.report")) {
      await expect(execute(definition.id, ci, {}), definition.id).rejects.toMatchObject({ status: 403, reason: "ci-caller-refused" });
    }
  });

  it("is not blocked by the PAT switch", async () => {
    await install.owner.query("INSERT INTO install_settings (org_id, personal_access_tokens_on) SELECT id, false FROM orgs");

    expect(await send(oidc.token(paymentsRun()), "payments-api")).toMatchObject({ status: 200, body: { api: paymentsApi } });
  });
});

describe("GitHub Actions' keys", () => {
  it("are read from GitHub's JSON Web Key Set, through a fetch that reaches no other host", async () => {
    const asked: string[] = [];
    const route = api({
      keys: undefined,
      fetch: async (input) => {
        asked.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify(oidc.jwks), { headers: { "content-type": "application/json" } });
      },
    });

    expect((await send(oidc.token(paymentsRun()), "payments-api", route)).status).toBe(200);
    expect(asked).toEqual([GITHUB_ACTIONS_JWKS_URL]);
    expect(GITHUB_ACTIONS_JWKS_URL).toBe(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`);
  });

  it("that cannot be read answer 502 integration-unavailable, and the token stays unseen", async () => {
    const route = api({
      keys: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const token = oidc.token(paymentsRun());

    const answer = await send(token, "payments-api", route);

    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}integration-unavailable` });
    expect((await send(token, "payments-api")).status).toBe(200);
  });
});

describe("the jti replay cache", () => {
  it("forgets a token's jti once the token has expired, and keeps the others", async () => {
    await install.owner.query("DELETE FROM used_ci_tokens");
    const now = new Date();
    expect((await send(oidc.token(paymentsRun(), { now: new Date(now.getTime() - 4 * 60_000) }), "payments-api")).status).toBe(200);
    expect((await send(oidc.token(paymentsRun()), "payments-api")).status).toBe(200);

    await pruneUsedCiTokens.handle({ id: randomUUID(), queue: pruneUsedCiTokens.type.queue, data: {}, signal: new AbortController().signal }, {
      database: install.db,
      now: () => new Date(now.getTime() + 8 * 60_000),
    });

    expect(await seenTokens()).toBe(1);
  });
});
