import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { integrationSecrets, orgs, type Database } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { createLogger, type Logger } from "./log.ts";

// The setup gate (self-host-install: The setup code guards the setup screen;
// public-api: One error model for Tiehall's own refusals; design.md, Technical
// decisions: T7 and T16; design.md, Self-hosting decisions: S3). Until the
// first admin completes setup, the web role serves only three routes:
// - /setup, the setup screen, with its steps under it;
// - /healthz, which Compose's health check and monitors read;
// - /webhooks/github, from the moment the setup screen has stored the GitHub
//   App's credentials, with or without a webhook secret, so a delivery that
//   arrives during setup is verified and stored, to be processed once setup
//   completes. The route refuses every delivery with 401 while no webhook
//   secret is stored, as for an App created without a webhook
//   (github-app-reachability: design.md, Design rules: An App without a
//   webhook).
// Every other call is answered before any route sees it: a page leads to the
// setup screen at the install's URL, TIEHALL_URL/setup, and an API call
// answers 503 with the problem type setup-required, the OpenAPI document at
// /api/v1/openapi.json and the webhooks before the App exists included. An
// API call is one under /api, /mcp, /.well-known, /webhooks or /schemas; every
// other path is a page, /docs/api among them.
//
// Setup never becomes incomplete again (`setup reopen` reopens only the App
// step, while the install keeps serving), so once the gate has seen it
// complete it lets every call through without reading the database again.

/** What the gate needs to know of the install. */
export interface SetupState {
  /** The first admin's sign-in has completed setup. */
  complete: boolean;
  /**
   * The setup screen has stored the GitHub App's credentials: its id, client
   * credentials and private key, with a webhook secret or without one.
   */
  appCredentialsStored: boolean;
}

/** The gate's answer to one call: serve it, send it to /setup, or refuse it. */
export type SetupGateAnswer =
  | { kind: "serve" }
  | { kind: "redirect"; status: 303 | 307; location: string }
  | { kind: "refuse"; problem: HttpProblem };

/** A call's answer from the gate, or undefined when the gate lets it through to its route. */
export type SetupGate = (request: Request) => Promise<Response | undefined>;

export interface SetupGateOptions {
  /** The app's database, read as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin: a page leads to the setup screen there. */
  url: string;
  logger?: Logger;
}

export const SETUP_PATH = "/setup";
export const WEBHOOKS_GITHUB_PATH = "/webhooks/github";
export const HEALTH_PATH = "/healthz";

/** The paths under which every call is an API call, never a page. */
const API_PATHS = ["/api", "/mcp", "/.well-known", "/webhooks", "/schemas"];

/** Whether a call to this path is an API call, never a page: one under /api, /mcp, /.well-known, /webhooks or /schemas. */
export function isApiCall(pathname: string): boolean {
  return API_PATHS.some((prefix) => under(pathname, prefix));
}

const SETUP_REQUIRED = httpProblem(
  new Refusal("setup-required", "Setup is not complete. The install's operator completes it on the setup screen at /setup."),
);

/**
 * Reads whether setup is complete and whether the App's credentials are
 * stored, which the App's private key says: every App has one, and an App
 * created without a webhook has no webhook secret (github-app-reachability:
 * design.md, Technical decisions: T3).
 */
export async function readSetupState(database: Database): Promise<SetupState> {
  return database.transaction(async (tx) => {
    const [org] = await tx.select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt }).from(orgs).limit(1);
    if (org === undefined) return { complete: false, appCredentialsStored: false };
    const [privateKey] = await tx
      .select({ name: integrationSecrets.name })
      .from(integrationSecrets)
      .where(and(eq(integrationSecrets.orgId, org.id), eq(integrationSecrets.name, "github_app.private_key")));
    return { complete: org.setupCompletedAt !== null, appCredentialsStored: privateKey !== undefined };
  });
}

/** Whether a path is this one or lies under it, as /setup/github does under /setup. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The routes served before setup completes whatever the state, which need no read of the database. */
function alwaysServed(pathname: string): boolean {
  return pathname === HEALTH_PATH || under(pathname, SETUP_PATH);
}

/**
 * The gate's answer to a call with this method and path, in this state of the
 * install whose URL is given: a page leads to the setup screen at that URL.
 */
export function setupGateAnswer(method: string, pathname: string, state: SetupState, url: string): SetupGateAnswer {
  if (state.complete || alwaysServed(pathname)) return { kind: "serve" };
  if (pathname === WEBHOOKS_GITHUB_PATH && state.appCredentialsStored) return { kind: "serve" };
  if (isApiCall(pathname)) return { kind: "refuse", problem: SETUP_REQUIRED };
  // A page read is sent on as it is; a form posted to a page is sent to read the setup screen.
  return { kind: "redirect", status: method === "GET" || method === "HEAD" ? 307 : 303, location: `${url}${SETUP_PATH}` };
}

export function createSetupGate(options: SetupGateOptions): SetupGate {
  const logger = options.logger ?? createLogger();
  let complete = false;
  return async function gate(request) {
    if (complete) return undefined;
    const { pathname } = new URL(request.url);
    // /healthz must answer while the database is down, and the setup screen reads the state itself.
    if (alwaysServed(pathname)) return undefined;
    let state: SetupState;
    try {
      state = await readSetupState(options.database);
    } catch (error) {
      logger.error("setup gate: the install's state could not be read", { error });
      return problemResponse(internalErrorProblem());
    }
    if (state.complete) complete = true;
    const answer = setupGateAnswer(request.method, pathname, state, options.url);
    switch (answer.kind) {
      case "serve":
        return undefined;
      case "redirect":
        return new Response(null, { status: answer.status, headers: { location: answer.location, "cache-control": "no-store" } });
      case "refuse":
        return problemResponse(answer.problem);
    }
  };
}

function problemResponse({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
