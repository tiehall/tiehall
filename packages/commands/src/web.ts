import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { createActivityLogRoute, type ActivityLogRoute } from "./activity-log-route.ts";
import { createAgentTokenCheck } from "./agent-tokens.ts";
import { resourceMetadataUrlOf, type AgentClientOptions } from "./authorization-server.ts";
import { createInvitesRoute, createMembersRoute, createPersonalAccessTokenSettingsRoute, createSignInPolicyRoute, createTeamsRoute } from "./admin-pages.ts";
import { createConfirmationStep, type ConfirmationStep } from "./confirmation-step.ts";
import { createConfirmationNonces } from "./confirmations.ts";
import { createConfirmRoute, type ConfirmRoute } from "./confirm-route.ts";
import { createConsentRoute, type ConsentRoute } from "./consent.ts";
import { createDeviceApprovalRoute, type DeviceApprovalRoute } from "./device-approval.ts";
import { openAppDatabase } from "./database.ts";
import { createExecute, type Execute } from "./execute.ts";
import { createGitHubAdminRoute, type GitHubAdminRoute } from "./github-admin-route.ts";
import { createHomeRoute, type HomeRoute } from "./home-route.ts";
import { HANDLERS } from "./handlers.ts";
import { createInstallGitHub } from "./install-github.ts";
import { openJobQueue, type JobQueue } from "./job-queue.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { createMcpRoute, type McpRoute } from "./mcp.ts";
import { createNewRequestRoute } from "./new-request.ts";
import { createRequestListsRoute } from "./request-lists.ts";
import { createRequestUrlRoute, type RequestUrlRoute } from "./request-urls.ts";
import { createRestHandler, type RestHandler } from "./rest.ts";
import { CONFIRM_DOWNLOADS, CONFIRM_ENTRIES, CONFIRM_MESSAGES, CONFIRM_REDIRECTS, CONFIRMATION_SUBJECTS, REVIEWS } from "./reviews.ts";
import { createTokensRoute } from "./personal-access-tokens.ts";
import { openSecretBox, type SecretBox } from "./secret-box.ts";
import { installUrl, readAppDatabase, readAuthSecret, readClientMetadataFetch, readSecretKey, type Environment } from "./settings.ts";
import { createSetupRoute, type SetupRoute } from "./setup-route.ts";
import { createSignInService, type SignInService } from "./sign-in.ts";
import { createWebCommands, type WebCommands } from "./web-commands.ts";
import type { PageRoute, PageRouteOptions } from "./web-pages.ts";
import type { WebSessionCaller } from "./caller.ts";

export type { WebResult } from "./web-commands.ts";
export { sessionCookiesOf, type SessionCookie } from "./session-renewal.ts";
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
  // The install's GitHub App, which the operations that ask GitHub, such as creating an invite, call it as.
  const github = createInstallGitHub({ database, secrets, logger });
  const signIn = createSignInService({
    database,
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    secrets,
    // The sign-in that completes setup releases the deliveries held during setup.
    jobs,
    // Its authorization server fetches Client ID Metadata Documents unless TIEHALL_CLIENT_METADATA_FETCH is off.
    agentClients: agentClientsOf(env),
    logger,
  });
  services = {
    database,
    secrets,
    signIn,
    execute: createExecute({
      catalog: CATALOG,
      handlers: HANDLERS,
      store: { database, jobs },
      confirmations,
      subjects: CONFIRMATION_SUBJECTS,
      github,
      secrets,
      url: installUrl(env["TIEHALL_URL"] ?? ""),
    }),
    step: createConfirmationStep({ catalog: CATALOG, reviews: REVIEWS, store: { database }, confirmations, subjects: CONFIRMATION_SUBJECTS, github }),
    logger,
  };
  return services;
}

/**
 * How the web role's authorization server takes agent clients: it fetches
 * their Client ID Metadata Documents, through the install's outbound fetcher,
 * unless TIEHALL_CLIENT_METADATA_FETCH is off (agent-access: The operator can
 * switch metadata-document fetching off).
 */
export function agentClientsOf(env: Environment): AgentClientOptions {
  return { metadataDocuments: readClientMetadataFetch(env) };
}

/** The REST route under /api/v1, built once per process from the install's settings. */
export function restRoute(env: Environment): RestHandler {
  if (rest !== undefined) return rest;
  const { execute, logger, signIn, database } = servicesOf(env);
  const url = installUrl(env["TIEHALL_URL"] ?? "");
  rest = createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute,
    // A call acts for the user its access token names, checked against the keys the sign-in service signs them
    // with, read in this process (agent-access: Tiehall is the authorization server for agent clients), or its
    // personal access token names, looked up in the install's database.
    authenticate: createAgentTokenCheck({ url, signingKeys: () => signIn.signingKeys(), database }),
    resourceMetadata: resourceMetadataUrlOf(url),
    logger,
  });
  return rest;
}

