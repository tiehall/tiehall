import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { oauthClientRegistrations, oauthClients, type Database } from "@tiehall/db";
import { CLI_CLIENT_ID } from "./device-flow.ts";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The agent clients of the install's authorization server (agent-access:
// Dynamic Client Registration stays on, limited and unverified; agent-access:
// Clients identified by a Client ID Metadata Document are preferred;
// design.md, Decisions this change rests on: D28 #43; design.md, Design rules:
// Agent access; design.md, Technical decisions: T6 and T7).
//
// Dynamic Client Registration stays on, for any agent client, but one client
// address, as the install sees it after its trusted proxies (the web role's
// request guard puts it, alone, in X-Forwarded-For), registers at most 10
// clients in an hour. Each registration request the authorization server takes
// up is recorded with its address and time, in a transaction that holds a lock
// for that address, so two requests at once cannot both be the tenth; the
// eleventh within the hour is refused with 429 and a Retry-After that says
// when the oldest of the ten leaves the hour, and gets no client id. A request
// the authorization server then refuses, such as one with a redirect URI it
// does not take, still counts. A native client, whose every redirect URI is on
// its own computer or has its app's own scheme, often does not say it is one;
// the registration is taken as a native client's then, as its redirect URIs
// show it is.
//
// A native app's own scheme needs no dot (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (15), as the maintainer
// answered on 2026-10-15, after Cursor's registration of
// cursor://anysphere.cursor-mcp/oauth/callback was refused; Technical
// decisions: T4): cursor: and vscode: count, as reverse-domain schemes such as
// com.example.app: do. A redirect URI has an app's own scheme only when it is
// written in printable ASCII with no space, holds no fragment and no user
// information, has a scheme that is none of EXCLUDED_SCHEMES, the web's, those
// whose addresses a browser shows or runs itself and those that reach a
// program by an address, and has after its scheme's colon a path, as
// com.example.app:/callback has, or // with a host and a path, as Cursor's has.
// Each redirect URI of a native registration that is neither http nor https
// must have an app's own scheme, or the registration is refused with 400
// invalid_redirect_uri in Tiehall's words. The sign-in library takes only a
// scheme that holds a dot, written with no host, and judges the registration
// it is handed: so it is handed, for each app's scheme, a stand-in of that
// form that no app opens, and once it has stored the client, the URIs the
// client sent are written over the stand-ins in the client's row and in the
// answer, in the transaction that records the registration's client id. A
// client whose row kept its stand-ins, because the process stopped or that
// transaction failed in between, can send a browser nowhere, and no record of
// a registration names it; it is removed 7 days after the sign-in library
// stored it, as a client never used is.
//
// An IPv6 client is counted by its /64, since one host commonly holds a
// whole /64: every address in one /64 shares the 10 registrations an hour
// (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (24); Technical decisions: T4). An IPv4 address, written as one or as
// an IPv4-mapped IPv6 address, is counted by itself.
//
// A registration whose metadata holds a NUL character in any text, which no
// text Tiehall stores may hold, or breaks the bounds of a client's metadata,
// a name of 1 to 100 characters and at most 10 redirect URIs of at most 2,048
// characters each (D55 (25)), is refused with 400 invalid_client_metadata,
// never a 500, and still counts. A metadata document is held to the same
// bounds, and its URL to 1,024 characters of printable ASCII, as RFC 3986
// writes a URL (authorization-server.ts).
//
// A registered client that has never completed an authorization, so that no
// grant and no token of it exists, is removed 7 days after it registered, by a
// job that runs every hour; a later authorization request with its id is
// refused as an unknown client's. The job finds a registered client by its own
// row, so a client that no record of a registration names, because the
// registration's last step failed, is removed too, 7 days after the sign-in
// library stored it. A client identified by its metadata document is not a
// registered one, nor is the CLI's, seeded with its fixed id, and neither is
// ever removed this way.
//
// A registered client's name is its own claim, and every installation of a
// client registers a new id, so every registered client is unverified; a
// client identified by its metadata document has the verified host of its
// document's URL.

