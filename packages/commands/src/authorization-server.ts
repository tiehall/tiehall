import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { SCOPES } from "@tiehall/catalog";
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
//   URL exactly. At most 60 documents a minute are fetched from one host, and
//   an authorization request that cannot be checked because its host's limit
//   is used up gets 429 with Retry-After; no other limit on the fetches
//   applies.
// - Tiehall offers exactly three scopes, requests:read, requests:write and
//   contracts:report, and no admin scope (agent-access: OAuth scopes are
//   coarse): a scope an authorization request asks for that is not one of
//   them is refused with invalid_scope, and a request that asks for none gets
//   requests:read and requests:write. Every grant brings a refresh token,
//   which the authorization server issues only with offline_access: so the
//   request each client sends is completed with it before the server reads
//   it, and a client that asks for offline_access itself is refused like any
//   other scope Tiehall does not offer.
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
} as const;

/** How many Client ID Metadata Documents the install fetches from one host in a minute, at most. */
export const METADATA_FETCHES_PER_HOST_PER_MINUTE = 60;

/** How the authorization server takes agent clients. */
export interface AgentClientOptions {
  /** Whether Client ID Metadata Documents are fetched (TIEHALL_CLIENT_METADATA_FETCH); on unless off. */
  metadataDocuments?: boolean;
  /** The fetcher of metadata documents: the install's outbound fetcher, following no redirect, unless a test gives one. */
  fetchDocument?: OutboundFetcher;
  /** The clock registrations are counted by; the system clock unless a test controls it. */
  now?: () => Date;
}

export interface AuthorizationServerOptions {
  /** The install's URL (TIEHALL_URL), as its origin: the issuer. */
  url: string;
  /** The install's org, whose id every row the plugins store carries. */
  orgId: string;
  clients?: AgentClientOptions;
}

/** The sign-in service's plugins that make it the install's authorization server for agent clients. */
export function authorizationServerPlugins({ url, orgId, clients = {} }: AuthorizationServerOptions): BetterAuthPlugin[] {
  const signingKeys = jwt({
    jwt: { issuer: url },
    disableSettingJwtHeader: true,
    schema: { jwks: { modelName: MODEL_NAMES.jwks } },
  });
  const server = mcp({
    resource: mcpResourceOf(url),
    loginPage: AUTHORIZATION_SIGN_IN_PATH,
    consentPage: CONSENT_PATH,
    scopes: [...SCOPES, REFRESH_SCOPE],
    advertisedMetadata: { scopes_supported: [...SCOPES] },
    clientRegistrationDefaultScopes: [...SCOPES, REFRESH_SCOPE],
    accessTokenExpiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // A used refresh token is refused at once, with no window in which it is taken again.
    refreshTokenReuseInterval: 0,
    // Registrations are limited per client address and hour, as agent-access says (15.8), not by the plugin's
    // five a minute; its limits on the token, authorization and revocation endpoints stay.
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
  // The plugin's endpoint types are stricter than the plugin interface under exactOptionalPropertyTypes; it is one.
  const plugins = [withOrgId(signingKeys, orgId), withOrgId(server as unknown as BetterAuthPlugin, orgId), offeredScopes()];
  if (clients.metadataDocuments !== false) plugins.push(metadataDocuments(clients.fetchDocument ?? createOutboundFetcher({ maxRedirects: 0 })));
  return plugins;
}

/** The plugin that identifies clients by their Client ID Metadata Documents, fetched with this fetcher. */
function metadataDocuments(fetchDocument: OutboundFetcher): BetterAuthPlugin {
  return cimd({
    metadataProfile: "mcp-2026-07-28",
    // The document's own answer, as the outbound fetcher gives it; a refused fetch fails the resolution of the client.
    fetchClientMetadataResource: async (input) => {
      const document = await fetchDocument(input instanceof Request ? input.url : input.toString());
      return new Response(document.body, {
        status: document.status,
        headers: document.contentType === undefined ? {} : { "content-type": document.contentType },
      });
    },
    // The one limit agent-access names: 60 fetches a minute from one host. The plugin's other limits are set out of reach.
    metadataFetchPolicy: {
      maximumFetchesPerOriginPerMinute: METADATA_FETCHES_PER_HOST_PER_MINUTE,
      maximumConcurrentFetchesPerOrigin: METADATA_FETCHES_PER_HOST_PER_MINUTE,
      maximumFetchesPerMinute: 1_000_000,
      maximumConcurrentFetches: 1_000_000,
      minimumFetchInterval: 0,
    },
  }) as unknown as BetterAuthPlugin;
}

/**
 * The scope an authorization request is read with: the scopes it asks for,
 * or requests:read and requests:write when it names none, with a scope that
 * is not one of the three renamed, so the authorization server refuses it
 * with invalid_scope, and offline_access added, so the grant brings a refresh
 * token.
 */
export function scopeReadFor(requested: unknown): string {
  const named = (Array.isArray(requested) ? requested.join(" ") : typeof requested === "string" ? requested : "").split(" ").filter((scope) => scope !== "");
  const asked = named.length === 0 ? DEFAULT_SCOPES : named;
  return [...asked.map((scope) => ((SCOPES as readonly string[]).includes(scope) ? scope : `${NOT_OFFERED}${scope}`)), REFRESH_SCOPE].join(" ");
}

/** The scopes a person approves or a client asked for, as Tiehall offers them: without offline_access. */
export function offeredScopesOf(scope: string): string[] {
  return scope.split(" ").filter((each) => each !== "" && each !== REFRESH_SCOPE);
}

/** Reads every authorization request with the scope scopeReadFor() gives it. */
function offeredScopes(): BetterAuthPlugin {
  return {
    id: "tiehall-offered-scopes",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (context) => ({
            context: { query: { ...(context.query ?? {}), scope: scopeReadFor((context.query as Record<string, unknown> | undefined)?.["scope"]) } },
          })),
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
