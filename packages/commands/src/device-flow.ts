import { isIP } from "node:net";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq, lt } from "drizzle-orm";
import { SCOPES } from "@tiehall/catalog";
import { oauthClientResources, oauthClients, oauthDeviceCodes, type Database } from "@tiehall/db";
import { storedDeviceCode } from "./device-code-storage.ts";
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
//   round it: a body is a form only when its media type is a form's exactly,
//   since the endpoint reads one that names JSON first, or ends in +json, as
//   JSON, whatever form its text holds. It refuses a request that would bind
//   the code to a user in advance, since a code is bound only to the member
//   who approves it, and a scope that is not one of the three Tiehall
//   offers, openid and offline_access included, with invalid_scope;
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
//   web session or a session token;
// - the token endpoint's limit on the calls from one client address does not
//   count the CLI's polls, which have a limit of their own. The library lets
//   20 calls in a row from one address through, and the run ends only once a
//   minute passes without one, while the CLI polls every 5 seconds for as
//   long as its code waits, up to its 10 minutes: its 21st poll, about 100
//   seconds in, would be refused with 429, and so would every token call from
//   that address until a minute passed without one, the next `tiehall
//   login`'s first poll included. On an install on one machine, as a trial
//   URL's is, every client there reaches it from one address. A call is the
//   CLI's poll when its body is a form, by a media type that is a form's
//   exactly, that names the device code grant and the CLI's client id, each
//   once; the endpoint reads a body whose media type names JSON first, or
//   ends in +json, as JSON, whatever form its text holds, so such a body is
//   never a poll. Every other token call keeps the token endpoint's limit.
//   The CLI's polls from one address are counted over the past minute
//   instead, whatever codes they carry, and the 61st within a minute is
//   refused with 429 and changes nothing: a poll every 5 seconds makes 12 a
//   minute, so five sign-ins at once from one address fit, and codes no one
//   was issued cannot be tried without a limit. The device flow holds each
//   code it issued to the interval itself, answering a poll that comes
//   sooner with slow_down.
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

/** The OAuth token endpoint, under the sign-in service's routes at /api/auth, which the CLI polls with its device code. */
export const TOKEN_ENDPOINT_PATH = "/oauth2/token";

/** A rule of the sign-in service's rate limit: at most `max` calls in a row from one client address, in a run that ends once `window` seconds pass without one. */
export interface RateLimitRule {
  window: number;
  max: number;
}

/** How many of the CLI's polls the token endpoint takes from one client address in a minute, at most. */
export const CLI_POLLS_PER_ADDRESS_PER_MINUTE = 60;

/** How long the CLI's polls from an address are counted for: a minute. */
const POLL_WINDOW_MS = 60_000;

/** A form's media type. */
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/**
 * Whether a request's body is a form as the sign-in service reads it: its
 * media type, parameters aside, is a form's exactly. The service takes a
 * media type that merely contains a form's, and reads one that names JSON
 * first, or ends in +json, as JSON, whatever form its text holds.
 */
function isForm(request: Request): boolean {
  return (request.headers.get("content-type")?.split(";")[0] ?? "").trim().toLowerCase() === FORM_MEDIA_TYPE;
}

/** The value a form's field holds, when it holds exactly one. */
function onlyValueOf(fields: URLSearchParams, name: string): string | undefined {
  const values = fields.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

/** Whether a token call is the CLI's poll with its device code: a form that names the device code grant and the CLI's client id, each once. */
async function isCliPoll(request: Request): Promise<boolean> {
  if (!isForm(request)) return false;
  try {
    const fields = new URLSearchParams(await request.clone().text());
    return onlyValueOf(fields, "grant_type") === DEVICE_CODE_GRANT_TYPE && onlyValueOf(fields, "client_id") === CLI_CLIENT_ID;
  } catch {
    // A body that cannot be read is no poll, and the endpoint refuses it.
    return false;
  }
}

/**
 * The rate limit of a call to the token endpoint: none of the library's for
 * the CLI's poll with its device code, which the device flow counts itself,
 * and the rule it has otherwise for every other call.
 */
export async function tokenEndpointRateLimit(request: Request, rule: RateLimitRule): Promise<RateLimitRule | false> {
  return (await isCliPoll(request)) ? false : rule;
}

/**
 * Counts the CLI's polls from each client address over the past minute, in
 * this process's memory (one web process per install); refuses a poll beyond
 * the address's 60 with the answer the sign-in service turns into the error
 * model's 429, whose Retry-After says when the earliest of them leaves the
 * minute.
 */
function pollsPerAddress(now: () => Date): (address: string | undefined) => void {
  const byAddress = new Map<string, number[]>();
  return (address) => {
    const at = now().getTime();
    // Addresses with no poll in the past minute are forgotten, so the count keeps no more than a minute's addresses.
    if (byAddress.size > 10_000) for (const [each, times] of byAddress) if (times.every((time) => at - time >= POLL_WINDOW_MS)) byAddress.delete(each);
    const key = address ?? "";
    const recent = (byAddress.get(key) ?? []).filter((time) => at - time < POLL_WINDOW_MS);
    if (recent.length >= CLI_POLLS_PER_ADDRESS_PER_MINUTE) {
      byAddress.set(key, recent);
      const retryAfterSeconds = Math.max(1, Math.ceil(((recent[0] ?? at) + POLL_WINDOW_MS - at) / 1000));
      throw new APIError(
        "TOO_MANY_REQUESTS",
        { message: `This address polled for device codes ${CLI_POLLS_PER_ADDRESS_PER_MINUTE} times in the past minute, as many as an address may.` },
        { "x-retry-after": String(retryAfterSeconds) },
      );
    }
    recent.push(at);
    byAddress.set(key, recent);
  };
}

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
  if (request !== undefined && isForm(request)) return new URLSearchParams(await request.clone().text());
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
  /** The clock the CLI's polls are counted by; the system clock unless a test controls it. */
  now?: () => Date;
}

/**
 * The guard before the device authorization endpoint, the completion of each
 * device code's record after it, and the limit on the CLI's polls of the
 * token endpoint.
 */
export function cliDeviceFlow(options: CliDeviceFlowOptions): BetterAuthPlugin {
  /** The scope each call under way asked for, by its request, which its record then grants. */
  const asked = new WeakMap<object, string | null>();
  const countPoll = pollsPerAddress(options.now ?? (() => new Date()));
  return {
    id: "tiehall-cli-device-flow",
    hooks: {
      before: [
        {
          // The CLI's polls, which the token endpoint's limit does not count, are counted here, before the endpoint
          // reads the code, so a refused poll changes nothing.
          matcher: (context) => context.path === TOKEN_ENDPOINT_PATH,
          handler: createAuthMiddleware(async (context) => {
            if (context.request !== undefined && (await isCliPoll(context.request))) countPoll(clientAddressOf(context.request.headers));
          }),
        },
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
                .where(and(eq(oauthDeviceCodes.orgId, orgId), eq(oauthDeviceCodes.deviceCode, storedDeviceCode(deviceCode)))),
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
