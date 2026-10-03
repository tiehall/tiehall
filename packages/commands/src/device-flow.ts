import { isIP } from "node:net";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq, lt } from "drizzle-orm";
import { SCOPES } from "@tiehall/catalog";
import { oauthClientResources, oauthClients, oauthDeviceCodes, type Database } from "@tiehall/db";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The CLI's device flow (agent-access: The CLI signs in through a restricted
// device flow; design.md, Design rules: Agent access; design.md, Technical
// decisions: T7, with the device-flow spike's corrections, all required).
//
// The `tiehall` CLI is a registered public client with a fixed client id,
// `tiehall-cli`, which the install seeds, with its link to the install's MCP
// resource, whenever its authorization server is built: it holds no secret,
// takes the device authorization grant and refresh tokens, and nothing else.
// It signs in with the OAuth device authorization grant (RFC 8628):
// - the device authorization endpoint, /api/auth/device/code, serves the CLI
//   alone. The library's client check (`validateClient`) is not set, since it
//   is consulted only for unregistered client ids and would let any client
//   that registered through DCR or is identified by a metadata document use
//   the grant; instead a guard before the endpoint refuses every client id but
//   the CLI's with unauthorized_client, before anything is stored. It reads
//   the request as the endpoint does, so a client id sent twice is no way
//   round it. It refuses a request that would bind the code to a user in
//   advance, since a code is bound only to the member who approves it, and a
//   scope that is not one of the three Tiehall offers, openid and
//   offline_access included, with invalid_scope;
// - a request that names no resource is for the install's MCP resource, so the
//   CLI's access token always has that resource, TIEHALL_URL/mcp, as its only
//   audience, and never an OpenID Connect one;
// - a device code expires 10 minutes after it is issued. Its record keeps the
//   client address the request came from, as the install sees it after its
//   trusted proxies, and the time of the request, which the device approval
//   page shows; the scopes it grants are the ones it asked for, or
//   requests:read and requests:write when it named none, and the refresh
//   scope, so the CLI gets a refresh token. The person approves the code on
//   the install's own device approval page, /device, which the verification
//   address names; the answer carries no verification_uri_complete, the
//   address with the user code in it, since the page ignores a code in its
//   URL and nothing should invite a person to open one another prefilled;
// - the CLI polls the OAuth token endpoint with the device code grant, which
//   issues an access token and a refresh token like any grant's; the library's
//   own device token endpoint, /api/auth/device/token, which would hand out a
//   web session's token, is not served (sign-in-routes.ts), and neither are
//   its verification, approval and denial routes, which would store a user on
//   a code before the person approved it. No device-flow endpoint returns a
//   web session or a session token.
// An expired code is removed by a job that runs every hour, with the address
// it kept.

/** The CLI's fixed client id. */
export const CLI_CLIENT_ID = "tiehall-cli";

/** The OAuth device authorization grant (RFC 8628). */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** How long a device code lives: 10 minutes. */
export const DEVICE_CODE_LIFETIME_SECONDS = 600;

/** The device approval page, where a signed-in member types the code the CLI printed. */
export const DEVICE_APPROVAL_PATH = "/device";

/** The device authorization endpoint, under the sign-in service's routes at /api/auth. */
export const DEVICE_AUTHORIZATION_PATH = "/device/code";

/** The name the CLI is shown by. */
const CLI_NAME = "The tiehall CLI";

/** The scopes an authorization request that names none is granted, as the authorization server gives them too. */
const DEFAULT_DEVICE_SCOPES: readonly string[] = ["requests:read", "requests:write"];

function oauthError(error: string, description: string): APIError {
  return new APIError("BAD_REQUEST", { error, error_description: description });
}

/** The client address a request came from, as the web role's request guard names it; undefined when it names none. */
function clientAddressOf(headers: Headers | undefined): string | undefined {
  const address = headers?.get("x-forwarded-for")?.trim();
  return address !== undefined && isIP(address) !== 0 ? address : undefined;
}

/**
 * The fields of a device authorization request as the endpoint reads them: a
 * form's own fields, whatever the parsed body says, or a JSON body's.
 */
async function requestFields(request: Request | undefined, body: unknown): Promise<URLSearchParams> {
  const contentType = request?.headers.get("content-type")?.toLowerCase() ?? "";
  if (request !== undefined && contentType.includes("application/x-www-form-urlencoded")) return new URLSearchParams(await request.clone().text());
  const fields = new URLSearchParams();
  for (const [name, value] of Object.entries((body ?? {}) as Record<string, unknown>)) {
    for (const each of Array.isArray(value) ? value : [value]) if (typeof each === "string") fields.append(name, each);
  }
  return fields;
}

/** The values a field holds, empty ones left out, as the endpoint counts them. */
function valuesOf(fields: URLSearchParams, name: string): string[] {
  return fields.getAll(name).filter((value) => value !== "");
}

/** The scopes a device code grants: the ones it asked for, or the default, and the refresh scope. */
export function deviceScopeOf(requested: string | null | undefined, refreshScope: string): string {
  const named = (requested ?? "").split(/\s+/).filter((scope) => scope !== "");
  return [...(named.length === 0 ? DEFAULT_DEVICE_SCOPES : named), refreshScope].join(" ");
}

