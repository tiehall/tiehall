import { mcp } from "@better-auth/mcp";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";
import { SCOPES } from "@tiehall/catalog";

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

/** The page the authorization server sends a person to sign in on, before it asks them to approve a client. */
export const AUTHORIZATION_SIGN_IN_PATH = "/sign-in";
/** The consent screen, where a signed-in member approves an agent client. */
export const CONSENT_PATH = "/consent";

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

export interface AuthorizationServerOptions {
  /** The install's URL (TIEHALL_URL), as its origin: the issuer. */
  url: string;
  /** The install's org, whose id every row the plugins store carries. */
  orgId: string;
}

/** The sign-in service's plugins that make it the install's authorization server for agent clients. */
export function authorizationServerPlugins({ url, orgId }: AuthorizationServerOptions): BetterAuthPlugin[] {
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
  return [withOrgId(signingKeys, orgId), withOrgId(server as unknown as BetterAuthPlugin, orgId)];
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
