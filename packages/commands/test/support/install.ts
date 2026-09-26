import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CATALOG } from "@tiehall/catalog";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createConfirmationNonces,
  createConfirmationStep,
  createConfirmRoute,
  createExecute,
  createLogger,
  createWebCommands,
  csrfTokenFor,
  HANDLERS,
  migrate,
  openDatabase,
  REVIEWS,
  type ConfirmRoute,
  type Database,
  type Execute,
  type WebCommands,
  type WebSessionCaller,
  type WebWriteRequest,
} from "../../src/index.ts";

// An install whose setup is complete, for tests of the real operations. It
// holds a fresh database built by the migrations, the app role, the org, and
// the real catalog, handlers and reviews behind execute(), the web UI's
// commands and the confirmation step's review pages.

export const URL_OF_INSTALL = "https://tiehall.example.com";

export interface TestInstall {
  /** A connection as the database owner, to set up and inspect state. */
  owner: pg.Client;
  /** The app's database, as the app role. */
  db: Database;
  execute: Execute;
  /** The web UI's commands, for the given signed-in session. */
  web(caller: WebSessionCaller | undefined): WebCommands;
  /** A form posted from a page of the install, with the session's CSRF token. */
  fromThePage(caller: WebSessionCaller): WebWriteRequest;
  /** The review pages of the confirmation step, for the given signed-in session. */
  confirmRoute(caller: WebSessionCaller): ConfirmRoute;
  /** Opens the action's review page and posts its form, as a person confirming it does; returns the answer. */
  confirm(caller: WebSessionCaller, commandId: string, input: unknown): Promise<Response>;
  close(): Promise<void>;
}

export async function startTestInstall(options: { setUp?: (owner: pg.Client) => Promise<void> } = {}): Promise<TestInstall> {
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
  const logger = createLogger({ write: () => {} });
  const confirmations = createConfirmationNonces({ secret });
  const store = { database: db, jobs: { send: async () => {} } };
  const execute = createExecute({ catalog: CATALOG, handlers: HANDLERS, store, confirmations });
  const step = createConfirmationStep({ catalog: CATALOG, reviews: REVIEWS, store, confirmations });
  const confirmRoute = (caller: WebSessionCaller) =>
    createConfirmRoute({ step, session: async () => caller, write: { execute, url: URL_OF_INSTALL, secret }, logger });

  return {
    owner,
    db,
    execute,
    web: (caller) => createWebCommands({ execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => secret, logger }),
    fromThePage: (caller) => ({ origin: URL_OF_INSTALL, fetchSite: "same-origin", csrfToken: csrfTokenFor(secret, caller.sessionId) }),
    confirmRoute,
    async confirm(caller, commandId, input) {
      const route = confirmRoute(caller);
      const page = await route(new Request(`${URL_OF_INSTALL}/confirm/${commandId}?input=${encodeURIComponent(JSON.stringify(input))}`));
      const html = await page.text();
      if (page.status !== 200) return new Response(html, { status: page.status, headers: page.headers });
      const field = (name: string) =>
        (new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? "").replace(/&#(\d+);/g, (_, code: string) =>
          String.fromCharCode(Number(code)),
        );
      return route(
        new Request(`${URL_OF_INSTALL}/confirm/${commandId}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
          body: new URLSearchParams({ input: field("input"), nonce: field("nonce"), csrf: field("csrf") }).toString(),
        }),
      );
    },
    async close() {
      await db.$client.end();
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
      await owner.end();
      await database.drop();
    },
  };
}