let requestUrls: RequestUrlRoute | undefined;

/**
 * Request URLs, /<KEY> with or without .md or .json, which the proxy answers
 * before any route, built once per process from the install's settings
 * (agent-surfaces: Negotiated request URLs): they read a request through the
 * same execute() as /api/v1, for a web session or an access token checked as
 * /api/v1 checks it, and let the web UI's request page render the HTML.
 */
export function requestUrlRoute(env: Environment): RequestUrlRoute {
  if (requestUrls !== undefined) return requestUrls;
  const { execute, logger, signIn, database } = servicesOf(env);
  const url = installUrl(env["TIEHALL_URL"] ?? "");
  requestUrls = createRequestUrlRoute({
    execute,
    session: (request, renewal) => webSession(env, request.headers, renewal),
    authenticate: createAgentTokenCheck({ url, signingKeys: () => signIn.signingKeys(), database }),
    url,
    resourceMetadata: resourceMetadataUrlOf(url),
    logger,
  });
  return requestUrls;
}

export { requestUrlOf } from "./negotiation.ts";
export { readRequestPageAs, type RequestPageData } from "./request-page-data.ts";

let mcp: McpRoute | undefined;

/**
 * The MCP endpoint at /mcp, built once per process from the install's
 * settings: it checks a call's token as /api/v1 does, and runs every tool
 * through the same execute().
 */
export function mcpRoute(env: Environment): McpRoute {
  if (mcp !== undefined) return mcp;
  const { execute, logger, signIn, database } = servicesOf(env);
  const url = installUrl(env["TIEHALL_URL"] ?? "");
  mcp = createMcpRoute({
    catalog: CATALOG,
    execute,
    authenticate: createAgentTokenCheck({ url, signingKeys: () => signIn.signingKeys(), database }),
    resourceMetadata: resourceMetadataUrlOf(url),
    database,
    ...(env["TIEHALL_VERSION"] === undefined ? {} : { version: env["TIEHALL_VERSION"] }),
    // A proposal's URL-mode elicitation opens its confirm page on the install; its request state is signed with a
    // key derived from TIEHALL_AUTH_SECRET, read when the first state is minted or checked.
    url,
    secret: () => readAuthSecret(env),
    logger,
  });
  return mcp;
}

/**
 * What the web UI's server actions and server components run operations
 * through, as the signed-in user's web session, which the headers of the
 * request they answer name; built once per process. A server action's write
 * may renew the session and hands back the cookies that renew it; a server
 * component's read renews nothing.
 */
export function webCommands(env: Environment, requestHeaders: () => Promise<Headers>): WebCommands {
  if (web !== undefined) return web;
  const { execute, logger, signIn } = servicesOf(env);
  web = createWebCommands({
    execute,
    session: async (renewal) => signIn.session(await requestHeaders(), renewal),
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
    redirects: CONFIRM_REDIRECTS,
    entries: CONFIRM_ENTRIES,
    messages: CONFIRM_MESSAGES,
    session: (request, renewal) => signIn.session(request.headers, renewal),
    write: { execute, url: installUrl(env["TIEHALL_URL"] ?? ""), secret: () => readAuthSecret(env) },
    logger,
  });
  return confirm;
}

/** The activity log's page under /admin/activity-log, built once per process, for the signed-in admin's web session. */
export function activityLogRoute(env: Environment): ActivityLogRoute {
  if (activityLog !== undefined) return activityLog;
  activityLog = createActivityLogRoute(pageOptionsOf(env));
  return activityLog;
}

let githubAdmin: GitHubAdminRoute | undefined;

/** The GitHub page of the admin UI under /admin/github, built once per process, for the signed-in admin's web session. */
export function githubAdminRoute(env: Environment): GitHubAdminRoute {
  if (githubAdmin !== undefined) return githubAdmin;
  const { execute, logger, signIn } = servicesOf(env);
  githubAdmin = createGitHubAdminRoute({
    execute,
    session: (request, renewal) => signIn.session(request.headers, renewal),
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    logger,
  });
  return githubAdmin;
}

/** What every page of the web UI is built with: execute(), the signed-in session, the install's URL and the auth secret. */
function pageOptionsOf(env: Environment): PageRouteOptions {
  const { execute, logger, signIn } = servicesOf(env);
  return {
    execute,
    session: (request, renewal) => signIn.session(request.headers, renewal),
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    logger,
  };
}

const pages = new Map<string, PageRoute>();

/** A page of the web UI, built once per process. */
function pageOf(name: string, env: Environment, create: (options: PageRouteOptions) => PageRoute): PageRoute {
  let route = pages.get(name);
  if (route === undefined) {
    route = create(pageOptionsOf(env));
    pages.set(name, route);
  }
  return route;
}

/** The members page at /members, which every member may open, for the signed-in user's web session. */
export function membersRoute(env: Environment): PageRoute {
  return pageOf("members", env, createMembersRoute);
}

