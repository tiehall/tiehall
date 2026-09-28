import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { createActivityLogRoute, type ActivityLogRoute } from "./activity-log-route.ts";
import { createConfirmationStep, type ConfirmationStep } from "./confirmation-step.ts";
import { createConfirmationNonces } from "./confirmations.ts";
import { createConfirmRoute, type ConfirmRoute } from "./confirm-route.ts";
import { openAppDatabase } from "./database.ts";
import { createExecute, type Execute } from "./execute.ts";
import { createGitHubAdminRoute, type GitHubAdminRoute } from "./github-admin-route.ts";
import { createHomeRoute, type HomeRoute } from "./home-route.ts";
import { HANDLERS } from "./handlers.ts";
import { openJobQueue, type JobQueue } from "./job-queue.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { createRestHandler, type RestHandler } from "./rest.ts";
import { CONFIRM_DOWNLOADS, CONFIRMATION_SUBJECTS, REVIEWS } from "./reviews.ts";
import { openSecretBox, type SecretBox } from "./secret-box.ts";
import { installUrl, readAppDatabase, readAuthSecret, readSecretKey, type Environment } from "./settings.ts";
import { createSetupRoute, type SetupRoute } from "./setup-route.ts";
import { createSignInService, type SignInService } from "./sign-in.ts";
import { createWebCommands, type WebCommands } from "./web-commands.ts";
import type { WebSessionCaller } from "./caller.ts";

export type { WebResult } from "./web-commands.ts";
export { PACKET_SCHEMA_PATH, packetSchemaRoute } from "./packet-schema-route.ts";
export { AUTH_BASE_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from "./sign-in.ts";
import { WORKER_JOBS } from "./worker-jobs.ts";

// What the web role's routes, server actions and server components run
// (design.md, Technical decisions: T1 and T3): the real catalog and its
// handlers, through one execute() per process, as the app role. REST and the
// web UI share it, so both take the same authorization path. The web process
// sends the jobs its writes start, and opens the job queue only when a write
// first sends one; it works no queue, which the worker does.

interface Services {
  execute: Execute;
  step: ConfirmationStep;
  logger: Logger;
  signIn: SignInService;
  database: ReturnType<typeof openAppDatabase>;
  secrets: () => SecretBox;
}

let services: Services | undefined;
let rest: RestHandler | undefined;
let web: WebCommands | undefined;
let confirm: ConfirmRoute | undefined;
let activityLog: ActivityLogRoute | undefined;

/** The process's one execute(), confirmation step and sign-in service, built from the install's settings on first use. */
function servicesOf(env: Environment): Services {
  if (services !== undefined) return services;
  const logger = createLogger().child({ role: "web" });
  const connection = readAppDatabase(env);
  const database = openAppDatabase(connection, { applicationName: "tiehall web", logger, role: "web" });
  let queue: Promise<JobQueue> | undefined;
  const jobs: JobSender = {
    async send(tx, name, data) {
      queue ??= openJobQueue({
        connection,
        jobTypes: WORKER_JOBS.map(({ type }) => type),
        applicationName: "tiehall web",
        logger,
      }).catch((error: unknown) => {
        queue = undefined;
        throw error;
      });
      await (await queue).send(tx, name, data);
    },
  };
  // The confirmation step's nonces, signed with TIEHALL_AUTH_SECRET, which is read when one is first issued or checked.
  const confirmations = createConfirmationNonces({ secret: () => readAuthSecret(env) });
  // The sign-in service opens the GitHub App's stored client secret with TIEHALL_SECRET_KEY, read when it is first built.
  let box: SecretBox | undefined;
  const secrets = () => (box ??= openSecretBox(readSecretKey(env)));
  const signIn = createSignInService({
    database,
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    secrets,
    // The sign-in that completes setup releases the deliveries held during setup.
    jobs,
    logger,
  });
  services = {
    database,
    secrets,
    signIn,
    execute: createExecute({ catalog: CATALOG, handlers: HANDLERS, store: { database, jobs }, confirmations, subjects: CONFIRMATION_SUBJECTS }),
    step: createConfirmationStep({ catalog: CATALOG, reviews: REVIEWS, store: { database }, confirmations, subjects: CONFIRMATION_SUBJECTS }),
    logger,
  };
  return services;
}

/** The REST route under /api/v1, built once per process from the install's settings. */
export function restRoute(env: Environment): RestHandler {
  if (rest !== undefined) return rest;
  const { execute, logger } = servicesOf(env);
  rest = createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute,
    // Tokens are checked from group 15 on (agent-access); until then no call carries valid credentials.
    authenticate: async () => undefined,
    logger,
  });
  return rest;
}

