import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import type { GitHubStub } from "@tiehall/testing/github";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { createTestCertificate } from "@tiehall/testing/tls";
import {
  CONFIRMATION_SUBJECTS,
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  createGitHubAdminRoute,
  createGitHubWebhookRoute,
  createHomeRoute,
  createLogger,
  createRestHandler,
  createSetupGate,
  createSetupRoute,
  createSignInService,
  HANDLERS,
  migrate,
  openDatabase,
  openSecretBox,
  REVIEWS,
  startSetup,
  type Database,
  type JobData,
  type JobSender,
  type SignInService,
} from "../../src/index.ts";

// The install as a browser reaches it, before setup, for the end-to-end flows
// of the setup screen (self-host-install: Setup names the company and makes
// the first admin). A fresh database the migrations built, with no org yet,
// and a local server that answers as the web role does: the setup gate first,
// then the setup screen, the webhooks, the sign-in service's routes, the
// sign-in page, the home page, the admin UI's GitHub page, the review pages
// of the confirmation step and the REST API, each built as the web role
// builds it, against the GitHub stub. An install whose URL is not a trial URL
// is served over HTTPS with a test certificate the browser trusts by its key,
// through a host-resolver rule, so the browser keeps the `__Host-` and
// `__Secure-` cookies as it would at an install; a trial install is served on
// http://localhost and its port.

export interface AppServer {
  /** The install's URL, TIEHALL_URL. */
  url: string;
  /** A connection as the database owner, to inspect state. */
  owner: pg.Client;
  /** The app's database, as the app role. */
  db: Database;
  signIn: SignInService;
  /** The jobs the install's writes sent, in order. */
  sentJobs: { queue: string; data: JobData }[];
  /** The browser's launch arguments that send the install's host to this server and trust its certificate. */
  browserArgs: string[];
  /** Answers a request as the install does, without the network, such as a browser's request with its cookies. */
  handle(request: Request): Promise<Response>;
  /** Starts the web role's setup step, as a start of the app does, and returns the setup code it prints. */
  start(): Promise<string>;
  close(): Promise<void>;
}

/**
 * The install at https://tiehall.example.com, or, for a trial, at
 * http://localhost and the server's port; a test may give the fetch the
 * install reaches GitHub with, such as one that plays GitHub failing.
 */
export async function startAppServer(stub: GitHubStub, options: { trial?: boolean; fetch?: typeof fetch } = {}): Promise<AppServer> {
  const migrationsFolder = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
  const database: TestDatabase = await createTestDatabase();
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
  const owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const databaseUrl = new URL(database.url);
  databaseUrl.username = appRole.name;
  databaseUrl.password = "";
  const db = openDatabase({ connectionString: databaseUrl.toString(), password: appRole.password });
  const logger = process.env["DEBUG_APP_SERVER"] === undefined ? createLogger({ write: () => {} }) : createLogger();

  let handle: (request: Request) => Promise<Response> = async () => new Response("starting", { status: 503 });
  const certificate = options.trial === true ? undefined : createTestCertificate({ dnsNames: ["tiehall.example.com"] });
  const onRequest = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    answer(incoming, outgoing).catch((error: unknown) => {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    });
  };
  const server: Server = certificate === undefined ? createHttpServer(onRequest) : createHttpsServer({ key: certificate.key, cert: certificate.cert }, onRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = certificate === undefined ? `http://localhost:${port}` : "https://tiehall.example.com";

  async function answer(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    // The web role's request guard names the scheme the browser used.
    headers.set("x-forwarded-proto", certificate === undefined ? "http" : "https");
    const method = incoming.method ?? "GET";
    const request = new Request(new URL(incoming.url ?? "/", url), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
    });
    const answered = await handle(request);
    const out: Record<string, string | string[]> = Object.fromEntries(answered.headers);
    const cookies = answered.headers.getSetCookie();
    if (cookies.length > 0) out["set-cookie"] = cookies;
    outgoing.writeHead(answered.status, out);
    outgoing.end(Buffer.from(await answered.arrayBuffer()));
  }

  const authSecret = randomBytes(32).toString("base64url");
  const box = openSecretBox(randomBytes(32).toString("base64url"));
  const sentJobs: { queue: string; data: JobData }[] = [];
  const jobs: JobSender = {
    async send(_tx, queue, data) {
      sentJobs.push({ queue, data });
    },
  };
  // The stub serves on local ports, which the install reaches with the plain fetch; at an install it reaches GitHub only.
  const github = { webUrl: stub.webUrl, apiUrl: stub.apiUrl, fetch: options.fetch ?? fetch };
  const signIn = createSignInService({ database: db, url, secret: () => authSecret, secrets: () => box, github, jobs, logger });
  const gate = createSetupGate({ database: db, url, logger });
  const setup = createSetupRoute({ database: db, url, secrets: () => box, github, signIn: signIn.setup, logger });
  const webhooks = createGitHubWebhookRoute({ database: db, secrets: () => box, jobs, logger });
  const home = createHomeRoute({ session: (request) => signIn.session(request.headers), secret: () => authSecret, logger });
  const confirmations = createConfirmationNonces({ secret: authSecret });
  const store = { database: db, jobs };
  const execute = createExecute({ catalog: CATALOG, handlers: HANDLERS, store, confirmations, subjects: CONFIRMATION_SUBJECTS, secrets: () => box });
  const confirm = createConfirmRoute({
    step: createConfirmationStep({ catalog: CATALOG, reviews: REVIEWS, store, confirmations, subjects: CONFIRMATION_SUBJECTS }),
    session: (request) => signIn.session(request.headers),
    write: { execute, url, secret: authSecret },
    logger,
  });
  const rest = createRestHandler({ catalog: CATALOG, document: OPENAPI_JSON, execute, authenticate: async () => undefined, logger });
  const githubAdmin = createGitHubAdminRoute({ execute, session: (request) => signIn.session(request.headers), url, secret: () => authSecret, logger });
  handle = async (request) => {
    const refused = await gate(request);
    if (refused !== undefined) return refused;
    const { pathname } = new URL(request.url);
    if (pathname === "/") return home(request);
    if (pathname === "/setup" || pathname.startsWith("/setup/")) return setup(request);
    if (pathname === "/webhooks/github") return webhooks(request);
    if (pathname === "/sign-in") return signIn.page(request);
    if (pathname.startsWith("/api/auth/")) return signIn.handler(request);
    if (pathname.startsWith("/api/v1/")) return rest(request);
    if (pathname === "/admin/github") return githubAdmin(request);
    if (pathname.startsWith("/confirm/")) return confirm(request);
    return new Response("Not found", { status: 404 });
  };

  return {
    url,
    owner,
    db,
    signIn,
    sentJobs,
    browserArgs:
      certificate === undefined
        ? [`--host-resolver-rules=MAP localhost 127.0.0.1`]
        : [`--host-resolver-rules=MAP tiehall.example.com 127.0.0.1:${port}`, `--ignore-certificate-errors-spki-list=${certificate.spkiSha256}`],
    handle: (request) => handle(request),
    async start() {
      const started = await startSetup({ database: db, url, logger });
      if (started === undefined) throw new Error("setup is complete, so no setup code was printed");
      return started.code;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await db.$client.end();
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
      await owner.end();
      await database.drop();
    },
  };
}
