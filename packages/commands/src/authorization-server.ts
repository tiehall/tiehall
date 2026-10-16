import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt, signJWT } from "better-auth/plugins";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { SCOPES } from "@tiehall/catalog";
import { clientIdUrlWithinBounds, clientMetadataBoundsProblem, holdsNul, metadataDocumentForLibrary } from "./agent-clients.ts";
import { DEVICE_APPROVAL_PATH, DEVICE_CODE_LIFETIME_SECONDS } from "./device-flow.ts";
import { createOutboundFetcher, type OutboundFetcher } from "./outbound.ts";

// The install's OAuth 2.1 authorization server for agent clients
// (agent-access: Tiehall is the authorization server for agent clients;
// design.md, Design rules: Agent access; design.md, Technical decisions: T7
// and T9). It lives in the sign-in service, as plugins of its instance, so the
// person who approves an agent client is the one signed in to the web UI:
// - `jwt()` holds the install's signing keys, an Ed25519 key pair whose
//   private key is stored encrypted with the install's auth secret, and
//   serves only the public keys. No session JWT is set on any answer: the
//   keys sign access tokens only.
// - `mcp()` is the authorization server: its issuer is the install's URL,
//   TIEHALL_URL, and its one protected resource is the install's MCP
//   resource, TIEHALL_URL/mcp, whose access tokens /api/v1 accepts too. It
//   serves the protected resource metadata (RFC 9728) and the authorization
//   server metadata (RFC 8414) under /.well-known/. It offers only the
//   authorization code grant with refresh tokens; its access tokens are JWTs
//   that live 600 seconds, and a refresh token is used once: presented again,
//   it is refused, and every refresh token of that client for that user with
//   it. Dynamic Client Registration is on, for clients that register without
//   credentials.
// - `cimd()` identifies a client whose client_id is an https URL by the Client
//   ID Metadata Document at that URL, which is preferred to registration
//   (agent-access: Clients identified by a Client ID Metadata Document are
//   preferred). The document is fetched only through the install's outbound
//   fetcher (outbound.ts), which resolves the host itself, refuses an internal
//   address without connecting to it, and here follows no redirect; the
//   client counts as identified only when the document's client_id equals the
//   URL exactly, and a document whose texts hold a NUL character, which no
//   text Tiehall stores may hold, or that breaks the bounds of a client's
//   metadata (agent-clients.ts), is refused with invalid_client like one the
//   plugin cannot read; so is a URL of more than 1,024 characters, or one
//   not written in printable ASCII with no space, as RFC 3986 writes a URL,
//   whose characters could take up to four times as many bytes, which is not
//   fetched (decisions-from-groups-15-28: design.md, Decisions this change
//   rests on: D55 (25)). At most 60 documents a minute are fetched from one
//   host, on whatever port its URL names, and an authorization request that
//   cannot be checked because its host's limit is used up gets 429 with
//   Retry-After; no other limit on the fetches applies.
// - Tiehall offers exactly three scopes, requests:read, requests:write and
//   contracts:report, and no admin scope (agent-access: OAuth scopes are
//   coarse): a scope an authorization request asks for that is not one of
//   them is refused with invalid_scope, and a request that asks for none gets
//   requests:read and requests:write. Every grant brings a refresh token,
//   which the authorization server issues only with offline_access: so the
//   request each client sends is completed with it before the server reads
//   it. A client that asks for offline_access itself, as clients built for
//   OpenID-style servers do, is not refused for it: the scope is ignored,
//   so a request that names it alone gets the default scopes, and the token
//   endpoint's answer and the scope claim of the access token it signs name
//   only the scopes Tiehall offers, never offline_access, which the grant
//   and its refresh token keep, so that each refresh brings a new one
//   (decisions-from-groups-15-28: design.md, Decisions this change rests on:
//   D55 (12), (13); Technical decisions: T4). Where an agent client learns
//   which scopes to ask for, the install names only requests:read and
//   requests:write: the scopes_supported of the protected resource metadata
//   and of the authorization server metadata list those two, so a client that
//   asks for every listed scope, as Codex did, gets no contracts:report. The
//   scope stays offered to a request that names it, the CLI's included, and
//   a registration's answer still names it among the client's scopes (D55
//   (13), as the maintainer answered on 2026-10-16).
// - An authorization request, and the token request that follows it, that
//   names no resource is completed with the install's one resource,
//   TIEHALL_URL/mcp, before the server reads it, so its access token's
//   audience is that resource and /mcp and /api/v1 both accept it, as the
//   device flow's are (agent-access: Authorization requests use PKCE S256,
//   resource indicators and the iss parameter; D55 (23)).
// - `oauthDeviceAuthorization()` offers the device authorization grant, which
//   only the `tiehall` CLI may use (device-flow.ts): its codes expire after 10
//   minutes, a person approves one on the install's device approval page, and
//   the CLI exchanges it at the token endpoint for tokens like any grant's.
// The service keeps the records of both in Tiehall's own tables, each row
// with the install's org id, which the plugins do not know about, so each of
// their tables gains the field with the org's id as its value.
//
// Checking an access token makes no outbound call: it reads the install's
// public keys in the same process (agent-tokens.ts), rather than fetching
// them from the JWKS endpoint.