/** How many clients one address registers in an hour, at most. */
export const REGISTRATIONS_PER_ADDRESS_PER_HOUR = 10;
/** How many days after it registered a client that was never used is removed. */
export const UNUSED_CLIENT_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long a client's name is, at most, in characters. */
export const CLIENT_NAME_MAX_LENGTH = 100;
/** How many redirect URIs a client has, at most. */
export const CLIENT_REDIRECT_URIS_MAX = 10;
/** How long a client's redirect URI is, at most, in characters. */
export const CLIENT_REDIRECT_URI_MAX_LENGTH = 2048;
/** How long a client id that is a metadata document's URL is, at most, in characters. */
export const CLIENT_ID_URL_MAX_LENGTH = 1024;

/** The characters a URL is written with (RFC 3986): printable ASCII, with no space, every other character percent-encoded. */
const URL_CHARACTERS = /^[\x21-\x7e]*$/;

/**
 * Whether a client id that is a metadata document's URL is within its bounds:
 * written as RFC 3986 writes a URL, in printable ASCII with no space, and of
 * at most 1,024 characters, which are then 1,024 bytes. A client id written
 * with other characters could take up to four times as many bytes of the
 * database's own bounds on what a client's id is written into, however few
 * its characters (D55 (25)).
 */
export function clientIdUrlWithinBounds(url: string): boolean {
  return url.length <= CLIENT_ID_URL_MAX_LENGTH && URL_CHARACTERS.test(url);
}

/** The prefix an IPv6 client is counted by. */
const IPV6_PREFIX_LENGTH = 64;

/** The code the registration limit refuses with, which the sign-in service turns into the error model's 429. */
export const REGISTRATION_LIMIT_CODE = "registration_limit";

export interface ClientRegistrationOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The clock registrations are counted by; the system clock unless a test controls it. */
  now?: () => Date;
}

/** The client address a request came from, as the web role's request guard names it; undefined when it names none. */
function clientAddressOf(headers: Headers): string | undefined {
  const address = headers.get("x-forwarded-for")?.trim();
  return address !== undefined && isIP(address) !== 0 ? address : undefined;
}

/**
 * The schemes that are never a native app's own: the web's, those whose
 * addresses a browser shows or runs itself, and those that reach a program by
 * an address. An http URI on the client's own computer is a native client's
 * by the loopback rule, not as an app's scheme.
 */
export const EXCLUDED_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
  "javascript",
  "vbscript",
  "data",
  "blob",
  "about",
  "filesystem",
  "view-source",
  "mailto",
  "tel",
  "sms",
]);

/**
 * Whether a redirect URI has a native app's own scheme: written in printable
 * ASCII with no space, as a URL is written, with no fragment and no user
 * information, a scheme none of EXCLUDED_SCHEMES, and, after the scheme's
 * colon, a path (com.example.app:/callback) or // with a host and a path
 * (cursor://anysphere.cursor-mcp/oauth/callback).
 */
