import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { signInCompleted } from "@tiehall/core";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createActionsOidc, type ActionsOidc } from "@tiehall/testing/oidc";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createAgentTokenCheck,
  createApiCallerCheck,
  createCiTokenCheck,
  createGitHubWebhookRoute,
  createLogger,
  createRestHandler,
  createSetupRoute,
  migrate,
  mirrorRequest,
  mirrorRequests,
  openDatabase,
  openJobQueue,
  openSecretBox,
  processGitHubDelivery,
  startSetup,
  startWorker,
  write,
  type Database,
  type Execute,
  type SecretBox,
} from "../src/index.ts";
import { CONTRACT_WORKFLOW, CONTRACT_WORKFLOW_FILE, providerOnStub, reportOf, runDueUpdates, type StubProvider } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// The log canary, on every path that handles text and credentials from
// outside (self-host-install: Logs carry ids, never message text or
// credentials; design.md, Self-hosting decisions: S13; design.md, Technical
// decisions: T17). The canary test of 4.14 and 6.16 (log-canary.test.ts)
// shows a failing job and a failing REST call leaving neither a canary string
// nor a canary token in the log. Here the same holds where Tiehall takes text
// and credentials from GitHub, from CI and from the operator, on the paths
// that work and on those that fail: contract.report from the provider's CI,
// taken, replayed, refused and failing with the run's token in its
// Authorization header and query string; a GitHub mirror job for a request
// full of the canary, failing on a GitHub that echoes what it was sent with
// the installation token, then working; webhook intake of GitHub deliveries
// that hold the canary, verified, forged and malformed, and their processing;
// the activity log's export, whose request carries the canary as its user
// agent; and setup, where the operator names the company with the canary and
// GitHub hands over the App's credentials, which a failing secret box then
// echoes. Each scenario's log, and everything the process writes while it
// runs, holds none of the canary text and none of the credentials; the one
// secret a log shows by design is the setup code, in the line that prints it.
// A Jira mirror job joins once the Jira mirror exists.

const CANARY = `canary-${randomBytes(8).toString("hex")}`;
const CANARY_TEXT = `Please rotate the staging keys; ${CANARY}`;

