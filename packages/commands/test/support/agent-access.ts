import { createHash, randomBytes, randomInt } from "node:crypto";
import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import {
  CLI_CLIENT_ID,
  createAgentTokenCheck,
  createConsentRoute,
  createDeviceApprovalRoute,
  createMcpRoute,
  createRestHandler,
  createTokensRoute,
  DEVICE_CODE_GRANT_TYPE,
  resourceMetadataUrlOf,
  TOKENS_PATH,
  type AgentClientOptions,
  type AgentTokenCheck,
  type McpRoute,
  type RestHandler,
} from "../../src/index.ts";
import { scanApiAnswer, scanMcpAnswer } from "./confirm-url-scan.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./install.ts";
import { addUser } from "./members.ts";
import { startSignIn, type SignInHarness } from "./sign-in.ts";

// Agent access for tests (agent-access: Tiehall is the authorization server
// for agent clients; design.md, Technical decisions: T7 and T9): an install
// whose setup is complete, its sign-in service against the GitHub stub, and
// one handler that answers as the web role routes a call: the sign-in
// service's routes under /api/auth and the discovery documents under
// /.well-known go to the sign-in service, which is the install's OAuth
// authorization server, /api/v1 to the REST route and /mcp to the MCP route,
// each of which checks the access token a call carries, and the sign-in page, the consent screen, the device
// approval page, the Connected agents and tokens page and the review pages of
// the confirmation step to their pages.
// An agent client plays its part through plain HTTP: it registers, sends the
// person's browser to the authorization endpoint with PKCE and a resource,
// and exchanges the code it gets back.

/** Where the agent clients of the tests are sent back to: a port on the client's own computer. */
export const CLIENT_REDIRECT_URI = "http://127.0.0.1:53682/callback";
/** The install's MCP resource, the audience of the access tokens it issues. */
export const MCP_RESOURCE = `${URL_OF_INSTALL}/mcp`;

/** A clock a test moves forward, which the token check reads the time by. */
export interface TestClock {
  now(): Date;
  advance(milliseconds: number): void;
}

/** An agent client of the install, as it registered. */
export interface AgentClient {
  clientId: string;
  redirectUri: string;
}

/** A PKCE pair: the verifier the client keeps and the S256 challenge it sends. */
export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A person signed in to the web UI: their user and the Cookie header of their browser. */
export interface SignedIn {
  userId: string;
  cookie: string;
}

/** What the token endpoint answered. */
export interface TokenAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface AgentAccessHarness {
  install: TestInstall;
  stub: GitHubStub;
  signIn: SignInHarness;
  clock: TestClock;
  /** Answers a call as the web role routes it: /api/auth and /.well-known to the sign-in service, /api/v1 to REST, /mcp to MCP. */
  handle(request: Request): Promise<Response>;
  /** A member of the install, signed in to the web UI with GitHub. */
  member(login: string): Promise<SignedIn>;
  /** Registers a client through Dynamic Client Registration, with these fields over a native client's. */
  register(metadata?: Record<string, unknown>, headers?: Record<string, string>): Promise<Response>;
  /** Registers a client and returns it; fails the test on any other answer. */
  registerClient(metadata?: Record<string, unknown>): Promise<AgentClient>;
  /** Stores the grant a confirmed approval of this client by this user stores, for these scopes. */
  approve(userId: string, clientId: string, scopes: readonly string[]): Promise<void>;
  /**
   * Sends the person's browser to the authorization endpoint with these
   * parameters over a complete request, and these headers besides its cookie,
   * such as the client address the web role's request guard names.
   */
  authorize(cookie: string, client: AgentClient, pkce: Pkce, parameters?: Record<string, string | undefined>, headers?: Record<string, string>): Promise<Response>;
  /** Exchanges an authorization code for tokens. */
  exchange(client: AgentClient, code: string, pkce: Pkce): Promise<TokenAnswer>;
  /** Exchanges a refresh token for new tokens. */
  refresh(client: AgentClient, refreshToken: string): Promise<TokenAnswer>;
  /**
   * The whole flow for an approved client of a signed-in member: registers
   * the client, stores its grant, authorizes and exchanges the code; fails the
   * test when a step does not answer as it should.
   */
  tokens(person: SignedIn, scopes?: readonly string[]): Promise<{ client: AgentClient; accessToken: string; refreshToken: string | undefined }>;
  /** A new check of access tokens, as a process that has not read the install's keys yet has, on the same clock. */
  freshTokenCheck(): AgentTokenCheck;
  /** Calls /api/v1 with these headers. */
  api(method: string, path: string, headers?: Record<string, string>, body?: unknown): Promise<Response>;
  /**
   * Creates a personal access token for a signed-in member as they do in the
   * web UI: the form of the Connected agents and tokens page, its review page
   * and its confirmation, which carries these headers besides, such as the
   * client address the web role's request guard names; returns the value the
   * confirmation's page shows, and fails the test when a step does not answer
   * as it should.
   */
  personalAccessToken(
    person: SignedIn,
    input?: { name?: string; scopes?: readonly string[]; expiresInDays?: number },
    headers?: Record<string, string>,
  ): Promise<string>;
  /**
   * Signs the tiehall CLI in for a signed-in member as `tiehall login` and the
   * member do: the device authorization request, the code typed on the device
   * approval page, its confirmation and the CLI's poll; returns the CLI's
   * tokens, and fails the test when a step does not answer as it should.
   */
  signInCli(person: SignedIn, scopes?: readonly string[]): Promise<{ accessToken: string; refreshToken: string }>;
  /**
   * Approves a device code as the signed-in member does: the code typed on the
   * device approval page, and its confirmation; fails the test when a step
   * does not answer as it should.
   */
  approveDevice(person: SignedIn, userCode: string): Promise<void>;
  close(): Promise<void>;
}