export function isAppSchemeRedirect(uri: unknown): boolean {
  if (typeof uri !== "string" || !URL_CHARACTERS.test(uri) || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (EXCLUDED_SCHEMES.has(url.protocol.slice(0, -1)) || url.username !== "" || url.password !== "") return false;
  const afterScheme = url.href.slice(url.protocol.length);
  return url.host === "" ? afterScheme.startsWith("/") && !afterScheme.startsWith("//") : url.pathname.startsWith("/");
}

/** Whether a redirect URI is an http URI on the client's own computer: localhost, 127.0.0.1 or [::1]. */
function isLoopbackRedirect(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Whether a redirect URI is a native client's: on the client's own computer (a loopback address over http) or with a native app's own scheme. */
function isNativeRedirect(uri: unknown): boolean {
  return isLoopbackRedirect(uri) || isAppSchemeRedirect(uri);
}

/** Whether a redirect URI is an http or an https URI, which the sign-in library judges itself, for a native client as for a web one. */
function isWebRedirect(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const { protocol } = new URL(uri);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The scheme of the stand-ins the sign-in library is handed for a native
 * registration's app's schemes: one it takes, a reverse-domain scheme written
 * with no host, which no app opens.
 */
const STAND_IN_SCHEME = "invalid.tiehall.redirect";

/**
 * What breaks the bounds of a client's metadata, registered or in its
 * document, in Tiehall's words, or undefined when nothing does: a name of 1
 * to 100 characters, when it gives one, and at most 10 redirect URIs of at
 * most 2,048 characters each.
 */
export function clientMetadataBoundsProblem(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const { client_name: name, redirect_uris: redirects } = metadata as Record<string, unknown>;
  if (typeof name === "string" && (name.trim() === "" || [...name].length > CLIENT_NAME_MAX_LENGTH)) {
    return `A client's name has 1 to ${CLIENT_NAME_MAX_LENGTH} characters.`;
  }
  if (Array.isArray(redirects)) {
    if (redirects.length > CLIENT_REDIRECT_URIS_MAX) return `A client has at most ${CLIENT_REDIRECT_URIS_MAX} redirect URIs.`;
    if (redirects.some((uri) => typeof uri === "string" && [...uri].length > CLIENT_REDIRECT_URI_MAX_LENGTH)) {
      return `A client's redirect URI has at most ${CLIENT_REDIRECT_URI_MAX_LENGTH} characters.`;
    }
  }
  return undefined;
}

/** Whether a client address is counted by its IPv6 /64, rather than by itself: an IPv6 address that is no IPv4-mapped one. */
function countedBySubnet(address: string): boolean {
  return isIP(address) === 6 && !/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address);
}

/** Whether a client's metadata, registered or in its document, holds a NUL character in any text, however deep. */
export function holdsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(holdsNul);
  if (typeof value === "object" && value !== null) return Object.entries(value).some(([key, each]) => key.includes("\u0000") || holdsNul(each));
  return false;
}

/**
 * The plugin that limits registrations per client address and hour, takes a
 * registration whose every redirect URI is native as a native client's, and
 * holds a native registration's app's schemes to Tiehall's rule.
 */
export function clientRegistrations(options: ClientRegistrationOptions): BetterAuthPlugin {
  const now = options.now ?? (() => new Date());
  /** The registration request each call under way was recorded as. */
  const recorded = new WeakMap<object, string>();
  /** For each call under way whose app's schemes the sign-in library was handed stand-ins for, the redirect URIs the client sent. */
  const sentRedirects = new WeakMap<object, string[]>();
  return {
    id: "tiehall-client-registrations",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/oauth2/register" && context.request !== undefined,
          handler: createAuthMiddleware(async (context) => {
            const request = context.request;
            if (request === undefined) return;
            const address = clientAddressOf(request.headers);
            const at = now();
            // An IPv6 client is counted, and locked, by its /64, which the database works out from its address.
            const subnet = address !== undefined && countedBySubnet(address);
            const lockKey = subnet
              ? sql`'tiehall.client_registrations:' || network(set_masklen(${address}::inet, ${IPV6_PREFIX_LENGTH}))::text`
              : sql`${`tiehall.client_registrations:${address ?? ""}`}`;
            const decided = await withOrg(options.database, async ({ tx, orgId }) => {
              await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
              const recent = await tx
                .select({ registeredAt: oauthClientRegistrations.registeredAt })
                .from(oauthClientRegistrations)
                .where(
                  and(
                    eq(oauthClientRegistrations.orgId, orgId),
                    address === undefined
                      ? isNull(oauthClientRegistrations.ipAddress)
                      : subnet
                        ? sql`${oauthClientRegistrations.ipAddress} <<= set_masklen(${address}::inet, ${IPV6_PREFIX_LENGTH})`
                        : eq(oauthClientRegistrations.ipAddress, address),
                    gt(oauthClientRegistrations.registeredAt, new Date(at.getTime() - HOUR_MS)),
                  ),
                )
                .orderBy(asc(oauthClientRegistrations.registeredAt));
              if (recent.length >= REGISTRATIONS_PER_ADDRESS_PER_HOUR) {
                const leaving = recent[recent.length - REGISTRATIONS_PER_ADDRESS_PER_HOUR]?.registeredAt ?? at;
                return { retryAfterSeconds: Math.max(1, Math.ceil((leaving.getTime() + HOUR_MS - at.getTime()) / 1000)) };
              }
              const [row] = await tx
                .insert(oauthClientRegistrations)
                .values({ orgId, ipAddress: address ?? null, registeredAt: at })
                .returning({ id: oauthClientRegistrations.id });
              return { id: row?.id ?? "" };
            });
            if ("retryAfterSeconds" in decided) {
              throw new APIError(
                "TOO_MANY_REQUESTS",
                {
                  code: REGISTRATION_LIMIT_CODE,
                  message: `This address registered ${REGISTRATIONS_PER_ADDRESS_PER_HOUR} agent clients in the past hour, as many as an address may.`,
                },
                { "x-retry-after": String(decided.retryAfterSeconds) },
              );
            }
            recorded.set(request, decided.id);
            const body = (context.body ?? {}) as Record<string, unknown>;
            // No text Tiehall stores may hold a NUL character: a registration with one is refused as metadata it cannot take.
            if (holdsNul(body)) {
              throw new APIError("BAD_REQUEST", { error: "invalid_client_metadata", error_description: "A registration's texts hold no NUL character." });
            }
            // A client's metadata is bounded, so no text breaks the database's own bounds later.
            const outOfBounds = clientMetadataBoundsProblem(body);
            if (outOfBounds !== undefined) throw new APIError("BAD_REQUEST", { error: "invalid_client_metadata", error_description: outOfBounds });
            // A registration whose every redirect URI is native is a native client's, whether or not it says so.
            const redirects = body["redirect_uris"];
            const named = body["application_type"];
            const taken = named === undefined && Array.isArray(redirects) && redirects.length > 0 && redirects.every(isNativeRedirect);
            if (!(taken || named === "native") || !Array.isArray(redirects)) return undefined;
            // Each redirect URI of a native client that is neither http nor https has its app's own scheme.
            const neither = redirects.find((uri) => !isWebRedirect(uri) && !isAppSchemeRedirect(uri));
            if (neither !== undefined) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_redirect_uri",
                error_description: `A native client's redirect URI is an http URI on localhost, 127.0.0.1 or [::1], an https URI, or a URI with the app's own scheme: written in printable ASCII with no space, with no fragment and no user information, with a scheme that is none of ${[...EXCLUDED_SCHEMES].join(", ")}, and with a path, or // with a host and a path, after its scheme; ${typeof neither === "string" ? neither : "one of its redirect URIs"} is none of these.`,
              });
            }
            // The sign-in library is handed a stand-in it takes for each app's scheme; the client's own URIs replace them once it is stored.
            const handed = redirects.map((uri) => (isAppSchemeRedirect(uri) ? `${STAND_IN_SCHEME}:/${randomUUID()}` : uri));
            const swapped = handed.some((uri, index) => uri !== redirects[index]);
            if (swapped) sentRedirects.set(request, redirects as string[]);
            if (!swapped && !taken) return undefined;
            return { context: { body: { ...body, application_type: "native", redirect_uris: handed } } };
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === "/oauth2/register" && context.request !== undefined,
          handler: createAuthMiddleware(async (context) => {
            const request = context.request;
            const id = request === undefined ? undefined : recorded.get(request);
            if (request === undefined || id === undefined) return;
            recorded.delete(request);
            const sent = sentRedirects.get(request);
            sentRedirects.delete(request);
            const returned = context.context.returned;
            const clientId = (returned as { client_id?: unknown } | undefined)?.client_id;
            if (typeof clientId !== "string") return;
            await withOrg(options.database, async ({ tx, orgId }) => {
              await tx
                .update(oauthClientRegistrations)
                .set({ clientId })
                .where(and(eq(oauthClientRegistrations.orgId, orgId), eq(oauthClientRegistrations.id, id)));
              // The redirect URIs the client sent, over the stand-ins the sign-in library stored.
              if (sent !== undefined) {
                await tx
                  .update(oauthClients)
                  .set({ redirectUris: sent })
                  .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.clientId, clientId)));
              }
            });
            if (sent === undefined) return;
            return context.json({ ...(returned as Record<string, unknown>), redirect_uris: sent });
          }),
        },
      ],
    },
  };
}