/** Runs a scenario while capturing everything the process writes to its standard output and error, as well as the loggers' lines. */
async function capturing<T>(written: string[], scenario: () => Promise<T>): Promise<T> {
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
  try {
    return await scenario();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** Checks that a log holds none of these secrets, nor the canary, and that it was written at all. */
function expectClean(log: string, secrets: readonly string[], what: string): void {
  expect(log.length, `${what}: something was logged`).toBeGreaterThan(0);
  expect(log, `${what}: the canary`).not.toContain(CANARY);
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(log.includes(secret), `${what}: a secret of ${secret.length} characters`).toBe(false);
  }
}

/** A JWT's parts, each of which is a secret on its own once a log cuts the rest. */
const jwtParts = (token: string) => [token, ...token.split(".").filter((part) => part.length >= 16)];

describe("contract.report", () => {
  const lines: string[] = [];
  const written: string[] = [];
  let clock = new Date();
  let install: TestInstall;
  let stub: GitHubStub;
  let provider: StubProvider;
  let oidc: ActionsOidc;

  beforeAll(async () => {
    install = await startTestInstall({ log: (line) => void lines.push(line), now: () => clock });
    stub = await startGitHubStub();
    provider = await providerOnStub(install, stub, ["deniz"]);
    oidc = createActionsOidc();
    const ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
    const deniz = await addUser(install.owner, { login: "deniz", githubAccountId: provider.account("deniz") });
    const bob = await addUser(install.owner, { login: "bob" });
    const pay = await addTeam(install.owner, "PAY");
    const fe = await addTeam(install.owner, "FE");
    await joinTeams(install.owner, deniz, pay);
    await joinTeams(install.owner, bob, fe);
    expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments", workflow: CONTRACT_WORKFLOW_FILE })).status).toBe(200);
    const api = (await install.owner.query<{ id: string }>("SELECT id FROM apis")).rows[0]?.id ?? "";
    await install.execute("apis.declare_consumer", sessionOf(bob), { api, team: fe });
  }, 60_000);

  afterAll(async () => {
    await stub?.close();
    await install?.close();
  });

  it("leaves neither the canary nor the run's token in the log, whether a report is taken, replayed, refused, invalid or fails", async () => {
    const tokens: string[] = [];
    const token = () => {
      const issued = oidc.token({ audience: URL_OF_INSTALL, repository: "acme/payments", repositoryId: provider.repositoryId, repositoryOwnerId: provider.ownerId, jobWorkflowRef: CONTRACT_WORKFLOW });
      tokens.push(issued);
      return issued;
    };
    const routeWith = (execute: Execute) =>
      createRestHandler({
        catalog: CATALOG,
        document: OPENAPI_JSON,
        execute,
        authenticate: createApiCallerCheck({
          agent: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: async () => undefined, database: install.db }),
          ci: createCiTokenCheck({ url: URL_OF_INSTALL, database: install.db, keys: async () => oidc.jwks }),
        }),
        logger: install.logger,
      });
    const route = routeWith(install.execute);
    // An execute() that reports and then fails the way a library does, echoing the token and the report.
    let failingToken = "";
    const failing = routeWith(async (commandId, caller, input, options) => {
      await install.execute(commandId, caller, input, options);
      throw Object.assign(new Error(`could not report ${JSON.stringify(input)} with Bearer ${failingToken}`), {
        request: { headers: { authorization: `Bearer ${failingToken}` }, body: JSON.stringify(input) },
        cause: new Error(CANARY_TEXT),
      });
    });
    const pullRequest = await stub.openPullRequest("acme/payments", { title: CANARY_TEXT, body: CANARY_TEXT, head: `${CANARY}-fields`, author: "deniz" });
    const report = {
      ...reportOf("payments-api", [{ id: `${CANARY}-removed`, level: "ERR", operation: `GET /payments/{id} ${CANARY_TEXT}` }], { pullRequest: pullRequest.number }),
      head: { ref: `${CANARY}-fields`, sha: "c".repeat(40) },
      engine: { name: "oasdiff", version: `1.32.1-${CANARY}` },
    };
    const send = (handler: typeof route, body: unknown, bearer: string, query = "") =>
      handler(
        new Request(`${URL_OF_INSTALL}/api/v1/contract-reports${query}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": CANARY_TEXT },
          body: JSON.stringify(body),
        }),
      );

    await capturing(written, async () => {
      const taken = token();
      expect((await send(route, report, taken)).status).toBe(200);
      // The same token again, in the header and the query string: a replay.
      expect((await send(route, report, taken, `?token=${taken}`)).status).toBe(401);
      expect((await send(route, { ...report, api: `${CANARY}-api` }, token())).status).toBe(403);
      expect((await send(route, { ...report, note: CANARY_TEXT }, token())).status).toBe(400);
      failingToken = token();
      expect((await send(failing, { ...report, head: { ref: `${CANARY}-again`, sha: "d".repeat(40) } }, failingToken)).status).toBe(500);
      // The worker applies the change set once its burst ends, opening a request to FE.
      clock = new Date(clock.getTime() + 3 * 60 * 1000);
      await runDueUpdates(install, clock);
    });
    expect((await install.owner.query("SELECT count(*)::int AS count FROM contract_change_requests")).rows[0]?.count).toBeGreaterThan(0);
    expectClean([...lines, ...written].join("\n"), tokens.flatMap(jwtParts), "contract.report");
  });
});

describe("a GitHub mirror job", () => {
  const lines: string[] = [];
  const written: string[] = [];
  let install: TestInstall;
  let stub: GitHubStub;
  let provider: StubProvider;
  let alice: string;
  let ayse: string;

  beforeAll(async () => {
    install = await startTestInstall({ log: (line) => void lines.push(line), jobTypes: [mirrorRequest] });
    stub = await startGitHubStub();
    provider = await providerOnStub(install, stub, ["ayse"], { repositories: ["acme/fe-intake"] });
    const ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
    alice = await addUser(install.owner, { login: "alice" });
    ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
    const be = await addTeam(install.owner, "BE");
    const fe = await addTeam(install.owner, "FE");
    await joinTeams(install.owner, alice, be);
    await joinTeams(install.owner, ayse, fe);
    await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  }, 60_000);

  afterAll(async () => {
    await stub?.close();
    await install?.close();
  });

  /** A request full of the canary that Alice opens to FE and Ayşe claims, which sends its mirror job; returns its id. */
  async function claimedCanaryRequest(): Promise<string> {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, {
      targetTeam: "FE",
      title: CANARY_TEXT,
      packet: { schema_version: "1-beta", kind: "request", untrusted: { need: CANARY_TEXT, acceptance_criteria: [CANARY_TEXT] } },
    });
    await install.execute("messages.post", sessionOf(alice), { key: request.key, kind: "comment", body: CANARY_TEXT });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    return request.id;
  }

  /** Waits until the mirror job of the request has failed an attempt or has made its issue. */
  async function until(done: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(`The mirror job did not ${what}.`);
      await sleep(100);
    }
  }

  it("leaves neither the canary nor the installation token in the log when GitHub fails it, echoing what it was sent, nor when it works", async () => {
    let refuse = true;
    // A GitHub that refuses to make the issue and echoes the call, its body and its token, in the error, as a library may.
    const echoing: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (refuse && request.method === "POST" && new URL(request.url).pathname.endsWith("/issues")) {
        const body = await request.clone().text();
        throw new TypeError(`fetch failed: GitHub refused ${request.url} ${body} with ${request.headers.get("authorization") ?? ""}`, { cause: new Error(body) });
      }
      return fetch(input, init);
    };
    const worker = await startWorker({
      connection: { connectionString: install.appDatabase.url, password: install.appDatabase.password },
      jobs: [mirrorRequests],
      pollingIntervalSeconds: 0.5,
      secrets: () => install.box,
      installUrl: URL_OF_INSTALL,
      github: { apiUrl: stub.apiUrl, fetch: echoing },
      logger: createLogger({ write: (line) => void lines.push(line) }),
    });
    try {
      await capturing(written, async () => {
        const refused = await claimedCanaryRequest();
        await until(async () => {
          const { rows } = await install.owner.query<{ state: string }>("SELECT state::text AS state FROM pgboss.job WHERE name = $1 AND data->>'requestId' = $2", [mirrorRequest.queue, refused]);
          return rows.some(({ state }) => state === "retry" || state === "failed");
        }, "fail");
        refuse = false;
        const mirrored = await claimedCanaryRequest();
        await until(async () => (await install.owner.query("SELECT 1 FROM mirrors WHERE request_id = $1 AND issue IS NOT NULL", [mirrored])).rows.length > 0, "make its issue");
      });
    } finally {
      await worker.stop();
    }
    const log = [...lines, ...written].join("\n");
    expect(log).toContain("worker: job failed");
    // The mirror job logs through the worker's own logger, never through one of its own past it.
    expect(lines.join("\n")).toContain("mirror: created the mirror issue");
    const tokens = stub.issuedInstallationTokens();
    expect(tokens.length).toBeGreaterThan(0);
    expectClean(log, tokens, "the GitHub mirror job");
  }, 60_000);

  it.todo("a Jira mirror job leaves neither the canary nor the bot's API token in the log, once the Jira mirror exists (task 25.6)");
});

describe("webhook intake", () => {
  const lines: string[] = [];
  const written: string[] = [];
  let install: TestInstall;
  let stub: GitHubStub;
  let provider: StubProvider;

  beforeAll(async () => {
    install = await startTestInstall({ log: (line) => void lines.push(line) });
    stub = await startGitHubStub();
    provider = await providerOnStub(install, stub, ["deniz"], { hook: true });
  }, 60_000);

  afterAll(async () => {
    await stub?.close();
    await install?.close();
  });

  it("leaves neither the canary nor the webhook secret, the signatures and the installation token in the log, for deliveries verified, forged and malformed, and their failing processing", async () => {
    const secret = provider.app.webhookSecret ?? "";
    expect(secret.length).toBeGreaterThanOrEqual(16);
    const connection = { connectionString: install.appDatabase.url, password: install.appDatabase.password };
    // The route stores a verified delivery and sends its processing job to the real queue, which the worker works.
    const queue = await openJobQueue({ connection, jobTypes: [processGitHubDelivery.type], logger: install.logger });
    const route = createGitHubWebhookRoute({ database: install.db, secrets: () => install.box, jobs: queue, logger: install.logger });
    // A GitHub that fails every read of a repository's records, echoing the call, its token and the canary, as a library may.
    const echoing: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/repos/")) {
        throw new TypeError(`fetch failed: ${request.url} with ${request.headers.get("authorization") ?? ""}: ${CANARY_TEXT}`, { cause: new Error(CANARY_TEXT) });
      }
      return fetch(input, init);
    };
    const worker = await startWorker({
      connection,
      jobs: [processGitHubDelivery],
      pollingIntervalSeconds: 0.5,
      secrets: () => install.box,
      installUrl: URL_OF_INSTALL,
      github: { apiUrl: stub.apiUrl, fetch: echoing },
      logger: createLogger({ write: (line) => void lines.push(line) }),
    });
    const sign = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
    const signatures: string[] = [];
    const deliver = (body: string, signature: string) => {
      signatures.push(signature.slice("sha256=".length));
      return route(
        new Request(`${URL_OF_INSTALL}/webhooks/github`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": randomUUID(), "x-hub-signature-256": signature, "user-agent": CANARY_TEXT },
          body,
        }),
      );
    };
    try {
      await capturing(written, async () => {
        await stub.openPullRequest("acme/payments", { title: CANARY_TEXT, body: CANARY_TEXT, head: `${CANARY}-branch`, author: "deniz" });
        const delivery = stub.deliveries(provider.app).filter(({ event }) => event === "pull_request").at(-1);
        if (delivery === undefined) throw new Error("GitHub made no delivery about the pull request.");
        const body = JSON.stringify(delivery.request.payload);
        expect(body).toContain(CANARY);
        expect((await deliver(body, sign(body))).status).toBeLessThan(300);
        expect((await deliver(body, sign(body, `${CANARY}-forged-key`))).status).toBe(401);
        const malformed = `{"action":"opened","pull_request":${JSON.stringify(CANARY_TEXT)}`;
        expect((await deliver(malformed, sign(malformed))).status).toBeGreaterThanOrEqual(400);
        // The worker processes the stored delivery, reading the pull request from a GitHub that fails.
        const deadline = Date.now() + 30_000;
        for (;;) {
          const { rows } = await install.owner.query<{ state: string }>("SELECT state::text AS state FROM pgboss.job WHERE name = $1", [processGitHubDelivery.type.queue]);
          if (rows.some(({ state }) => state === "retry" || state === "failed")) break;
          if (Date.now() > deadline) throw new Error(`The delivery's processing did not fail: ${JSON.stringify(rows)}`);
          await sleep(100);
        }
      });
    } finally {
      await worker.stop();
      await queue.stop({ timeoutMs: 0 });
    }
    const log = [...lines, ...written].join("\n");
    expect(log).toContain("worker: job failed");
    expectClean(log, [secret, ...signatures, ...stub.issuedInstallationTokens()], "webhook intake");
  }, 60_000);
});

