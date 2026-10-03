import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  createLogger,
  createRestHandler,
  createWebCommands,
  csrfTokenFor,
  HANDLERS,
  migrate,
  openDatabase,
  openSecretBox,
  REVIEWS,
  CONFIRM_DOWNLOADS,
  CONFIRM_ENTRIES,
  CONFIRM_MESSAGES,
  CONFIRM_REDIRECTS,
  CONFIRMATION_SUBJECTS,
  createEventWakeups,
  openJobQueue,
  type ConfirmationStep,
  type Caller,
  type ConfirmRoute,
  type Database,
  type Logger,
  type Execute,
  type InstallGitHub,
  type DefinedJobType,
  type JobData,
  type JobOptions,
  type JobQueue,
  type JobSender,
  type RestHandler,
  type SecretBox,
  type WebCommands,
  type WebSessionCaller,
  type WebWriteRequest,
} from "../../src/index.ts";
import { scanningApi } from "./confirm-url-scan.ts";

// An install whose setup is complete, for tests of the real operations. It
// holds a fresh database built by the migrations, the app role, the org, and
// the real catalog, handlers and reviews behind execute(), the web UI's
// commands and the confirmation step's review pages.

export const URL_OF_INSTALL = "https://tiehall.example.com";

export interface TestInstall {
  /** A connection as the database owner, to set up and inspect state. */
  owner: pg.Client;
  /** The database's URL, as its owner, such as for a dump. */
  databaseUrl: string;
  /** The app role's connection, as the web role reads it from TIEHALL_DATABASE_APP_URL and its password, such as for a web app a test starts. */
  appDatabase: { url: string; password: string };
  /** The install's TIEHALL_SECRET_KEY, which opens the stored integration secrets, such as for a web app a test starts. */
  secretKey: string;
  /** The install's auth secret, TIEHALL_AUTH_SECRET, which signs the CSRF tokens, the nonces and the sign-in service's cookies. */
  authSecret: string;
  /** The install's logger, which writes nowhere. */
  logger: Logger;
  /** TIEHALL_SECRET_KEY's box, which encrypts the stored integration secrets, for the operations that store one. */
  box: SecretBox;
  /** The app's database, as the app role. */
  db: Database;
  execute: Execute;
  /** The jobs the install's writes sent, in order, with the key a job runs under, when it has one. */
  sentJobs: { queue: string; data: JobData; startAfter?: Date; singletonKey?: string }[];
  /** The REST route under /api/v1, for calls whose credentials stand for the given caller; none answers 401. */
  api(caller: Caller | undefined): RestHandler;
  /** The web UI's commands, for the given signed-in session. */
  web(caller: WebSessionCaller | undefined): WebCommands;
  /** A form posted from a page of the install, with the session's CSRF token. */
  fromThePage(caller: WebSessionCaller): WebWriteRequest;
  /** The confirmation step: the review pages' reviews and nonces. */
  step: ConfirmationStep;
  /** The review pages of the confirmation step, for the given signed-in session. */
  confirmRoute(caller: WebSessionCaller): ConfirmRoute;
  /**
   * The review pages of the confirmation step, for whoever the request's
   * session names, or nobody, on the install at this URL unless another is
   * given, such as a local server's for a browser.
   */
  confirmRouteFor(session: (request: Request) => Promise<WebSessionCaller | undefined>, url?: string): ConfirmRoute;
  /**
   * Opens the action's review page and posts its form, as a person confirming
   * it does, with any further headers of the browser's request, such as its
   * X-Forwarded-For and User-Agent, and the values the person enters in the
   * form's own fields, such as a secret; returns the answer.
   */
  confirm(caller: WebSessionCaller, commandId: string, input: unknown, headers?: Record<string, string>, entered?: Record<string, string>): Promise<Response>;
  /**
   * Opens the action's review page now and returns a function that posts its
   * form, so a test can post it at a moment of its choosing, such as beside
   * another call; a page that is refused is answered as it was.
   */
  prepareConfirmation(
    caller: WebSessionCaller,
    commandId: string,
    input: unknown,
    headers?: Record<string, string>,
    entered?: Record<string, string>,
  ): Promise<() => Promise<Response>>;
  /**
   * Makes the operations that call GitHub, such as creating an invite, reach
   * it as this App, such as one a test stored from the GitHub stub; until
   * then the install has no App to call GitHub as.
   */
  useGitHub(github: InstallGitHub): void;
  close(): Promise<void>;
}

