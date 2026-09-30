import { createHash, randomBytes } from "node:crypto";
import {
  createPersonalAccessToken,
  getPersonalAccessTokenAdminSettings,
  getPersonalAccessTokenSettings,
  listAgentGrants,
  listPersonalAccessTokens,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  revokeAgentGrant,
  revokePersonalAccessToken,
  SCOPES,
  setPersonalAccessTokenMaxLifetime,
  setPersonalAccessTokens,
  type Scope,
} from "@tiehall/catalog";
import {
  personalAccessTokenCreated,
  personalAccessTokenMaxLifetimeChanged,
  personalAccessTokenRevoked,
  personalAccessTokensSwitched,
  quotePreamble,
  Refusal,
  type Review,
} from "@tiehall/core";
import { installSettings, members, personalAccessTokens, type Database } from "@tiehall/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Caller, PersonalAccessTokenCaller } from "./caller.ts";
import { CONFIRM_PATH, type ConfirmMessages } from "./confirm-route.ts";
import type { Reviews } from "./confirmation-step.ts";
import { SCOPE_TEXTS } from "./consent.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { createPageRoute, htmlAnswer, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";
import { lockMembership, withOrg, type OrgContext } from "./with-org.ts";
import type { Writer } from "./write.ts";

// Personal access tokens (agent-access: Personal access tokens are scoped,
// expiring and created in the web UI; agent-access: Every token call is
// checked against the install's current state; activity-log: Which actions
// are security events; design.md, Design rules: Agent access; design.md,
// Self-hosting decisions: S7 and S14).
//
// A user creates a PAT in the web UI only, on the "Connected agents and
// tokens" page, /tokens: its form names a label, the scopes and how many days
// the token lives, and leads to the review page of personal_access_tokens.create,
// where the user confirms it with the confirmation step. No agent surface
// offers the command, so a token's call to its path gets 404, and one without a
// valid confirmation gets 403. The token:
// - carries one or more of the three scopes;
// - expires no later than the install's longest lifetime after it is created:
//   90 days, or the shorter maximum an admin has set; a longer one is refused
//   with 400 outside-settings, on the review page and again when it is
//   confirmed, since the maximum may change in between;
// - has a value that starts with th_pat_ and 32 random bytes, base64url, of
//   which Tiehall keeps only the SHA-256 digest: the confirmation's page shows
//   the value once, and no later page, answer or event holds it;
// - is recorded with a security event that names its user and the token.
//
// The PAT switch and the longest lifetime (agent-access: An admin sets the PAT
// switch and the maximum lifetime): a new install has the switch on and a
// longest lifetime of 90 days. Only an admin changes either, in the web UI,
// with the confirmation step, so a member gets 403 and no agent surface offers
// the change; a longest lifetime above 90 days fails the command's schema with
// 400. Each change is a security event that names the value before and after;
// setting a value it already has changes nothing and records nothing. The
// switch revokes nothing: it is read at every call (with-org.ts), so switching
// it on again lets unexpired tokens work again. A new longest lifetime applies
// to tokens created after it; the ones that exist keep their expiry.
//
// A call to /api/v1 names a PAT in its Authorization header, as a bearer
// token (agent-tokens.ts). The check looks the token up by its digest: one
// that is unknown, expired or revoked is refused with 401 invalid_token, and
// any other acts for the user who created it, within its scopes. Whether that
// user is still a member, and whether the PAT switch is on, is checked in the
// call's own transaction (with-org.ts), at every call.

/** How many days a personal access token lives at most, whatever an admin sets. */
export const PERSONAL_ACCESS_TOKEN_MAX_DAYS = 90;