describe("the activity log's export", () => {
  const lines: string[] = [];
  const written: string[] = [];
  let install: TestInstall;

  beforeAll(async () => {
    install = await startTestInstall({ log: (line) => void lines.push(line) });
  }, 60_000);

  afterAll(async () => {
    await install?.close();
  });

  it("leaves neither the canary user agent nor the export's lines in the log", async () => {
    const pia = await addUser(install.owner, { role: "admin", login: "pia" });
    // A sign-in from a browser whose user agent is the canary, kept beside its security event.
    await write({ database: install.db, jobs: { send: async () => {} } }, { actorKind: "web_session", userId: pia, surface: "web" }, (writer) => writer.record(signInCompleted, { userId: pia }), {
      origin: { ipAddress: "203.0.113.7", userAgent: CANARY_TEXT },
    });
    const role = pg.escapeIdentifier(new URL(install.appDatabase.url).username);
    const exported = await capturing(written, async () => {
      // The export fails once, as a database may: the app role may not read the events for a moment.
      await install.owner.query(`REVOKE SELECT ON events FROM ${role}`);
      try {
        expect((await install.confirm(sessionOf(pia), "activity_log.export", {}, { "user-agent": CANARY_TEXT, "x-forwarded-for": "203.0.113.8" })).status).toBe(500);
      } finally {
        await install.owner.query(`GRANT SELECT ON events TO ${role}`);
      }
      const answer = await install.confirm(sessionOf(pia), "activity_log.export", {}, { "user-agent": CANARY_TEXT, "x-forwarded-for": "203.0.113.8" });
      expect(answer.status).toBe(200);
      return answer.text();
    });
    expect([...lines, ...written].join("\n")).toContain("confirm: the review page failed");
    const exportedLines = exported.split("\n").filter((line) => line.length >= 16);
    expect(exportedLines.length).toBeGreaterThan(0);
    expectClean([...lines, ...written].join("\n"), exportedLines, "the export");
  });
});