/**
 * What the web UI's server actions and server components run operations
 * through, as the signed-in user's web session, which the headers of the
 * request they answer name; built once per process.
 */
export function webCommands(env: Environment, requestHeaders: () => Promise<Headers>): WebCommands {
  if (web !== undefined) return web;
  const { execute, logger, signIn } = servicesOf(env);
  web = createWebCommands({
    execute,
    session: async () => signIn.session(await requestHeaders()),
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    logger,
  });
  return web;
}

/**
 * The review pages of the confirmation step under /confirm/, built once per
 * process, for the signed-in user's web session.
 */
export function confirmRoute(env: Environment): ConfirmRoute {
  if (confirm !== undefined) return confirm;
  const { execute, step, logger, signIn } = servicesOf(env);
  confirm = createConfirmRoute({
    step,
    downloads: CONFIRM_DOWNLOADS,
    session: (request) => signIn.session(request.headers),
    write: { execute, url: installUrl(env["TIEHALL_URL"] ?? ""), secret: () => readAuthSecret(env) },
    logger,
  });
  return confirm;
}

/** The activity log's page under /admin/activity-log, built once per process, for the signed-in admin's web session. */
export function activityLogRoute(env: Environment): ActivityLogRoute {
  if (activityLog !== undefined) return activityLog;
  const { execute, logger, signIn } = servicesOf(env);
  activityLog = createActivityLogRoute({ execute, session: (request) => signIn.session(request.headers), logger });
  return activityLog;
}

let githubAdmin: GitHubAdminRoute | undefined;

/** The GitHub page of the admin UI under /admin/github, built once per process, for the signed-in admin's web session. */
export function githubAdminRoute(env: Environment): GitHubAdminRoute {
  if (githubAdmin !== undefined) return githubAdmin;
  const { execute, logger, signIn } = servicesOf(env);
  githubAdmin = createGitHubAdminRoute({
    execute,
    session: (request) => signIn.session(request.headers),
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    logger,
  });
  return githubAdmin;
}

/**
 * The sign-in service's routes under /api/auth, such as GitHub's return to the
 * sign-in callback (sign-in: GitHub is the only way to sign in).
 */
export function signInServiceRoute(env: Environment): (request: Request) => Promise<Response> {
  const { signIn } = servicesOf(env);
  return (request) => signIn.handler(request);
}

let setup: SetupRoute | undefined;

/**
 * The setup screen at /setup, with its steps under it, built once per process
 * (self-host-install: The setup code guards the setup screen; self-host-install:
 * Setup names the company and makes the first admin). It shares the sign-in
 * service, whose own instance under /setup/sign-in completes setup.
 */
export function setupRoute(env: Environment): SetupRoute {
  if (setup !== undefined) return setup;
  const { database, secrets, signIn, logger } = servicesOf(env);
  setup = createSetupRoute({ database, url: installUrl(env["TIEHALL_URL"] ?? ""), secrets, signIn: signIn.setup, logger });
  return setup;
}

/** The sign-in page at /sign-in, which offers sign-in with GitHub only. */
export function signInPageRoute(env: Environment): (request: Request) => Promise<Response> {
  const { signIn } = servicesOf(env);
  return (request) => signIn.page(request);
}

let homePage: HomeRoute | undefined;

/** The home page at /, which sends a person who is not signed in to the sign-in page; built once per process. */
export function homeRoute(env: Environment): HomeRoute {
  if (homePage !== undefined) return homePage;
  const { logger } = servicesOf(env);
  homePage = createHomeRoute({ session: (request) => webSession(env, request.headers), secret: () => readAuthSecret(env), logger });
  return homePage;
}

/** The web UI's sign-out at /sign-out, which ends the session the request's cookie names. */
export function signOutRoute(env: Environment): (request: Request) => Promise<Response> {
  const { signIn } = servicesOf(env);
  return (request) => signIn.signOut(request);
}

/**
 * The web session the request's cookie names, or undefined when it names
 * none; a session a removal ended is refused with 403 removed-member.
 */
export function webSession(env: Environment, headers: Headers): Promise<WebSessionCaller | undefined> {
  // A request without a session cookie reaches neither the database nor the settings.
  if (!/(?:^|;\s*)(?:__Secure-)?tiehall\.session_token=/.test(headers.get("cookie") ?? "")) return Promise.resolve(undefined);
  return servicesOf(env).signIn.session(headers);
}