/** An agent client as the install knows it: its ids, its name, and whether its identity is verified. */
export interface AgentClient {
  /** Tiehall's own id of the client. */
  id: string;
  /** The id the client sends: its metadata document's URL, or the id its registration was given. */
  clientId: string;
  /** The name the client gives itself, which is its own claim; none when it gave none. */
  name: string | undefined;
  redirectUris: readonly string[];
  disabled: boolean;
  /** For a client identified by its metadata document, the host of the document's URL; none for a registered client. */
  verifiedHost: string | undefined;
  /** Whether the client registered itself, so nothing verifies who it is. */
  unverified: boolean;
}

/** The agent client with this client id, read in the caller's transaction; undefined when the install knows none. */
export async function readAgentClient({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, clientId: string): Promise<AgentClient | undefined> {
  const [row] = await tx
    .select({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      redirectUris: oauthClients.redirectUris,
      disabled: oauthClients.disabled,
      discovery: oauthClients.clientDiscoveryId,
    })
    .from(oauthClients)
    .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.clientId, clientId)));
  if (row === undefined) return undefined;
  const verifiedHost = row.discovery === "cimd" ? hostOf(row.clientId) : undefined;
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name ?? undefined,
    redirectUris: row.redirectUris,
    disabled: row.disabled === true,
    verifiedHost,
    unverified: verifiedHost === undefined,
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Removes, every hour, each registered client that registered 7 days ago or
 * earlier by the worker's clock and has never completed an authorization: no
 * grant, refresh token or access token of it exists. A registered client is
 * any but a metadata-document client and the CLI's; it registered when the
 * record of its registration says, or, when none names it, when the sign-in
 * library stored it. The records of
 * registration requests that were refused go too once they are an hour old,
 * since they no longer count.
 */