export function pkcePair(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A native agent client's registration, as MCP clients send it. */
function registration(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    client_name: "Test agent",
    redirect_uris: [CLIENT_REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
    ...metadata,
  };
}

/** How the install takes agent clients, such as the fetcher of their metadata documents, which a test routes to a local server. */
export interface AgentAccessOptions {
  clientMetadata?: AgentClientOptions;
  /** How the long-poll waits hold: a shorter hold, or a shutdown signal of the test's own. */
  wait?: { holdMs?: number; shutdown?: AbortSignal };
  /** The time the install's execute() tells, such as a test's clock that a contract report's burst runs on; the real time unless given. */
  now?: () => Date;
}

export async function startAgentAccess(options: AgentAccessOptions = {}): Promise<AgentAccessHarness> {
  const install = await startTestInstall({ ...(options.wait === undefined ? {} : { wait: options.wait }), ...(options.now === undefined ? {} : { now: options.now }) });
  const stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const signIn = await startSignIn(install, stub, options.clientMetadata === undefined ? {} : { agentClients: options.clientMetadata });
  let offset = 0;
  const clock: TestClock = {
    now: () => new Date(Date.now() + offset),
    advance(milliseconds) {
      offset += milliseconds;
    },
  };
  // /api/v1 checks access tokens as the web role does: against the keys the sign-in service signs them with.
  const freshTokenCheck = () =>
    createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: () => signIn.service.signingKeys(), now: clock.now, database: install.db });
  const rest: RestHandler = createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute: install.execute,
    authenticate: freshTokenCheck(),
    resourceMetadata: resourceMetadataUrlOf(URL_OF_INSTALL),
    logger: install.logger,
  });

  // /mcp checks access tokens the same way, and runs every tool through the same execute().
  const mcp: McpRoute = createMcpRoute({
    catalog: CATALOG,
    execute: install.execute,
    authenticate: freshTokenCheck(),
    resourceMetadata: resourceMetadataUrlOf(URL_OF_INSTALL),
    database: install.db,
    // A proposal's URL-mode elicitation opens its confirm page on the install, and its state is signed with the auth secret.
    url: URL_OF_INSTALL,
    secret: () => install.authSecret,
    logger: install.logger,
  });

  const session = (request: Request, renewal?: Headers) => signIn.service.session(request.headers, renewal);
  const consent = createConsentRoute({ step: install.step, session, secret: install.authSecret, logger: install.logger });
  // The review pages of the confirmation step, for whoever the browser's session names.
  const confirm = install.confirmRouteFor(session);
  // The device approval page, where a member approves the code `tiehall login` printed.
  const device = createDeviceApprovalRoute({ step: install.step, session, url: URL_OF_INSTALL, secret: install.authSecret, logger: install.logger });
  // The Connected agents and tokens page, where a member creates a personal access token.
  const tokens = createTokensRoute({ execute: install.execute, session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/auth/") || pathname.startsWith("/.well-known/")) return signIn.service.handler(request);
    // What agents and the CLI read here holds no confirm URL (confirm-url-scan.ts): /api/v1's answers, and /mcp's
    // but an event stream subscriptions/listen holds open, which carries no tool result.
    if (pathname.startsWith("/api/v1/")) {
      const response = await rest(request);
      await scanApiAnswer(request, response);
      return response;
    }
    if (pathname === "/mcp") {
      const listens = request.method === "POST" && (await request.clone().text()).includes('"subscriptions/listen"');
      const response = await mcp(request);
      if (!listens) await scanMcpAnswer(response, `${request.method} /mcp (${response.status})`);
      return response;
    }
    if (pathname === "/consent") return consent(request);
    if (pathname === "/device") return device(request);
    if (pathname === TOKENS_PATH) return tokens(request);
    if (pathname.startsWith("/confirm/")) return confirm(request);
    if (pathname === "/sign-in") return signIn.service.page(request);
    return new Response("Not found", { status: 404 });
  };

  // Each registration comes from a client address of its own, as the web role's request guard names it, unless the
  // test names one: one address registers at most 10 clients an hour.
  const register: AgentAccessHarness["register"] = (metadata = {}, headers = {}) =>
    handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`, ...headers },
        body: JSON.stringify(registration(metadata)),
      }),
    );

  const token = async (form: Record<string, string>): Promise<TokenAnswer> => {
    const answer = await handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),
    );
    return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
  };

  const harness: AgentAccessHarness = {
    install,
    stub,
    signIn,
    clock,
    handle,
    async member(login) {
      const account = stub.addUser({ login, email: `${login}@acme.example` });
      const userId = await addUser(install.owner, { login, githubAccountId: account.id });
      const { jar } = await signIn.signIn(login);
      return { userId, cookie: jar.header() };
    },
    register,
    async registerClient(metadata = {}) {
      const answer = await register(metadata);
      const body = (await answer.json()) as { client_id?: string };
      if (answer.status !== 201 || typeof body.client_id !== "string") throw new Error(`the registration answered ${answer.status}: ${JSON.stringify(body)}`);
      return { clientId: body.client_id, redirectUri: CLIENT_REDIRECT_URI };
    },
    async approve(userId, clientId, scopes) {
      await install.owner.query(
        `INSERT INTO oauth_consents (org_id, client_id, user_id, scopes, resources, requested_user_info_claims, created_at, updated_at)
           SELECT id, $1, $2, $3, $4, '{}', now(), now() FROM orgs`,
        [clientId, userId, [...scopes, "offline_access"], [MCP_RESOURCE]],
      );
    },
    authorize(cookie, client, pkce, parameters = {}, headers = {}) {
      const query = new URLSearchParams();
      const all: Record<string, string | undefined> = {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state: "state-1",
        resource: MCP_RESOURCE,
        scope: "requests:read requests:write",
        ...parameters,
      };
      for (const [name, value] of Object.entries(all)) if (value !== undefined) query.set(name, value);
      return handle(new Request(`${URL_OF_INSTALL}/api/auth/oauth2/authorize?${query}`, { headers: { ...headers, cookie, accept: "text/html" } }));
    },
    exchange: (client, code, pkce) =>
      token({
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        resource: MCP_RESOURCE,
      }),
    refresh: (client, refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId }),
    async tokens(person, scopes = ["requests:read", "requests:write"]) {
      const client = await harness.registerClient();
      await harness.approve(person.userId, client.clientId, scopes);
      const pkce = pkcePair();
      const answer = await harness.authorize(person.cookie, client, pkce, { scope: scopes.join(" ") });
      const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
      const code = location.searchParams.get("code");
      if (code === null) throw new Error(`the authorization answered ${answer.status} to ${location.toString()}`);
      const exchanged = await harness.exchange(client, code, pkce);
      const accessToken = exchanged.body["access_token"];
      const refreshToken = exchanged.body["refresh_token"];
      if (exchanged.status !== 200 || typeof accessToken !== "string") throw new Error(`the token endpoint answered ${exchanged.status}: ${JSON.stringify(exchanged.body)}`);
      return { client, accessToken, refreshToken: typeof refreshToken === "string" ? refreshToken : undefined };
    },
    freshTokenCheck,
    api: (method, path, headers = {}, body) =>
      handle(
        new Request(`${URL_OF_INSTALL}${path}`, {
          method,
          headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    async personalAccessToken(person, input = {}, headers = {}) {
      const fromThePage = { cookie: person.cookie, accept: "text/html", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" };
      const page = await (await handle(new Request(`${URL_OF_INSTALL}${TOKENS_PATH}`, { headers: { cookie: person.cookie, accept: "text/html" } }))).text();
      const form = new URLSearchParams({ action: "create", name: input.name ?? "A script", expiresInDays: String(input.expiresInDays ?? 30), csrf: hiddenField(page, "csrf") });
      for (const scope of input.scopes ?? ["requests:read", "requests:write"]) form.append("scope", scope);
      const posted = await handle(
        new Request(`${URL_OF_INSTALL}${TOKENS_PATH}`, { method: "POST", headers: { ...fromThePage, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }),
      );
      const reviewPath = posted.headers.get("location") ?? "";
      if (posted.status !== 303) throw new Error(`the form answered ${posted.status}: ${await posted.text()}`);
      const review = await handle(new Request(`${URL_OF_INSTALL}${reviewPath}`, { headers: { cookie: person.cookie, accept: "text/html" } }));
      const html = await review.text();
      if (review.status !== 200) throw new Error(`the review page answered ${review.status}: ${html}`);
      const confirmed = await handle(
        new Request(`${URL_OF_INSTALL}/confirm/personal_access_tokens.create`, {
          method: "POST",
          headers: { ...headers, ...fromThePage, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
        }),
      );
      const shown = await confirmed.text();
      const token = /<pre><code>(th_pat_[A-Za-z0-9_-]+)<\/code><\/pre>/.exec(shown)?.[1];
      if (confirmed.status !== 200 || token === undefined) throw new Error(`the confirmation answered ${confirmed.status}: ${shown}`);
      return token;
    },
    async signInCli(person, scopes = ["requests:read", "requests:write"]) {
      const form = (fields: Record<string, string>) => ({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
      const started = await handle(
        new Request(`${URL_OF_INSTALL}/api/auth/device/code`, form({ client_id: CLI_CLIENT_ID, resource: MCP_RESOURCE, scope: scopes.join(" ") })),
      );
      const { device_code: deviceCode, user_code: userCode } = (await started.json()) as { device_code?: string; user_code?: string };
      if (started.status !== 200 || deviceCode === undefined || userCode === undefined) throw new Error(`the device authorization answered ${started.status}`);
      await harness.approveDevice(person, userCode);
      const polled = await token({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: deviceCode, client_id: CLI_CLIENT_ID });
      const accessToken = polled.body["access_token"];
      const refreshToken = polled.body["refresh_token"];
      if (polled.status !== 200 || typeof accessToken !== "string" || typeof refreshToken !== "string") {
        throw new Error(`the CLI's poll answered ${polled.status}: ${JSON.stringify(polled.body)}`);
      }
      return { accessToken, refreshToken };
    },
    async approveDevice(person, userCode) {
      const fromThePage = { cookie: person.cookie, accept: "text/html", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
      const page = await (await handle(new Request(`${URL_OF_INSTALL}/device`, { headers: { cookie: person.cookie } }))).text();
      const review = await handle(
        new Request(`${URL_OF_INSTALL}/device`, { method: "POST", headers: fromThePage, body: new URLSearchParams({ user_code: userCode, csrf: hiddenField(page, "csrf") }).toString() }),
      );
      const html = await review.text();
      if (review.status !== 200) throw new Error(`the device approval page answered ${review.status}: ${html}`);
      const approved = await handle(
        new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve_device`, {
          method: "POST",
          headers: fromThePage,
          body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
        }),
      );
      if (approved.status !== 200) throw new Error(`the approval answered ${approved.status}: ${await approved.text()}`);
    },
    async close() {
      await stub.close();
      await install.close();
    },
  };
  return harness;
}

/** A hidden field's value on a page, as the page escaped it. */
export function hiddenField(html: string, name: string): string {
  const value = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? "";
  return value.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
