import { approveDevice } from "@tiehall/catalog";
import { canonicalJson, httpProblem, internalErrorProblem, Refusal, type HttpProblem, type Review, type ReviewLine } from "@tiehall/core";
import { oauthDeviceCodes } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { readAgentClient } from "./agent-clients.ts";
import { memberOf, storeGrant } from "./agent-grants.ts";
import { REFRESH_SCOPE } from "./authorization-server.ts";
import type { WebSessionCaller } from "./caller.ts";
import { CONFIRM_PATH, renderReviewPage, type ConfirmEntries, type ConfirmMessages } from "./confirm-route.ts";
import type { ConfirmationStep, Reviews } from "./confirmation-step.ts";
import { SCOPE_TEXTS } from "./consent.ts";
import { CLI_CLIENT_ID, DEVICE_APPROVAL_PATH } from "./device-flow.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS, TO_SIGN_IN, type WayOn } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { assertWebWrite, csrfTokenFor } from "./web-writes.ts";
import type { OrgContext } from "./with-org.ts";

// The device approval page, at /device (agent-access: The device approval page
// cannot be prefilled; agent-access: The CLI signs in through a restricted
// device flow; agent-safety: Actions that need the confirmation step;
// activity-log: Which actions are security events; design.md, Design rules:
// Agent access; design.md, Technical decisions: T7; design.md, Self-hosting
// decisions: S2, S7 and S14).
//
// `tiehall login <url>` asks the install's device authorization endpoint for
// a code and prints it with the address of this page (device-flow.ts). The
// person opens the page, signed in as a member; a browser without a session is
// sent to sign in first and comes back to the page, without anything its link
// carried. The page:
// - ignores any code its URL carries, so a link cannot bring someone else's
//   code to it: its code field is always empty, and the person types the code
//   the CLI printed;
// - takes the typed code only in the body of the form it posts to itself, with
//   the session's CSRF token, from the install's own origin (the checks every
//   web UI write passes, though this post stores nothing), and finds the code
//   however it was typed, in lower case, with a dash or with spaces;
// - then shows the review of the approval, in Tiehall's own words: the IP
//   address and the time of the request that started the flow, as the install
//   saw them after the proxies the operator names, "Continue only if you just
//   ran tiehall login", and what the CLI may do; it asks for no choice of org,
//   since the install has one;
// - stores nothing until the person confirms: the code stays pending and bound
//   to nobody, no grant exists, and the CLI's polls get authorization_pending.
// A code that no sign-in is waiting with gets 404, and an expired one, or one
// that was approved already, 409 (public-api: One error model for Tiehall's
// own refusals: an expired device code on the device approval page); a
// refusal is a page for a browser and a problem for any other client
// (html.ts).
//
// Approving is an action that needs the confirmation step: the review's form
// posts to the confirmation step, /confirm/agent_clients.approve_device, with a
// nonce bound to the member, their web session and this code. Confirmed, the
// approval binds the code to the member, stores the CLI's grant with the scopes
// and the resource the code asked for, and appends its security event, in one
// transaction; the CLI's next poll gets its tokens. Without a valid
// confirmation it gets 403 and the CLI gets no token. The review page of the
// approval is served only by this page: a GET of its path under /confirm, which
// a link could carry a code to, sends the browser here instead.

/** The page's title, and the heading of its form and its review. */
const TITLE = "Sign in the tiehall CLI";

/** The label of the page's code field. */
const CODE_LABEL = "The code tiehall login printed";

/** How long the CLI waits for a person, as the code's lifetime says it. */
const EXPIRED = "This code has expired: a code of tiehall login lasts 10 minutes. Run tiehall login again for a new one.";