/** Where the install's MCP endpoint lives, which is its protected resource. */
export const MCP_PATH = "/mcp";

/** How long an access token lives: 10 minutes. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 600;

/**
 * The scope the authorization server grants besides the three OAuth scopes,
 * so that the client gets a refresh token. It is none of the scopes Tiehall
 * offers: no metadata lists it, and no operation needs it.
 */
export const REFRESH_SCOPE = "offline_access";

/** What an authorization request that names no scope is granted. */
export const DEFAULT_SCOPES: readonly string[] = ["requests:read", "requests:write"];

/** What a scope Tiehall does not offer is renamed to, so the authorization server refuses it with invalid_scope. */
const NOT_OFFERED = "not-offered:";

/** The page the authorization server sends a person to sign in on, before it asks them to approve a client. */
export const AUTHORIZATION_SIGN_IN_PATH = "/sign-in";
/** The consent screen, where a signed-in member approves an agent client. */
export const CONSENT_PATH = "/consent";
/** The authorization endpoint, under the sign-in service's routes at /api/auth. */
export const AUTHORIZATION_ENDPOINT_PATH = "/api/auth/oauth2/authorize";

/** The install's MCP resource, the audience of every access token it issues: TIEHALL_URL/mcp. */
export function mcpResourceOf(url: string): string {
  return `${url}${MCP_PATH}`;
}

/** Where the authorization server metadata is served (RFC 8414). */
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * The authorization server metadata as the install serves it: as the sign-in
 * library writes it, without its introspection endpoint and that endpoint's
 * methods. The install checks its own access tokens in the same process, and
 * its introspection route answers 404 (sign-in-routes.ts), so the metadata
 * names no endpoint a client could not use.
 */
export async function servedMetadata(answer: Response): Promise<Response> {
  if (answer.status !== 200) return answer;
  const metadata = (await answer.json()) as Record<string, unknown>;
  const served = Object.fromEntries(Object.entries(metadata).filter(([key]) => !key.startsWith("introspection_")));
  const headers = new Headers(answer.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(served), { status: answer.status, headers });
}