/** Where a user creates their personal access tokens: their "Connected agents and tokens" page. */
export const TOKENS_PATH = "/tokens";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A new token's value: th_pat_ and 32 random bytes, base64url. */
export function newPersonalAccessToken(): string {
  return `${PERSONAL_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The digest Tiehall keeps of a token's value, and looks a call's token up by: SHA-256, in hex. */
export function personalAccessTokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Whether a bearer token has the form of a personal access token. */
export function isPersonalAccessToken(value: string): boolean {
  return value.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX);
}

/**
 * The install's PAT settings: the switch and the longest lifetime, read in the
 * caller's transaction; their defaults until an admin changed them. Locked, an
 * admin's change reads them after any change under way has committed.
 */
export async function personalAccessTokenSettingsIn(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  lock = false,
): Promise<{ on: boolean; maxLifetimeDays: number }> {
  if (lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tiehall.install_settings.personal_access_tokens:${orgId}`}, 0))`);
  const [row] = await tx
    .select({ on: installSettings.personalAccessTokensOn, maxLifetimeDays: installSettings.personalAccessTokenMaxDays })
    .from(installSettings)
    .where(eq(installSettings.orgId, orgId));
  return { on: row?.on ?? true, maxLifetimeDays: Math.min(row?.maxLifetimeDays ?? PERSONAL_ACCESS_TOKEN_MAX_DAYS, PERSONAL_ACCESS_TOKEN_MAX_DAYS) };
}

/** Refuses a lifetime longer than the install's longest with 400 outside-settings. */
function assertLifetime(expiresInDays: number, maxLifetimeDays: number): void {
  if (expiresInDays > maxLifetimeDays) {
    throw new Refusal(
      "outside-settings",
      `A personal access token lives at most ${maxLifetimeDays} days in this install, and this one would live ${expiresInDays}.`,
    );
  }
}

/** A date as the pages show it: the day, in UTC. */
function day(at: Date): string {
  return `${at.toISOString().slice(0, 10)} (UTC)`;
}

type CreateInput = { name: string; scopes: Scope[]; expiresInDays: number };

/** The signed-in member whose own tokens a web UI call creates, lists or revokes; the web UI runs these only for one. */
function ownerOf(caller: Caller): string {
  if (caller.kind !== "web_session") throw new Refusal("forbidden", "Only a signed-in member creates, lists or revokes their personal access tokens, in the web UI.");
  return caller.userId;
}

export const PERSONAL_ACCESS_TOKEN_HANDLERS: Handlers = {
  [createPersonalAccessToken.id]: defineHandler(createPersonalAccessToken, async ({ name, scopes, expiresInDays }, context) => {
    const userId = ownerOf(context.caller);
    const { maxLifetimeDays } = await personalAccessTokenSettingsIn(context);
    assertLifetime(expiresInDays, maxLifetimeDays);
    const createdAt = context.now();
    const expiresAt = new Date(createdAt.getTime() + expiresInDays * DAY_MS);
    const token = newPersonalAccessToken();
    return context.write(async (writer) => {
      // A removal of the user under way commits first, and this one is refused, or waits for this one and revokes the token.
      await lockMembership(writer, userId);
      const [row] = await writer.tx
        .insert(personalAccessTokens)
        .values({ orgId: writer.orgId, userId, name, scopes: SCOPES.filter((scope) => scopes.includes(scope)), tokenHash: personalAccessTokenHash(token), createdAt, expiresAt })
        .returning({ id: personalAccessTokens.id });
      const tokenId = row?.id ?? "";
      await writer.record(personalAccessTokenCreated, { userId, tokenId });
      return { tokenId, token, expiresAt: expiresAt.toISOString() };
    });
  }),

  [getPersonalAccessTokenSettings.id]: defineHandler(getPersonalAccessTokenSettings, async (_input, context) => personalAccessTokenSettingsIn(context)),

  [listPersonalAccessTokens.id]: defineHandler(listPersonalAccessTokens, async (_input, context) => {
    const userId = ownerOf(context.caller);
    const now = context.now();
    const rows = await context.tx
      .select({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        scopes: personalAccessTokens.scopes,
        createdAt: personalAccessTokens.createdAt,
        expiresAt: personalAccessTokens.expiresAt,
      })
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.orgId, context.orgId), eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
      .orderBy(asc(personalAccessTokens.createdAt), asc(personalAccessTokens.id));
    return {
      tokens: rows.map((row) => ({
        id: row.id,
        name: row.name,
        scopes: SCOPES.filter((scope) => row.scopes.includes(scope)),
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        expired: row.expiresAt.getTime() <= now.getTime(),
      })),
    };
  }),

  [revokePersonalAccessToken.id]: defineHandler(revokePersonalAccessToken, async ({ tokenId }, context) => {
    const userId = ownerOf(context.caller);
    const at = context.now();
    return context.write(async (writer) => {
      const [token] = await writer.tx
        .select({ id: personalAccessTokens.id })
        .from(personalAccessTokens)
        .where(
          and(
            eq(personalAccessTokens.orgId, writer.orgId),
            eq(personalAccessTokens.id, tokenId),
            eq(personalAccessTokens.userId, userId),
            isNull(personalAccessTokens.revokedAt),
          ),
        )
        .for("update");
      if (token === undefined) throw new Refusal("record-not-found", "You hold no personal access token with this id that may still be revoked.");
      await writer.tx
        .update(personalAccessTokens)
        .set({ revokedAt: at })
        .where(and(eq(personalAccessTokens.orgId, writer.orgId), eq(personalAccessTokens.id, tokenId)));
      await writer.record(personalAccessTokenRevoked, { userId, tokenId });
      return { tokenId };
    });
  }),

  [getPersonalAccessTokenAdminSettings.id]: defineHandler(getPersonalAccessTokenAdminSettings, async (_input, context) => personalAccessTokenSettingsIn(context)),

  [setPersonalAccessTokens.id]: defineHandler(setPersonalAccessTokens, async ({ on }, context) => {
    const { on: previousOn } = await personalAccessTokenSettingsIn(context, true);
    if (previousOn === on) return { on, previousOn };
    return context.write(async (writer) => {
      await writer.tx
        .insert(installSettings)
        .values({ orgId: writer.orgId, personalAccessTokensOn: on })
        .onConflictDoUpdate({ target: installSettings.orgId, set: { personalAccessTokensOn: on } });
      await writer.record(personalAccessTokensSwitched, { on, previousOn });
      return { on, previousOn };
    });
  }),

  [setPersonalAccessTokenMaxLifetime.id]: defineHandler(setPersonalAccessTokenMaxLifetime, async ({ maxLifetimeDays }, context) => {
    const { maxLifetimeDays: previousMaxLifetimeDays } = await personalAccessTokenSettingsIn(context, true);
    if (previousMaxLifetimeDays === maxLifetimeDays) return { maxLifetimeDays, previousMaxLifetimeDays };
    return context.write(async (writer) => {
      await writer.tx
        .insert(installSettings)
        .values({ orgId: writer.orgId, personalAccessTokenMaxDays: maxLifetimeDays })
        .onConflictDoUpdate({ target: installSettings.orgId, set: { personalAccessTokenMaxDays: maxLifetimeDays } });
      await writer.record(personalAccessTokenMaxLifetimeChanged, { maxLifetimeDays, previousMaxLifetimeDays });
      return { maxLifetimeDays, previousMaxLifetimeDays };
    });
  }),
};

/** The review of a new token: what it may do and when it expires, in Tiehall's own words, with the label quoted. */
export const PERSONAL_ACCESS_TOKEN_REVIEWS: Reviews = {
  [createPersonalAccessToken.id]: async (input, context) => {
    const { name, scopes, expiresInDays } = input as CreateInput;
    const { maxLifetimeDays } = await personalAccessTokenSettingsIn(context);
    assertLifetime(expiresInDays, maxLifetimeDays);
    const review: Review = {
      title: "Create a personal access token",
      lines: [
        { text: "A personal access token acts as you, within your role, for whatever holds it, such as a script or a host that can only send a header. Its label:" },
        { quote: name, origin: "external" },
        { text: "It may:" },
        ...SCOPES.filter((scope) => scopes.includes(scope)).map((scope) => ({ text: SCOPE_TEXTS[scope] ?? scope })),
        { text: `It expires in ${expiresInDays} ${expiresInDays === 1 ? "day" : "days"}, on ${day(new Date(Date.now() + expiresInDays * DAY_MS))}.` },
        {
          text: "The next page shows its value once: copy it then. Tiehall keeps only a hash of it and cannot show it again. You can revoke it on your Connected agents and tokens page.",
        },
      ],
    };
    return review;
  },
};

/** The reviews of an admin's changes to the PAT switch and the longest lifetime, in Tiehall's own words. */
export const PERSONAL_ACCESS_TOKEN_SETTINGS_REVIEWS: Reviews = {
  [setPersonalAccessTokens.id]: async (input, context) => {
    const { on } = input as { on: boolean };
    const current = await personalAccessTokenSettingsIn(context);
    const lines =
      current.on === on
        ? [{ text: `Personal access tokens are already switched ${on ? "on" : "off"}, so confirming changes nothing.` }]
        : on
          ? [
              { text: "Switch personal access tokens on for the install." },
              { text: "From then on, calls with personal access tokens are accepted again, those created while they were off included, unless a token has expired or was revoked." },
            ]
          : [
              { text: "Switch personal access tokens off for the install." },
              {
                text: "From then on, every call with a personal access token is refused with 403, those created before included. No token is revoked: switching them on again lets the ones that have not expired work again.",
              },
            ];
    return { title: on ? "Switch personal access tokens on" : "Switch personal access tokens off", lines };
  },
  [setPersonalAccessTokenMaxLifetime.id]: async (input, context) => {
    const { maxLifetimeDays } = input as { maxLifetimeDays: number };
    const current = await personalAccessTokenSettingsIn(context);
    const lines =
      current.maxLifetimeDays === maxLifetimeDays
        ? [{ text: `A new personal access token already lives at most ${maxLifetimeDays} days, so confirming changes nothing.` }]
        : [
            { text: `Change the longest lifetime of a new personal access token from ${current.maxLifetimeDays} to ${maxLifetimeDays} days.` },
            { text: "Tokens that exist keep their expiry; a token created from then on expires within the new lifetime." },
          ];
    return { title: "Change the longest lifetime of personal access tokens", lines };
  },
};

/** A created token's value, on the confirmation's page, this once. */
export const PERSONAL_ACCESS_TOKEN_MESSAGES: ConfirmMessages = {
  [createPersonalAccessToken.id]: (output) => {
    const { token, expiresAt } = output as { token: string; expiresAt: string };
    return {
      title: "Your new personal access token",
      text: `Copy it now: Tiehall keeps only a hash of it and will not show it again. It expires on ${day(new Date(expiresAt))}.`,
      value: token,
      wayOn: { href: TOKENS_PATH, text: "Back to Connected agents and tokens" },
    };
  },
};

/**
 * Revokes, in a removal's write, every personal access token the removed
 * person holds that was not revoked yet, each with its security event
 * (teams-and-roles: Removing a member).
 */
export async function revokePersonalAccessTokensOf(writer: Writer, userId: string, at: Date): Promise<void> {
  const revoked = await writer.tx
    .update(personalAccessTokens)
    .set({ revokedAt: at })
    .where(and(eq(personalAccessTokens.orgId, writer.orgId), eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
    .returning({ tokenId: personalAccessTokens.id, createdAt: personalAccessTokens.createdAt });
  revoked.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.tokenId.localeCompare(b.tokenId));
  for (const { tokenId } of revoked) await writer.record(personalAccessTokenRevoked, { userId, tokenId });
}

/** A personal access token a call named, as its check found it. */
export interface FoundPersonalAccessToken {
  id: string;
  userId: string;
  scopes: readonly Scope[];
  /** Whether it may be used: it has not expired and was not revoked. */
  usable: boolean;
  /** Whether its user is a member of the install now. */
  member: boolean;
}

/**
 * The personal access token a call's bearer token names, looked up by its
 * digest in a read-only transaction, with whether it may still be used, by the
 * given clock, and whether its user is a member now; undefined for a value no
 * token has.
 */
export async function findPersonalAccessToken(database: Database, value: string, now: Date): Promise<FoundPersonalAccessToken | undefined> {
  const [row] = await withOrg(
    database,
    ({ tx, orgId }) =>
      tx
        .select({
          id: personalAccessTokens.id,
          userId: personalAccessTokens.userId,
          scopes: personalAccessTokens.scopes,
          expiresAt: personalAccessTokens.expiresAt,
          revokedAt: personalAccessTokens.revokedAt,
          member: members.userId,
        })
        .from(personalAccessTokens)
        .leftJoin(members, and(eq(members.orgId, personalAccessTokens.orgId), eq(members.userId, personalAccessTokens.userId)))
        .where(and(eq(personalAccessTokens.orgId, orgId), eq(personalAccessTokens.tokenHash, personalAccessTokenHash(value)))),
    { readOnly: true },
  );
  if (row === undefined) return undefined;
  return {
    id: row.id,
    userId: row.userId,
    scopes: SCOPES.filter((scope) => row.scopes.includes(scope)),
    usable: row.revokedAt === null && row.expiresAt.getTime() > now.getTime(),
    member: row.member !== null,
  };
}

/** The caller a found personal access token makes: its user, within its scopes, on /api/v1. */
export function personalAccessTokenCaller(found: FoundPersonalAccessToken): PersonalAccessTokenCaller {
  return { kind: "personal_access_token", userId: found.userId, tokenId: found.id, scopes: found.scopes, surface: "api" };
}

// The "Connected agents and tokens" page, /tokens (agent-access: Users list and
// revoke their own agent grants and tokens; agent-access: Personal access
// tokens are scoped, expiring and created in the web UI). Every signed-in
// member has one. It lists, for them alone:
// - the grants they gave agent clients, the tiehall CLI's included: who each
//   client says it is, quoted as its own claim, whether its identity is
//   verified, what it may do and when they approved it, each with a form that
//   revokes the grant, which stops its refresh token at once;
// - their personal access tokens that were not revoked: each one's label,
//   scopes and expiry, never its value, with a form that revokes it, which
//   stops it at once;
// - the form that creates a personal access token: a label, the scopes and
//   the lifetime, which says the install's longest.
// Each form's POST passes the web UI's write checks. A revocation needs no
// confirmation step, since it only takes access away: it runs at once, as a
// security event, and leads back to the page; a grant or a token that is not
// the member's gets 404, as one that does not exist. The creation's form leads
// to its review page for exactly what the form named, where the token is
// created with the confirmation step; a value the form names that the
// command's schema does not take reaches the review page as it was sent,
// which refuses it with 400.

/** The number a form's field names, or the field as it was sent, which the schema then refuses. */
function numberField(value: string | null): number | string {
  const text = (value ?? "").trim();
  return /^\d{1,6}$/.test(text) ? Number(text) : text;
}

/** The review page of a new token, for exactly what the form named. */
function reviewPath(input: unknown): string {
  return `${CONFIRM_PATH}${createPersonalAccessToken.id}?input=${encodeURIComponent(JSON.stringify(input))}`;
}

type ListedGrant = z.output<typeof listAgentGrants.output>["grants"][number];
type ListedToken = z.output<typeof listPersonalAccessTokens.output>["tokens"][number];

export function createTokensRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: TOKENS_PATH,
    name: "Connected agents and tokens",
    async get(_query, { read, csrf }) {
      const settings = await read<{ on: boolean; maxLifetimeDays: number }>(getPersonalAccessTokenSettings.id, {});
      const { grants } = await read<{ grants: ListedGrant[] }>(listAgentGrants.id, {});
      const { tokens } = await read<{ tokens: ListedToken[] }>(listPersonalAccessTokens.id, {});
      return htmlAnswer(tokensPage(settings, grants, tokens, csrf));
    },
    async post(form, { write }) {
      switch (form.get("action")) {
        case "revoke_grant":
          await write(revokeAgentGrant.id, { grantId: form.get("grant") ?? "" });
          return seeOther(TOKENS_PATH);
        case "revoke_token":
          await write(revokePersonalAccessToken.id, { tokenId: form.get("token") ?? "" });
          return seeOther(TOKENS_PATH);
        case "create":
          return seeOther(reviewPath({ name: form.get("name") ?? "", scopes: form.getAll("scope"), expiresInDays: numberField(form.get("expiresInDays")) }));
        default:
          throw new Refusal("route-not-found", "The Connected agents and tokens page offers no such action.");
      }
    },
  });
}

/** A day as the page shows it, in UTC. */
function pageDay(at: string): string {
  return `${at.slice(0, 10)} (UTC)`;
}

/** What a list of scopes lets a client or a token do, in Tiehall's own words. */
function scopeList(scopes: readonly string[]): string[] {
  return scopes.map((scope) => `          <li>${escapeHtml(SCOPE_TEXTS[scope] ?? scope)}</li>`);
}

/** One grant: who the client says it is, what it may do, and the form that revokes it. */
function grantItem(grant: ListedGrant, csrf: string): string {
  const who = grant.client.cli
    ? ["        <p>The tiehall CLI, signed in with tiehall login.</p>"]
    : [
        grant.client.name === null
          ? "        <p>An agent client that gives no name.</p>"
          : `        <p>An agent client that calls itself:</p>\n        <blockquote class="untrusted" data-origin="external"><p>${escapeHtml(quotePreamble("external"))}</p><pre>${escapeHtml(grant.client.name)}</pre></blockquote>`,
        grant.client.verifiedHost === null
          ? "        <p>Unverified client: it registered itself with this install.</p>"
          : `        <p>${escapeHtml(`Verified: it is identified by its metadata document on ${grant.client.verifiedHost}.`)}</p>`,
      ];
  return [
    "      <li>",
    ...who,
    `        <p>${escapeHtml(`Approved on ${pageDay(grant.approvedAt)}. It may:`)}</p>`,
    "        <ul>",
    ...scopeList(grant.scopes),
    "        </ul>",
    postForm(TOKENS_PATH, { action: "revoke_grant", grant: grant.id }, csrf, "Revoke this grant", "        "),
    "      </li>",
  ].join("\n");
}

/** One personal access token: its label, what it may do, its expiry, and the form that revokes it. */
function tokenItem(token: ListedToken, csrf: string): string {
  return [
    "      <li>",
    `        <p>${escapeHtml(token.name)}</p>`,
    `        <p>${escapeHtml(`Created on ${pageDay(token.createdAt)}; ${token.expired ? "expired" : "expires"} on ${pageDay(token.expiresAt)}. It may:`)}</p>`,
    "        <ul>",
    ...scopeList(token.scopes),
    "        </ul>",
    postForm(TOKENS_PATH, { action: "revoke_token", token: token.id }, csrf, "Revoke this token", "        "),
    "      </li>",
  ].join("\n");
}

/** The page: the member's grants and tokens, each with its revoke form, and the form that creates a personal access token. */
function tokensPage(
  { on, maxLifetimeDays }: { on: boolean; maxLifetimeDays: number },
  grants: readonly ListedGrant[],
  tokens: readonly ListedToken[],
  csrf: string,
): string {
  const defaultDays = Math.min(30, maxLifetimeDays);
  return htmlPage(
    "Connected agents and tokens",
    [
      "      <h1>Connected agents and tokens</h1>",
      "      <h2>Agent clients you approved</h2>",
      "      <p>Each acts as you, within your role and what it may do. Revoking a grant stops its refresh token at once; access tokens it already holds stop working within 10 minutes.</p>",
      ...(grants.length === 0 ? ["      <p>You have approved no agent client.</p>"] : ["      <ul>", ...grants.map((grant) => grantItem(grant, csrf)), "      </ul>"]),
      "      <h2>Personal access tokens</h2>",
      "      <p>Revoking a personal access token stops it working at once.</p>",
      ...(on ? [] : ["      <p>An admin has switched personal access tokens off in this install: calls with them are refused until an admin switches them on again.</p>"]),
      ...(tokens.length === 0 ? ["      <p>You have no personal access token.</p>"] : ["      <ul>", ...tokens.map((token) => tokenItem(token, csrf)), "      </ul>"]),
      "      <h2>Create a personal access token</h2>",
      "      <p>A personal access token lets a script, or a host that can only send a header, call Tiehall's API as you, within your role and the scopes you choose. Creating one needs a confirmation.</p>",
      `      <form method="post" action="${TOKENS_PATH}">`,
      '        <input type="hidden" name="action" value="create">',
      `        <p><label for="token-name">Label</label></p>`,
      `        <p><input type="text" id="token-name" name="name" maxlength="100" required></p>`,
      "        <fieldset>",
      "          <legend>Scopes</legend>",
      ...SCOPES.map(
        (scope) =>
          `          <p><input type="checkbox" id="scope-${escapeHtml(scope.replace(":", "-"))}" name="scope" value="${escapeHtml(scope)}"> <label for="scope-${escapeHtml(scope.replace(":", "-"))}">${escapeHtml(SCOPE_TEXTS[scope] ?? scope)}</label></p>`,
      ),
      "        </fieldset>",
      `        <p><label for="token-days">${escapeHtml(`Days until it expires, at most ${maxLifetimeDays}`)}</label></p>`,
      `        <p><input type="number" id="token-days" name="expiresInDays" min="1" max="${maxLifetimeDays}" value="${defaultDays}" required></p>`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      '        <button type="submit">Review the token</button>',
      "      </form>",
    ].join("\n"),
  );
}