describe("setup", () => {
  const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
  const lines: string[] = [];
  const written: string[] = [];
  const logger = createLogger({ write: (line) => void lines.push(line) });
  let database: TestDatabase;
  let owner: pg.Client;
  let db: Database;
  let box: SecretBox;
  let stub: GitHubStub;

  beforeAll(async () => {
    database = await createTestDatabase();
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
    const url = new URL(database.url);
    url.username = appRole.name;
    url.password = "";
    db = openDatabase({ connectionString: url.toString(), password: appRole.password });
    box = openSecretBox(randomBytes(32).toString("base64url"));
    stub = await startGitHubStub();
    stub.addUser({ login: "omar" });
    stub.addOrg({ login: "acme", members: { omar: "admin" } });
    stub.signIn("omar");
  }, 60_000);

  afterAll(async () => {
    await stub?.close();
    await db?.$client.end();
    await owner?.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
    await owner?.end();
    await database?.drop();
  });

  it("shows the setup code only in the line that prints it, and neither the canary company name nor the App's credentials, when storing them works or fails", async () => {
    // A secret box that fails the way a library may, echoing the secret it was given.
    const echoingBox: SecretBox = {
      keyId: box.keyId,
      seal: (plaintext) => {
        throw new Error(`could not seal ${plaintext}`);
      },
      open: (sealed, context) => box.open(sealed, context),
    };
    const routeWith = (secrets: () => SecretBox) => createSetupRoute({ database: db, url: URL_OF_INSTALL, logger, secrets, github: { webUrl: stub.webUrl, apiUrl: stub.apiUrl } });
    const route = routeWith(() => box);
    const failing = routeWith(() => echoingBox);
    const browser = (path: string, cookie?: string, init: RequestInit = {}) =>
      new Request(`${URL_OF_INSTALL}${path}`, {
        ...init,
        headers: { host: "tiehall.example.com", "x-forwarded-proto": "https", ...(cookie === undefined ? {} : { cookie }), ...(init.headers as Record<string, string>) },
      });
    const post = (path: string, cookie: string | undefined, form: Record<string, string>) =>
      browser(path, cookie, { method: "POST", headers: { origin: URL_OF_INSTALL, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    /** The App step's form, posted to GitHub and confirmed there, as a browser does; returns where GitHub sends the browser back. */
    const createOnGitHub = async (html: string): Promise<URL> => {
      const unescape = (text: string) => text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
      const match = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]*)">/.exec(html);
      if (match === null) throw new Error("The App step offers no manifest.");
      const page = await fetch(unescape(match[1] ?? ""), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ manifest: unescape(match[2] ?? "") }).toString(),
        redirect: "manual",
      });
      const created = await page.text();
      const registration = /name="registration" value="([^"]+)"/.exec(created)?.[1];
      if (registration === undefined) throw new Error(`GitHub refused the manifest: ${created.slice(0, 2000)}`);
      const confirmed = await fetch(`${stub.webUrl}/settings/apps/new/confirm`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ registration }).toString(),
        redirect: "manual",
      });
      const location = confirmed.headers.get("location");
      if (location === null) throw new Error(`GitHub did not confirm the App: ${confirmed.status} ${(await confirmed.text()).slice(0, 2000)}`);
      return new URL(location);
    };

    let code = "";
    let cookie = "";
    await capturing(written, async () => {
      code = (await startSetup({ database: db, url: URL_OF_INSTALL, logger }))?.code ?? "";
      const entered = await route(post("/setup", undefined, { code }));
      expect(entered.status).toBe(303);
      cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect((await route(post("/setup/company", cookie, { name: CANARY_TEXT }))).status).toBe(303);
      const step = await (await route(browser("/setup?org=acme", cookie))).text();
      // GitHub hands the App's credentials over, which a failing box echoes; then the next App's are stored.
      const first = await createOnGitHub(step);
      expect((await failing(browser(`${first.pathname}${first.search}`, cookie))).status).toBe(500);
      // App names are unique on GitHub, so the second App, as from another tab, gets a name of its own.
      const second = await createOnGitHub(await (await route(browser("/setup?org=acme&name=Tiehall%20second%20tab", cookie))).text());
      expect((await route(browser(`${second.pathname}${second.search}`, cookie))).status).toBe(303);
    });
    const log = [...lines, ...written].join("\n");
    expect(log).toContain("setup: the setup screen failed");
    expect(log).toContain("setup: the GitHub App's credentials are stored");
    // The setup code is the one secret a log shows, in the line that prints it, and in no other.
    expect(code.length).toBeGreaterThanOrEqual(16);
    expect([...lines, ...written].filter((line) => line.includes(code))).toEqual([expect.stringContaining("enter the setup code")]);
    const credentials = stub.apps().flatMap((app) => [app.clientSecret, app.pem, ...app.pem.split("\n").filter((line) => line.length >= 16), app.webhookSecret ?? ""]);
    const sessionToken = cookie.split("=")[1] ?? "";
    expectClean(log, [...credentials.filter((secret) => secret.length >= 16), sessionToken], "setup");
  });
});