export interface CliDeviceFlowOptions {
  database: Database;
  /** The install's MCP resource, TIEHALL_URL/mcp, which a request that names no resource is for. */
  resource: string;
  /** The scope the authorization server issues refresh tokens with. */
  refreshScope: string;
}

/** The guard before the device authorization endpoint, and the completion of each device code's record after it. */
export function cliDeviceFlow(options: CliDeviceFlowOptions): BetterAuthPlugin {
  /** The scope each call under way asked for, by its request, which its record then grants. */
  const asked = new WeakMap<object, string | null>();
  return {
    id: "tiehall-cli-device-flow",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === DEVICE_AUTHORIZATION_PATH,
          handler: createAuthMiddleware(async (context) => {
            const fields = await requestFields(context.request, context.body);
            const clientIds = valuesOf(fields, "client_id");
            if (clientIds.length !== 1 || clientIds[0] !== CLI_CLIENT_ID) {
              throw oauthError("unauthorized_client", "Only the tiehall CLI signs in through the device flow.");
            }
            if (valuesOf(fields, "user_id").length > 0) {
              throw oauthError("invalid_request", "A device code is bound to the member who approves it, never in advance.");
            }
            const scopes = valuesOf(fields, "scope");
            if (scopes.length > 1) throw oauthError("invalid_request", "scope must not be repeated");
            const named = (scopes[0] ?? "").split(/\s+/).filter((scope) => scope !== "");
            const notOffered = named.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
            if (notOffered.length > 0) {
              throw oauthError("invalid_scope", `Tiehall offers the scopes ${SCOPES.join(", ")}, and not ${notOffered.join(", ")}.`);
            }
            if (context.request !== undefined) asked.set(context.request, scopes[0] ?? null);
            // A request that names no resource is for the install's MCP resource, the CLI token's only audience.
            if (valuesOf(fields, "resource").length === 0) {
              return { context: { body: { ...((context.body ?? {}) as Record<string, unknown>), resource: options.resource } } };
            }
            return undefined;
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === DEVICE_AUTHORIZATION_PATH,
          handler: createAuthMiddleware(async (context) => {
            const returned = context.context.returned as { device_code?: unknown; verification_uri_complete?: unknown } | undefined;
            const deviceCode = returned?.device_code;
            if (typeof deviceCode !== "string") return;
            const requested = context.request === undefined ? undefined : asked.get(context.request);
            if (context.request !== undefined) asked.delete(context.request);
            const address = clientAddressOf(context.request?.headers ?? context.headers);
            await withOrg(options.database, ({ tx, orgId }) =>
              tx
                .update(oauthDeviceCodes)
                .set({ scope: deviceScopeOf(requested, options.refreshScope), requestedFrom: address ?? null })
                .where(and(eq(oauthDeviceCodes.orgId, orgId), eq(oauthDeviceCodes.deviceCode, deviceCode))),
            );
            // The answer names the approval page alone, never a link with the user code in it: the page ignores a code
            // in its URL, so nothing invites a person to open one that another prefilled.
            const { verification_uri_complete: _prefilled, ...answer } = returned as Record<string, unknown>;
            return context.json(answer);
          }),
        },
      ],
    },
  };
}

/**
 * Seeds the CLI as a registered public client with its fixed id, and links it
 * to the install's MCP resource, whose record the authorization server has
 * made by then; a client row that exists is brought back to what the CLI is.
 */
export async function seedCliClient(database: Database, orgId: string, input: { resource: string; scopes: readonly string[] }): Promise<void> {
  const now = new Date();
  const cli = {
    clientSecret: null,
    name: CLI_NAME,
    redirectUris: [] as string[],
    tokenEndpointAuthMethod: "none",
    grantTypes: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
    responseTypes: [] as string[],
    scopes: [...input.scopes],
    applicationType: "native",
    disabled: false,
    skipConsent: false,
    requirePKCE: false,
    updatedAt: now,
  };
  await database.transaction(async (tx) => {
    await tx
      .insert(oauthClients)
      .values({ orgId, clientId: CLI_CLIENT_ID, createdAt: now, ...cli })
      .onConflictDoUpdate({ target: [oauthClients.orgId, oauthClients.clientId], set: cli });
    await tx.insert(oauthClientResources).values({ orgId, clientId: CLI_CLIENT_ID, resourceId: input.resource, createdAt: now }).onConflictDoNothing();
  });
}

/** Removes, every hour, each device code that expired, with the address it kept. */
export const removeExpiredDeviceCodes: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("agent_clients.remove_expired_device_codes", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "41 * * * *",
  async handle(_job, { database, now }) {
    try {
      await withOrg(database, ({ tx, orgId }) => tx.delete(oauthDeviceCodes).where(and(eq(oauthDeviceCodes.orgId, orgId), lt(oauthDeviceCodes.expiresAt, now()))));
    } catch (error) {
      // Before setup no code exists.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