export const removeUnusedAgentClients: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("agent_clients.remove_unused", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "23 * * * *",
  async handle(_job, { database, now }) {
    const cutoff = new Date(now().getTime() - UNUSED_CLIENT_DAYS * DAY_MS);
    try {
      await withOrg(database, async ({ tx, orgId }) => {
        // A registered client is found by its own row: neither a metadata-document client nor the CLI's. It registered
        // when the record of its registration says, or, when no record names it, when the sign-in library stored it.
        await tx.execute(sql`
          DELETE FROM oauth_clients c
           WHERE c.org_id = ${orgId} AND c.client_discovery_id IS NULL AND c.client_id <> ${CLI_CLIENT_ID}
             AND coalesce(
                   (SELECT min(r.registered_at) FROM oauth_client_registrations r WHERE r.org_id = c.org_id AND r.client_id = c.client_id),
                   c.created_at
                 ) <= ${cutoff}
             AND NOT EXISTS (SELECT 1 FROM oauth_consents g WHERE g.org_id = c.org_id AND g.client_id = c.client_id)
             AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens t WHERE t.org_id = c.org_id AND t.client_id = c.client_id)
             AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.org_id = c.org_id AND a.client_id = c.client_id)`);
        await tx
          .delete(oauthClientRegistrations)
          .where(
            and(
              eq(oauthClientRegistrations.orgId, orgId),
              isNull(oauthClientRegistrations.clientId),
              lt(oauthClientRegistrations.registeredAt, new Date(now().getTime() - HOUR_MS)),
            ),
          );
      });
    } catch (error) {
      // Before setup no client can register.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