/** Where the protected resource metadata of the install's MCP resource is served. */
export function resourceMetadataUrlOf(url: string): string {
  return `${url}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** The authorization server's tables, by the model names its plugins use, as Tiehall's schema names them. */
const MODEL_NAMES = {
  jwks: "oauthSigningKeys",
  oauthClient: "oauthClients",
  oauthResource: "oauthResources",
  oauthClientResource: "oauthClientResources",
  oauthRefreshToken: "oauthRefreshTokens",
  oauthAccessToken: "oauthAccessTokens",
  oauthConsent: "oauthConsents",
  oauthClientAssertion: "oauthClientAssertions",
  deviceCode: "oauthDeviceCodes",
} as const;

/** How many Client ID Metadata Documents the install fetches from one host in a minute, at most. */
export const METADATA_FETCHES_PER_HOST_PER_MINUTE = 60;

/** How the authorization server takes agent clients. */
export interface AgentClientOptions {
  /** Whether Client ID Metadata Documents are fetched (TIEHALL_CLIENT_METADATA_FETCH); on unless off. */
  metadataDocuments?: boolean;
  /** The fetcher of metadata documents: the install's outbound fetcher, following no redirect, unless a test gives one. */
  fetchDocument?: OutboundFetcher;
  /** The clock registrations, the CLI's polls and the sign-in service's other limits are counted by; the system clock unless a test controls it. */
  now?: () => Date;
}

export interface AuthorizationServerOptions {
  /** The install's URL (TIEHALL_URL), as its origin: the issuer. */
  url: string;
  /** The install's org, whose id every row the plugins store carries. */
  orgId: string;
  clients?: AgentClientOptions;
  /** The number of a user's current membership, which each access token issued for them names; none for a user who is no member, or whose membership has none. */
  membershipOf?: (userId: string) => Promise<number | undefined>;
}

/**
 * The claim of an access token that names the membership of its user it was
 * issued in, by the number each new membership takes (members.ts): a removal
 * ends the membership, so a token of it is refused once the user is a member
 * again (with-org.ts), whatever the clocks say.
 */
export const MEMBERSHIP_CLAIM = "tiehall_membership";

/** The sign-in service's plugins that make it the install's authorization server for agent clients. */
export function authorizationServerPlugins({ url, orgId, clients = {}, membershipOf }: AuthorizationServerOptions): BetterAuthPlugin[] {
  const signingKeyOptions = {
    jwt: { issuer: url },
    disableSettingJwtHeader: true,
    schema: { jwks: { modelName: MODEL_NAMES.jwks } },
  };
  const signingKeys = jwt(signingKeyOptions);
  const server = mcp({
    resource: mcpResourceOf(url),
    loginPage: AUTHORIZATION_SIGN_IN_PATH,
    consentPage: CONSENT_PATH,
    scopes: [...SCOPES, REFRESH_SCOPE],
    // Both metadata documents, the protected resource's and the authorization server's, list the scopes an agent asks for.
    advertisedMetadata: { scopes_supported: [...DEFAULT_SCOPES] },
    clientRegistrationDefaultScopes: [...SCOPES, REFRESH_SCOPE],
    accessTokenExpiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // A used refresh token is refused at once, with no window in which it is taken again.
    refreshTokenReuseInterval: 0,
    // Each access token names the membership of its user it was issued in, the device flow's too.
    customAccessTokenClaims: async ({ user }) => {
      const membership = user === undefined || user === null || membershipOf === undefined ? undefined : await membershipOf(user.id);
      return membership === undefined ? {} : { [MEMBERSHIP_CLAIM]: membership };
    },
    // Registrations are limited per client address and hour, as agent-access says (15.8), not by the plugin's
    // five a minute; its limits on the token, authorization and revocation endpoints stay, though the token
    // endpoint's does not count the CLI's polls with its device code, which have a limit of their own (device-flow.ts).
    rateLimit: { register: false },
    schema: {
      oauthClient: { modelName: MODEL_NAMES.oauthClient },
      oauthResource: { modelName: MODEL_NAMES.oauthResource },
      oauthClientResource: { modelName: MODEL_NAMES.oauthClientResource },
      oauthRefreshToken: { modelName: MODEL_NAMES.oauthRefreshToken },
      oauthAccessToken: { modelName: MODEL_NAMES.oauthAccessToken },
      oauthConsent: { modelName: MODEL_NAMES.oauthConsent },
      oauthClientAssertion: { modelName: MODEL_NAMES.oauthClientAssertion },
    },
  });
  // The CLI's device flow: no validateClient, which would admit any client; the guard in device-flow.ts admits the CLI alone.
  const deviceFlow = oauthDeviceAuthorization({
    expiresIn: `${DEVICE_CODE_LIFETIME_SECONDS}s`,
    interval: "5s",
    verificationUri: `${url}${DEVICE_APPROVAL_PATH}`,
    schema: { deviceCode: { modelName: MODEL_NAMES.deviceCode } },
  });
  // The plugin's endpoint types are stricter than the plugin interface under exactOptionalPropertyTypes; it is one.
  const plugins = [
    withOrgId(signingKeys, orgId),
    withOrgId(server as unknown as BetterAuthPlugin, orgId),
    withOrgId(deviceFlow as unknown as BetterAuthPlugin, orgId),
    offeredScopes(mcpResourceOf(url), signingKeyOptions),
    pkceRefusals(),
  ];
  if (clients.metadataDocuments !== false) plugins.push(metadataDocuments(clients.fetchDocument ?? createOutboundFetcher({ maxRedirects: 0 })));
  return plugins;
}

/** A document's JSON, or undefined for a body that is not JSON, which the plugin refuses itself. */
function parsedJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** How long the fetches of a host are counted for: a minute. */
const FETCH_WINDOW_MS = 60_000;

/**
 * Counts the metadata-document fetches from each host, whatever port the URL
 * names, over the past minute, in this process's memory (one web process per
 * install); refuses a fetch beyond the host's 60 with the answer the sign-in
 * service turns into the error model's 429.
 */
function fetchesPerHost(): (url: string) => void {
  const byHost = new Map<string, number[]>();
  return (url) => {
    const now = Date.now();
    // Hosts with no fetch in the past minute are forgotten, so the count keeps no more than a minute's hosts.
    if (byHost.size > 10_000) for (const [host, times] of byHost) if (times.every((at) => now - at >= FETCH_WINDOW_MS)) byHost.delete(host);
    const host = new URL(url).hostname;
    const recent = (byHost.get(host) ?? []).filter((at) => now - at < FETCH_WINDOW_MS);
    if (recent.length >= METADATA_FETCHES_PER_HOST_PER_MINUTE) {
      byHost.set(host, recent);
      throw new APIError("TOO_MANY_REQUESTS", { error: "temporarily_unavailable", error_description: "metadata fetch rate limit exceeded for the client's host" });
    }
    recent.push(now);
    byHost.set(host, recent);
  };
}

/** The plugin that identifies clients by their Client ID Metadata Documents, fetched with this fetcher. */
function metadataDocuments(fetchDocument: OutboundFetcher): BetterAuthPlugin {
  const countFetch = fetchesPerHost();
  return cimd({
    metadataProfile: "mcp-2026-07-28",
    // The document's own answer, as the outbound fetcher gives it; a refused fetch fails the resolution of the client.
    fetchClientMetadataResource: async (input) => {
      const document = await fetchDocument(input instanceof Request ? input.url : input.toString());
      const headers = document.contentType === undefined ? {} : { "content-type": document.contentType };
      // No text Tiehall stores may hold a NUL character, and a client's metadata is bounded: a document that breaks
      // either is refused as the client's, as the plugin refuses a body it cannot read, and no client is stored.
      const parsed = document.status === 200 ? parsedJson(document.body) : undefined;
      // A document's redirect URIs follow a native client's rule, with a stand-in the library takes for each app's own
      // scheme (agent-clients.ts; decisions-from-groups-15-28: D55 (15), as the maintainer answered on 2026-10-16).
      const handed = metadataDocumentForLibrary(parsed);
      const problem = holdsNul(parsed)
        ? "The metadata document's texts hold a NUL character."
        : (clientMetadataBoundsProblem(parsed) ?? ("refused" in handed ? handed.refused : undefined));
      if (problem !== undefined) {
        const refused = new APIError("BAD_REQUEST", { error: "invalid_client", error_description: problem });
        return new Response(new ReadableStream({ start: (stream) => stream.error(refused) }), { status: 200, headers });
      }
      const body = "document" in handed && handed.document !== parsed ? JSON.stringify(handed.document) : document.body;
      return new Response(body, { status: document.status, headers });
    },
    // The one limit agent-access names: 60 fetches a minute from one host, which the plugin would count per origin, a
    // host and a port, so a client could name another port for each fetch. It is counted per host just before each
    // fetch, and the plugin's own limits are set out of reach.
    // A client_id URL longer than 1,024 characters, or not written in printable ASCII, is refused with invalid_client
    // before anything is fetched or counted.
    isMetadataDocumentUrlAllowed: (url) => {
      if (!clientIdUrlWithinBounds(url)) return false;
      countFetch(url);
      return true;
    },
    metadataFetchPolicy: {
      maximumFetchesPerOriginPerMinute: 1_000_000,
      maximumConcurrentFetchesPerOrigin: 1_000_000,
      maximumFetchesPerMinute: 1_000_000,
      maximumConcurrentFetches: 1_000_000,
      minimumFetchInterval: 0,
    },
  }) as unknown as BetterAuthPlugin;
}

/**
 * The scope an authorization request is read with: the scopes it asks for,
 * offline_access left out, or requests:read and requests:write when it names
 * no other, with a scope that is not one of the three renamed, so the
 * authorization server refuses it with invalid_scope, and offline_access
 * added, so the grant brings a refresh token.
 */
export function scopeReadFor(requested: unknown): string {
  const named = (Array.isArray(requested) ? requested.join(" ") : typeof requested === "string" ? requested : "")
    .split(" ")
    .filter((scope) => scope !== "" && scope !== REFRESH_SCOPE);
  const asked = named.length === 0 ? DEFAULT_SCOPES : [...new Set(named)];
  return [...asked.map((scope) => ((SCOPES as readonly string[]).includes(scope) ? scope : `${NOT_OFFERED}${scope}`)), REFRESH_SCOPE].join(" ");
}

/** The scopes a person approves or a client asked for, as Tiehall offers them: without offline_access. */
export function offeredScopesOf(scope: string): string[] {
  return scope.split(" ").filter((each) => each !== "" && each !== REFRESH_SCOPE);
}

/** The token endpoint, under the sign-in service's routes at /api/auth. */
const TOKEN_PATH = "/oauth2/token";

/** The token grants whose requests name the resource of the grant they continue. */
const RESOURCE_GRANTS = new Set(["authorization_code", "refresh_token"]);

/** Whether a request's field names a value. */
function names(value: unknown): boolean {
  return (Array.isArray(value) ? value : [value]).some((each) => typeof each === "string" && each !== "");
}

/** The signing-key options of the install's jwt() plugin, with which an access token is signed again. */
type SigningKeyOptions = Parameters<typeof jwt>[0];

/**
 * The access token the token endpoint issued, with offline_access left out of
 * its scope claim: signed again, with the key that signed it, every other
 * claim and its header's type kept. The sign-in library writes every scope of
 * the grant into the claim, and it issues a refresh token only for a grant
 * that carries offline_access, so the grant keeps the scope and the token
 * loses it here. A token that is no JWT, or whose claim does not hold
 * offline_access, is returned as it is.
 */
async function withOfferedScopeClaim(context: Parameters<typeof signJWT>[0], options: SigningKeyOptions, token: string): Promise<string> {
  let claims: ReturnType<typeof decodeJwt>;
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    claims = decodeJwt(token);
    header = decodeProtectedHeader(token);
  } catch {
    return token;
  }
  const { scope } = claims;
  if (typeof scope !== "string" || !scope.split(" ").includes(REFRESH_SCOPE)) return token;
  return signJWT(context, {
    options,
    header: header.typ === undefined ? {} : { typ: header.typ },
    ...(header.kid === undefined ? {} : { signingKeyId: header.kid }),
    payload: { ...claims, scope: offeredScopesOf(scope).join(" ") },
  });
}

/**
 * Reads every authorization request with the scope scopeReadFor() gives it,
 * and with the install's one resource when it names none; reads the token
 * request of an authorization code or a refresh token that names no resource
 * with that resource too; and answers every token request with the scopes
 * Tiehall offers alone: the offline_access every grant carries for its
 * refresh token is left out of the answer's scope and of its access token's
 * scope claim.
 */
function offeredScopes(resource: string, signingKeyOptions: SigningKeyOptions): BetterAuthPlugin {
  return {
    id: "tiehall-offered-scopes",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (context) => {
            const query = (context.query ?? {}) as Record<string, unknown>;
            return { context: { query: { ...query, scope: scopeReadFor(query["scope"]), ...(names(query["resource"]) ? {} : { resource }) } } };
          }),
        },
        {
          matcher: (context) => context.path === TOKEN_PATH,
          handler: createAuthMiddleware(async (context) => {
            const body = (context.body ?? {}) as Record<string, unknown>;
            if (typeof body["grant_type"] !== "string" || !RESOURCE_GRANTS.has(body["grant_type"]) || names(body["resource"])) return undefined;
            return { context: { body: { ...body, resource } } };
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === TOKEN_PATH,
          handler: createAuthMiddleware(async (context) => {
            const returned = context.context.returned;
            if (typeof returned !== "object" || returned === null || returned instanceof Response || returned instanceof APIError) return;
            const { scope, access_token: accessToken } = returned as { scope?: unknown; access_token?: unknown };
            if (typeof scope !== "string") return;
            return context.json({
              ...(returned as Record<string, unknown>),
              scope: offeredScopesOf(scope).join(" "),
              ...(typeof accessToken === "string" ? { access_token: await withOfferedScopeClaim(context, signingKeyOptions, accessToken) } : {}),
            });
          }),
        },
      ],
    },
  };
}

/** The sign-in library's refusal of a code exchange whose verifier does not match the code's challenge. */
const VERIFICATION_FAILED = "code verification failed";

/**
 * Answers the token endpoint's refusals of a PKCE verifier as OAuth has them.
 * The sign-in library refuses a verifier that does not match the code's
 * challenge with 401 invalid_request, where RFC 7636 (4.6) and OAuth 2.1 call
 * for invalid_grant, and every OAuth error but invalid_client with 400 (RFC
 * 6749, 5.2): such a refusal becomes 400 invalid_grant, and any other 401
 * invalid_request about the verifier 400 invalid_request. The library has
 * used the code up by then, which stays so: the right verifier gets no token
 * with it either.
 */
function pkceRefusals(): BetterAuthPlugin {
  return {
    id: "tiehall-pkce-refusals",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/oauth2/token",
          handler: createAuthMiddleware(async (context) => {
            const refused = context.context.returned;
            if (!(refused instanceof APIError) || refused.statusCode !== 401) return;
            const body = refused.body as { error?: unknown; error_description?: unknown } | undefined;
            if (body?.error !== "invalid_request" || typeof body.error_description !== "string" || !body.error_description.includes("verif")) return;
            const mismatch = body.error_description === VERIFICATION_FAILED;
            // A Response of its own, since the library would answer a refusal the hook throws with the endpoint's status.
            return new Response(
              JSON.stringify({
                error: mismatch ? "invalid_grant" : "invalid_request",
                error_description: mismatch ? "The code verifier does not match the code's challenge." : body.error_description,
              }),
              { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } },
            );
          }),
        },
      ],
    },
  };
}

/** A plugin whose every table has the install's org id as a field, which each row it stores carries. */
function withOrgId<P extends BetterAuthPlugin>(plugin: P, orgId: string): P {
  if (plugin.schema === undefined) return plugin;
  const orgIdField = { type: "string", required: true, input: false, returned: false, defaultValue: () => orgId } as const;
  const schema = Object.fromEntries(
    Object.entries(plugin.schema).map(([model, table]) => [model, { ...table, fields: { ...table.fields, orgId: orgIdField } }]),
  );
  return { ...plugin, schema };
}