export async function startTestInstall(
  options: {
    setUp?: (owner: pg.Client) => Promise<void>;
    now?: () => Date;
    /** How the long-poll waits hold: a shorter hold, or a shutdown signal of the test's own. */
    wait?: { holdMs?: number; shutdown?: AbortSignal };
    /**
     * Sends the jobs of these types to the real job queue, as the app role, so
     * a worker the test starts runs them; the jobs then join no sentJobs.
     */
    jobTypes?: readonly DefinedJobType<JobData>[];
  } = {},
): Promise<TestInstall> {
  const migrationsFolder = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
  const database: TestDatabase = await createTestDatabase();
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
  const owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await options.setUp?.(owner);
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  const db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");

  const secret = randomBytes(32).toString("base64url");
  const secretKey = randomBytes(32).toString("base64url");
  const box = openSecretBox(secretKey);
  const logger = createLogger({ write: () => {} });
  const confirmations = createConfirmationNonces({ secret });
  const sentJobs: { queue: string; data: JobData; startAfter?: Date; singletonKey?: string }[] = [];
  const jobQueue: JobQueue | undefined =
    options.jobTypes === undefined
      ? undefined
      : await openJobQueue({ connection: { connectionString: url.toString(), password: appRole.password }, jobTypes: options.jobTypes, logger });
  const jobs: JobSender = jobQueue ?? {
    send: async (_tx: unknown, queue: string, data: JobData, options: JobOptions = {}) =>
      void sentJobs.push({
        queue,
        data,
        ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
        ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      }),
  };
  const store = { database: db, jobs };
  const subjects = CONFIRMATION_SUBJECTS;
  let installGitHub: InstallGitHub | undefined;
  const github: InstallGitHub = {
    app: () => installGitHub?.app() ?? Promise.resolve(undefined),
    checkKey: (credentials, appId) =>
      installGitHub?.checkKey(credentials, appId) ?? Promise.reject(new Error("The install has no GitHub App to check a key with.")),
  };
  // The long-poll waits are woken by the events that commit, over a connection of its own that listens once a wait starts.
  const wakeups = createEventWakeups({ connectionString: url.toString(), password: appRole.password }, { logger });
  const execute = createExecute({
    catalog: CATALOG,
    handlers: HANDLERS,
    store,
    confirmations,
    subjects,
    github,
    secrets: () => box,
    url: URL_OF_INSTALL,
    waits: { wakeups, ...options.wait },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const step = createConfirmationStep({ catalog: CATALOG, reviews: REVIEWS, store, confirmations, subjects, github });
  const confirmRouteFor = (session: (request: Request) => Promise<WebSessionCaller | undefined>, url = URL_OF_INSTALL) =>
    createConfirmRoute({
      step,
      downloads: CONFIRM_DOWNLOADS,
      redirects: CONFIRM_REDIRECTS,
      entries: CONFIRM_ENTRIES,
      messages: CONFIRM_MESSAGES,
      session,
      write: { execute, url, secret },
      logger,
    });
  const confirmRoute = (caller: WebSessionCaller) => confirmRouteFor(async () => caller);
  const prepareConfirmation: TestInstall["prepareConfirmation"] = async (caller, commandId, input, headers = {}, entered = {}) => {
    const route = confirmRoute(caller);
    const page = await route(new Request(`${URL_OF_INSTALL}/confirm/${commandId}?input=${encodeURIComponent(JSON.stringify(input))}`));
    const html = await page.text();
    if (page.status !== 200) return async () => new Response(html, { status: page.status, headers: page.headers });
    const field = (name: string) =>
      (new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? "").replace(/&#(\d+);/g, (_, code: string) =>
        String.fromCharCode(Number(code)),
      );
    return () =>
      route(
        new Request(`${URL_OF_INSTALL}/confirm/${commandId}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
          body: new URLSearchParams({ input: field("input"), nonce: field("nonce"), csrf: field("csrf"), ...entered }).toString(),
        }),
      );
  };

  return {
    owner,
    databaseUrl: database.url,
    appDatabase: { url: url.toString(), password: appRole.password },
    secretKey,
    authSecret: secret,
    logger,
    box,
    db,
    execute,
    sentJobs,
    step,
    // Every answer of /api/v1 is what an agent or the CLI reads, so none may hold a confirm URL (confirm-url-scan.ts).
    api: (caller) => scanningApi(createRestHandler({ catalog: CATALOG, document: OPENAPI_JSON, execute, authenticate: async () => caller, logger })),
    web: (caller) => createWebCommands({ execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => secret, logger }),
    fromThePage: (caller) => ({ origin: URL_OF_INSTALL, fetchSite: "same-origin", csrfToken: csrfTokenFor(secret, caller.sessionId) }),
    confirmRoute,
    confirmRouteFor,
    confirm: async (caller, commandId, input, headers, entered) => (await prepareConfirmation(caller, commandId, input, headers, entered))(),
    prepareConfirmation,
    useGitHub(value) {
      installGitHub = value;
    },
    async close() {
      await jobQueue?.stop({ timeoutMs: 0 });
      await wakeups.close();
      await db.$client.end();
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
      await owner.end();
      await database.drop();
    },
  };
}