/** The code as the person typed it, as the install keeps codes: its letters and digits, in upper case. */
export function normalizeUserCode(typed: string): string {
  return typed.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** A device code waiting for a person's approval, as the page and the approval read it. */
interface WaitingCode {
  id: string;
  scope: string | null;
  resources: readonly string[];
  /** The client address the request that started the flow came from; undefined when the install could not tell it. */
  requestedFrom: string | undefined;
  requestedAt: Date;
}

/**
 * The code a sign-in of the CLI is waiting with, read in the caller's
 * transaction and, for the approval, locked: 404 for a code no sign-in is
 * waiting with, 409 for one that has expired or was approved already.
 */
async function waitingCodeIn(context: Pick<OrgContext, "tx" | "orgId">, userCode: string, now: Date, lock: boolean): Promise<WaitingCode> {
  const query = context.tx
    .select({
      id: oauthDeviceCodes.id,
      status: oauthDeviceCodes.status,
      expiresAt: oauthDeviceCodes.expiresAt,
      clientId: oauthDeviceCodes.oauthClientId,
      scope: oauthDeviceCodes.scope,
      resources: oauthDeviceCodes.resources,
      requestedFrom: oauthDeviceCodes.requestedFrom,
      requestedAt: oauthDeviceCodes.requestedAt,
    })
    .from(oauthDeviceCodes)
    .where(and(eq(oauthDeviceCodes.orgId, context.orgId), eq(oauthDeviceCodes.userCode, userCode)));
  const [code] = lock ? await query.for("update") : await query;
  if (code === undefined || code.clientId !== CLI_CLIENT_ID) {
    throw new Refusal("record-not-found", "No sign-in of the tiehall CLI is waiting with this code. Check the code tiehall login printed.");
  }
  if (code.expiresAt.getTime() <= now.getTime()) throw new Refusal("conflict", EXPIRED);
  if (code.status !== "pending") throw new Refusal("conflict", "This code was used already. Run tiehall login again for a new one.");
  return {
    id: code.id,
    scope: code.scope,
    resources: code.resources ?? [],
    requestedFrom: code.requestedFrom ?? undefined,
    requestedAt: code.requestedAt,
  };
}

/** The scopes a code asks for, as Tiehall offers them: without the refresh scope the server adds itself. */
function offeredScopesOf(scope: string | null): string[] {
  return (scope ?? "").split(/\s+/).filter((each) => each !== "" && each !== REFRESH_SCOPE);
}

/** A time as the page shows it: to the second, in UTC. */
function utc(at: Date): string {
  return `${at.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** The approval's review: where and when the sign-in started, and what the CLI may do, in Tiehall's own words. */
function deviceReview(code: WaitingCode): Review {
  const lines: ReviewLine[] = [
    { text: "The tiehall CLI asks to act for you in Tiehall. Someone started this sign-in with tiehall login:" },
    {
      text:
        code.requestedFrom === undefined
          ? `from an IP address the install could not tell, at ${utc(code.requestedAt)}.`
          : `from the IP address ${code.requestedFrom}, at ${utc(code.requestedAt)}.`,
    },
    { text: "Continue only if you just ran tiehall login." },
    { text: "It asks to:" },
    ...offeredScopesOf(code.scope).map((scope) => ({ text: SCOPE_TEXTS[scope] ?? scope })),
    {
      text: "It will act as you, within your role, until you revoke it on your Connected agents and tokens page. A commitment it proposes still takes effect only once a person confirms it here.",
    },
  ];
  return { title: TITLE, lines };
}

export const DEVICE_APPROVAL_HANDLERS: Handlers = {
  [approveDevice.id]: defineHandler(approveDevice, async ({ userCode }, context) => {
    const userId = memberOf(context.caller);
    const at = context.now();
    return context.write(async (writer) => {
      const code = await waitingCodeIn(writer, normalizeUserCode(userCode), at, true);
      const client = await readAgentClient(writer, CLI_CLIENT_ID);
      if (client === undefined) throw new Error("The tiehall CLI is not a registered client of the install.");
      // The code is the member's now; the CLI's next poll exchanges it for tokens that act for them.
      await writer.tx
        .update(oauthDeviceCodes)
        .set({ status: "approved", userId })
        .where(and(eq(oauthDeviceCodes.orgId, writer.orgId), eq(oauthDeviceCodes.id, code.id)));
      const scopes = [...offeredScopesOf(code.scope), REFRESH_SCOPE];
      const grantId = await storeGrant(writer, { client, userId, scopes, resources: code.resources, at });
      return { grantId };
    });
  }),
};

/** The review of an approval: the code's request, read in the review's read-only transaction. */
export const DEVICE_APPROVAL_REVIEWS: Reviews = {
  [approveDevice.id]: async (input, context) => {
    const { userCode } = input as { userCode: string };
    return deviceReview(await waitingCodeIn(context, normalizeUserCode(userCode), new Date(), false));
  },
};

/** The approval's review page is served only by the device approval page, where the person types the code. */
export const DEVICE_APPROVAL_ENTRIES: ConfirmEntries = { [approveDevice.id]: DEVICE_APPROVAL_PATH };

/** A confirmed approval tells the person to go back to the terminal, where the CLI goes on by itself. */
export const DEVICE_APPROVAL_MESSAGES: ConfirmMessages = {
  [approveDevice.id]: {
    title: "The tiehall CLI is signed in",
    text: "The tiehall CLI is signed in for you. Return to your terminal: tiehall login finishes by itself.",
  },
};

export interface DeviceApprovalRouteOptions {
  /** The confirmation step, whose review of the approval the page shows, with its nonce. */
  step: ConfirmationStep;
  /**
   * The web session the request's cookie names; undefined when nobody is
   * signed in, a refusal for an ended session or a removed member's. The read
   * may renew the session, and adds to `renewal` the cookies the answer carries.
   */
  session(request: Request, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  /** The install's URL (TIEHALL_URL), as its origin, which the page's form's Origin must equal. */
  url: string;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: string | (() => string);
  logger?: Logger;
}

export type DeviceApprovalRoute = (request: Request) => Promise<Response>;

/** Where a refusal on the page leads a browser on: back to the page, without anything its link carried. */
const TO_PAGE: WayOn = { href: DEVICE_APPROVAL_PATH, text: "Back to the device approval page" };

export function createDeviceApprovalRoute(options: DeviceApprovalRouteOptions): DeviceApprovalRoute {
  const logger = options.logger ?? createLogger();
  const secret = () => (typeof options.secret === "string" ? options.secret : options.secret());
  return (request) => renewingSession((renewal) => devicePage(request, renewal));

  async function devicePage(request: Request, renewal: Headers): Promise<Response> {
    try {
      if (request.method === "GET" || request.method === "HEAD") {
        const caller = await options.session(request, renewal);
        // A browser without a session signs in first, and comes back to the page, without any code its link carried.
        if (caller === undefined) return signInFirst();
        return page(codeForm(csrfTokenFor(secret(), caller.sessionId)));
      }
      if (request.method !== "POST") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request, renewal);
      if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to sign the tiehall CLI in.");
      // The typed code travels only in the body of the page's own form; the URL's query is never read.
      const form = new URLSearchParams(await request.text());
      assertWebWrite(
        { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
        { url: options.url, secret: secret(), sessionId: caller.sessionId, confirm: false },
      );
      // The approval's review, with the nonce for this one code, as the confirmation step gives it.
      const reviewed = await options.step.review(approveDevice.id, caller, { userCode: normalizeUserCode(form.get("user_code") ?? "") });
      return page(
        renderReviewPage(
          `${CONFIRM_PATH}${approveDevice.id}`,
          reviewed.review,
          canonicalJson(reviewed.input),
          reviewed.nonce,
          csrfTokenFor(secret(), caller.sessionId),
        ),
      );
    } catch (error) {
      if (error instanceof Refusal) return answerRefusal(request, httpProblem(error), error.reason === "unauthenticated" ? TO_SIGN_IN : TO_PAGE);
      logger.error("device approval: the device approval page failed", { error });
      return problem(internalErrorProblem());
    }
  }
}

/** The page's form: an empty code field, which the person fills in with the code the CLI printed. */
function codeForm(csrf: string): string {
  return htmlPage(
    TITLE,
    [
      `      <h1>${escapeHtml(TITLE)}</h1>`,
      "      <p>Type the code that tiehall login printed in your terminal. The next page shows where and when that sign-in started, before you approve it.</p>",
      `      <form method="post" action="${DEVICE_APPROVAL_PATH}">`,
      `        <p><label for="user_code">${escapeHtml(CODE_LABEL)}</label></p>`,
      `        <p><input type="text" id="user_code" name="user_code" value="" autocomplete="off" autocapitalize="characters" spellcheck="false" required></p>`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      "        <button type=\"submit\">Continue</button>",
      "      </form>",
    ].join("\n"),
  );
}

function page(html: string): Response {
  return new Response(html, { headers: PAGE_HEADERS });
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal cannot be framed either.
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] } });
}

/** Sends a browser without a session to the sign-in page, which brings it back to the page; the answer holds nothing of the page. */
function signInFirst(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `/sign-in?return=${encodeURIComponent(DEVICE_APPROVAL_PATH)}`,
      "cache-control": "no-store",
      "content-security-policy": PAGE_HEADERS["content-security-policy"],
    },
  });
}