/** The web form that opens a request, at /requests/new, which every member of a team may use, for the signed-in user's web session. */
export function newRequestRoute(env: Environment): PageRoute {
  return pageOf("new request", env, createNewRequestRoute);
}

/** The request lists at /requests, which every member may open, for the signed-in user's web session. */
export function requestListsRoute(env: Environment): PageRoute {
  return pageOf("request lists", env, createRequestListsRoute);
}

/** The invites page of the admin UI under /admin/invites, for the signed-in admin's web session. */
export function invitesRoute(env: Environment): PageRoute {
  return pageOf("invites", env, createInvitesRoute);
}

/** The teams page of the admin UI under /admin/teams, for the signed-in admin's web session. */
export function teamsRoute(env: Environment): PageRoute {
  return pageOf("teams", env, createTeamsRoute);
}

/**
 * The "Connected agents and tokens" page at /tokens, where every member creates
 * their personal access tokens, for the signed-in user's web session.
 */
export function tokensRoute(env: Environment): PageRoute {
  return pageOf("tokens", env, createTokensRoute);
}

/** The sign-in policy page of the admin UI under /admin/sign-in-policy, for the signed-in admin's web session. */
export function signInPolicyRoute(env: Environment): PageRoute {
  return pageOf("sign-in policy", env, createSignInPolicyRoute);
}

/**
 * The personal access tokens page of the admin UI under
 * /admin/personal-access-tokens, for the signed-in admin's web session.
 */
export function personalAccessTokenSettingsRoute(env: Environment): PageRoute {
  return pageOf("personal access tokens", env, createPersonalAccessTokenSettingsRoute);
}

/**
 * The sign-in service's routes under /api/auth, such as GitHub's return to the
 * sign-in callback (sign-in: GitHub is the only way to sign in).
 */
export function signInServiceRoute(env: Environment): (request: Request) => Promise<Response> {
  const { signIn } = servicesOf(env);
  return (request) => signIn.handler(request);
}

/**
 * The discovery documents of the install's authorization server under
 * /.well-known: the protected resource metadata of its MCP resource and the
 * authorization server metadata (agent-access: Tiehall is the authorization
 * server for agent clients), which the sign-in service serves.
 */
export function wellKnownRoute(env: Environment): (request: Request) => Promise<Response> {
  const { signIn } = servicesOf(env);
  return (request) => signIn.handler(request);
}

let consent: ConsentRoute | undefined;

/**
 * The consent screen at /consent, where a signed-in member approves an agent
 * client (agent-access: The consent screen shows who is asking), built once
 * per process, for the signed-in user's web session.
 */
export function consentRoute(env: Environment): ConsentRoute {
  if (consent !== undefined) return consent;
  const { step, logger, signIn } = servicesOf(env);
  consent = createConsentRoute({
    step,
    session: (request, renewal) => signIn.session(request.headers, renewal),
    secret: () => readAuthSecret(env),
    logger,
  });
  return consent;
}

let deviceApproval: DeviceApprovalRoute | undefined;

/**
 * The device approval page at /device, where a signed-in member approves the
 * code `tiehall login` printed (agent-access: The device approval page cannot
 * be prefilled), built once per process, for the signed-in user's web session.
 */
export function deviceApprovalRoute(env: Environment): DeviceApprovalRoute {
  if (deviceApproval !== undefined) return deviceApproval;
  const { step, logger, signIn } = servicesOf(env);
  deviceApproval = createDeviceApprovalRoute({
    step,
    session: (request, renewal) => signIn.session(request.headers, renewal),
    url: installUrl(env["TIEHALL_URL"] ?? ""),
    secret: () => readAuthSecret(env),
    logger,
  });
  return deviceApproval;
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
  homePage = createHomeRoute({ session: (request, renewal) => webSession(env, request.headers, renewal), secret: () => readAuthSecret(env), logger });
  return homePage;
}

/** The web UI's sign-out at /sign-out, which ends the session the request's cookie names. */
export function signOutRoute(env: Environment): (request: Request) => Promise<Response> {
  const { signIn } = servicesOf(env);
  return (request) => signIn.signOut(request);
}

/**
 * The web session the request's cookie names, or undefined when it names
 * none; a session a removal ended is refused with 403 removed-member. Given
 * `renewal`, as a route handler gives it, the read may renew the session and
 * adds there the cookies the route's answer carries.
 */
export function webSession(env: Environment, headers: Headers, renewal?: Headers): Promise<WebSessionCaller | undefined> {
  // A request without a session cookie reaches neither the database nor the settings.
  if (!/(?:^|;\s*)(?:__Secure-)?tiehall\.session_token=/.test(headers.get("cookie") ?? "")) return Promise.resolve(undefined);
  return servicesOf(env).signIn.session(headers, renewal);
}
