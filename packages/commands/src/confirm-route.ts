import { confirmProposal, rejectProposal, undoCommitment, type SealedField } from "@tiehall/catalog";
import { canonicalJson, httpProblem, internalErrorProblem, quotePreamble, Refusal, type HttpProblem, type Review } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { ConfirmationStep } from "./confirmation-step.ts";
import type { Execute } from "./execute.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS, wayOnFor } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { assertWebWrite, csrfTokenFor } from "./web-writes.ts";

// The review pages of the confirmation step, under /confirm/<command id>
// (agent-safety: The review page of the confirmation step; design.md,
// Self-hosting decisions: S7 and S15). A page of the web UI that starts an
// action that needs the confirmation step sends the person here, with the
// action's input as JSON in the `input` query parameter. A GET:
// - renders what the action will do, in Tiehall's own words, from the
//   command's review, with every quote of text Tiehall did not write escaped
//   and fenced under a preamble that names where it came from;
// - holds a form that posts the action's parsed input, in canonical JSON, back
//   to the same path, with the page's confirmation nonce and the session's
//   CSRF token;
// - changes no state: the review runs in a read-only transaction.
// A few actions ask the person to enter a value on the review page itself,
// such as a secret (github-app-reachability: design.md, Design rules: Moving
// to webhook mode): the form holds a password field, or a file field for a
// key, which the page renders empty. Such a value is no part of the action's
// input, which the page's URL carries: it travels only in the body of the
// POST that applies the action, and no page or URL ever shows it.
// The POST applies the action (agent-safety: One confirmation approves one
// action): only for the signed-in user, only once it passes the checks every
// web UI write passes (the session's CSRF token, an Origin equal to
// TIEHALL_URL and Sec-Fetch-Site: same-origin), and only through execute(),
// which checks and consumes the nonce in the action's own transaction. A
// request that fails a check, or carries no valid nonce, gets 403 and changes
// nothing, so the session and the CSRF token alone never apply an action. An
// applied action gives the person who confirmed it a receipt, in its own
// transaction (requests: Receipts; confirmation-step.ts), and answers with a
// "Confirmed" page, or, for a command listed
// under downloads, such as the activity log's export, with the file made from
// its output (activity-log: Exporting the activity log), or, for one listed
// under redirects, such as an agent client's approval, by sending the browser
// on to the path on the install its output names (agent-access: Approving an
// agent client uses the confirmation step), or, for one listed under messages,
// such as the tiehall CLI's approval or a new personal access token, with a
// page in its own words made from its output. The review page of a command
// listed under entries, such as the CLI's approval, is served only by a page
// of its own: a GET of its path here sends the browser to that page, whatever
// input its link carried (agent-access: The device approval page cannot be
// prefilled), and a refusal of its form leads back there.
// A GET from a browser without a session shows nothing of the action: it is
// sent to the sign-in page, which brings it back to the same page once it has
// signed in (D28 #66; requests: The proposal's confirm page).
// Every answer, refusals included, sends a Content-Security-Policy with
// frame-ancestors 'none', so no other site can frame the page and trick a
// click; the pages run no script and load nothing. A refusal is a page for a
// browser, which leads back to the review page, or to sign in, and an RFC
// 9457 problem for every other client (public-api: One error model for
// Tiehall's own refusals; html.ts): 401 for
// a POST without a signed-in user, 404 for an action with no review page, 403
// removed-member for a user who is no longer a member, whatever they send, 400
// for input that fails its schema or is not JSON, 403 for a failed check or a
// missing or invalid nonce. Every answer, a refusal's and a file's included,
// carries the cookie that renews the session the route read, when the read
// renewed it (sign-in: Signing out and ending sessions; session-renewal.ts).
//
// A proposal's confirm page is /confirm/{proposal} (requests: The proposal's
// confirm page; design.md, Self-hosting decisions: S15): the review page of
// proposals.confirm for that proposal, whose nonce is bound to what the
// proposal proposes and the request it applies to. Besides its Confirm form, it
// holds a Reject form, which posts `action=reject` with the session's CSRF
// token and no nonce: a rejection needs no confirmation step, but passes the
// same write checks, and runs proposals.reject (agent-safety: Actions that need
// the confirmation step). Who may confirm or reject the proposal, and when, the
// commands decide: 403 or 409. /confirm/{proposal}/undo is the undo page that
// the receipt of a commitment that took effect links: the review page of
// proposals.undo for that proposal (requests: The undo window for reversible
// commitments).

/** A file a confirmed action answers with, such as the activity log's export. */
export interface Download {
  filename: string;
  contentType: string;
  body: string;
}

/** The commands whose confirmation answers with a file made from the command's output, by the command's id. */
export type ConfirmDownloads = Readonly<Record<string, (output: unknown) => Download>>;

/**
 * The commands whose review page only a page of their own serves, by the
 * command's id, with that page's path: a GET of the command's path under
 * /confirm sends the browser to that page, so no link opens the review with
 * an input of its own. The device approval page serves the review of a code
 * the person typed there, never one a link carried (agent-access: The device
 * approval page cannot be prefilled).
 */
export type ConfirmEntries = Readonly<Record<string, string>>;

/**
 * The page a confirmation answers with in its command's own words: a title, a
 * sentence, a value it shows, such as a new personal access token's, and a
 * link on.
 */
export interface ConfirmMessage {
  title: string;
  text: string;
  /** A value the page shows once, such as a new personal access token. */
  value?: string;
  wayOn?: { href: string; text: string };
}

/**
 * The commands whose confirmation answers with a page in their own words,
 * made from the command's output, instead of the "Confirmed" page, by the
 * command's id: an approval of the tiehall CLI tells the person to return to
 * their terminal, and a new personal access token's page shows its value, this
 * once.
 */
export type ConfirmMessages = Readonly<Record<string, (output: unknown) => ConfirmMessage>>;

/**
 * The commands whose confirmation sends the browser on, to a path on the
 * install that the command's output names, instead of the "Confirmed" page,
 * by the command's id: an agent client's approval goes back to the
 * authorization, which gives the client its code.
 */
export type ConfirmRedirects = Readonly<Record<string, (output: unknown) => string>>;

export interface ConfirmRouteOptions {
  step: ConfirmationStep;
  /** The commands whose confirmation answers with a file instead of the "Confirmed" page. */
  downloads?: ConfirmDownloads;
  /** The commands whose confirmation sends the browser on to a path on the install instead of the "Confirmed" page. */
  redirects?: ConfirmRedirects;
  /** The commands whose review page only a page of their own serves, with that page's path. */
  entries?: ConfirmEntries;
  /** The commands whose confirmation answers with a page in their own words instead of the "Confirmed" page. */
  messages?: ConfirmMessages;
  /**
   * The signed-in user's web session, from the request's session cookie;
   * undefined when nobody is signed in. The read may renew the session, and
   * adds to `renewal` the cookies the route's answer carries (session-renewal.ts).
   */
  session(request: Request, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  /** How a confirmation is applied and checked. */
  write: {
    execute: Execute;
    /** The install's URL (TIEHALL_URL), as its origin, which a confirmation's Origin must equal. */
    url: string;
    /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
    secret: string | (() => string);
  };
  logger?: Logger;
}

export type ConfirmRoute = (request: Request) => Promise<Response>;

/** Where the review pages live; a page's path names its command, such as /confirm/tokens.create. */
export const CONFIRM_PATH = "/confirm/";

/**
 * The paths the route serves, each of which the app mounts it on: a review
 * page's, a proposal's confirm page's and its undo page's, which is two
 * segments under /confirm. A braced part stands for one segment.
 */
export const CONFIRM_ROUTE_PATHS: readonly string[] = [`${CONFIRM_PATH}{command}`, `${CONFIRM_PATH}{proposal}`, `${CONFIRM_PATH}{proposal}/undo`];

export function createConfirmRoute(options: ConfirmRouteOptions): ConfirmRoute {
  const logger = options.logger ?? createLogger();
  const secret = () => (typeof options.write.secret === "string" ? options.write.secret : options.write.secret());
  return (request) => renewingSession((renewal) => confirm(request, renewal));

  async function confirm(request: Request, renewal: Headers): Promise<Response> {
    const url = new URL(request.url);
    const { proposal, undo } = proposalPageOf(url.pathname);
    const commandId = proposal === undefined ? commandIdOf(url.pathname) : undo ? undoCommitment.id : confirmProposal.id;
    // Where a refusal leads a browser on: back to the review page it asked for, or whose form it posted.
    const back = { path: `${url.pathname}${url.search}` };
    try {
      if (request.method === "POST") return await apply(request, renewal, commandId, proposal, undo, back);
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      // A review page that only a page of its own serves is never opened from a link: the browser goes to that page.
      const entry = proposal === undefined ? options.entries?.[commandId] : undefined;
      if (entry !== undefined) return onTo(entry);
      const caller = await options.session(request, renewal);
      // A browser without a session signs in first, and comes back to this page (agent-surfaces: A browser without a session is sent to sign-in).
      if (caller === undefined) return signInFirst(`${url.pathname}${url.search}`);
      const { input, refusal } = proposal === undefined ? parseInput(url.searchParams.get("input")) : { input: { proposal }, refusal: undefined };
      const reviewed = await options.step.review(commandId, caller, input, refusal);
      const csrf = csrfTokenFor(secret(), caller.sessionId);
      const path = proposal === undefined ? `${CONFIRM_PATH}${commandId}` : `${CONFIRM_PATH}${proposal}${undo ? "/undo" : ""}`;
      const fields = options.step.sealedFields(commandId);
      return page(renderReviewPage(path, reviewed.review, canonicalJson(reviewed.input), reviewed.nonce, csrf, proposal !== undefined && !undo, fields));
    } catch (error) {
      if (error instanceof Refusal) {
        return answerRefusal(request, httpProblem(error), wayOnFor(error.reason, { href: back.path, text: "Back to the review page" }));
      }
      logger.error("confirm: the review page failed", { operationId: commandId, error });
      return problem(internalErrorProblem());
    }
  }

  async function signedIn(request: Request, renewal: Headers): Promise<WebSessionCaller> {
    const caller = await options.session(request, renewal);
    if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to confirm an action.");
    return caller;
  }

  /** Applies the action the review page's form posted: the action it reviewed, or, on a proposal's page, a rejection. */
  async function apply(
    request: Request,
    renewal: Headers,
    commandId: string,
    proposal: string | undefined,
    undo: boolean,
    back: { path: string },
  ): Promise<Response> {
    const caller = await signedIn(request, renewal);
    if (!options.step.needsConfirmation(commandId)) throw new Refusal("route-not-found", "There is no review page for this action.");
    const form = await formOf(request);
    // A proposal's page is its own path; a command's review page is its path with the input its form posted, or the page that serves it.
    if (proposal === undefined) back.path = options.entries?.[commandId] ?? `${CONFIRM_PATH}${commandId}?input=${encodeURIComponent(form.get("input") ?? "")}`;
    const rejecting = proposal !== undefined && !undo && form.get("action") === "reject";
    assertWebWrite(
      { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
      { url: options.write.url, secret: secret(), sessionId: caller.sessionId, confirm: !rejecting },
    );
    const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const origin = { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) };
    if (rejecting) {
      // A rejection ends the proposal without any effect, so it needs no nonce.
      await options.write.execute(rejectProposal.id, caller, { proposal }, { origin });
      return page(messagePage({ title: "Rejected", text: "The proposal you reviewed is rejected; it will not take effect.", wayOn: { href: "/inbox", text: "Go to the inbox" } }));
    }
    // A proposal's page confirms the proposal its path names, whatever else the form sends.
    const { input, refusal } = proposal === undefined ? parseInput(form.get("input")) : { input: { proposal }, refusal: undefined };
    const nonce = form.get("nonce");
    const sealed: Record<string, string> = {};
    for (const { name } of options.step.sealedFields(commandId)) {
      const value = form.sealed(name);
      if (value !== undefined) sealed[name] = value;
    }
    const confirmation = nonce === null || nonce === "" ? undefined : nonce;
    // The receipt the action gives the person, in its own transaction, once it took effect (confirmation-step.ts).
    const receipt = refusal === undefined ? await options.step.receipt(commandId, caller, input, confirmation) : undefined;
    const output = await options.write.execute(commandId, caller, input, {
      ...(refusal === undefined ? {} : { refusal }),
      ...(confirmation === undefined ? {} : { confirmation: { nonce: confirmation } }),
      ...(receipt === undefined ? {} : { around: receipt }),
      sealed,
      origin,
    });
    const download = options.downloads?.[commandId];
    if (download !== undefined) return file(download(output));
    const redirect = options.redirects?.[commandId];
    if (redirect !== undefined) return onTo(redirect(output));
    const message = options.messages?.[commandId];
    if (message !== undefined) return page(messagePage(message(output)));
    return page(messagePage({ title: "Confirmed", text: "The action you reviewed is applied.", wayOn: { href: "/", text: "Go to Tiehall's home page" } }));
  }
}

/** The largest value a file field of a review page takes, such as a PEM key of a few kilobytes. */
const SEALED_FILE_MAX_BYTES = 64 * 1024;

/** The page of a confirmation in its command's own words: what was done, in a panel, with the way on as a button-styled link. */
function messagePage({ title, text, value, wayOn }: ConfirmMessage): string {
  return htmlPage(
    title,
    [
      '      <p class="eyebrow">Done</p>',
      `      <h1>${escapeHtml(title)}</h1>`,
      '      <div class="panel decision">',
      `      <p>${escapeHtml(text)}</p>`,
      ...(value === undefined ? [] : [`      <pre><code>${escapeHtml(value)}</code></pre>`]),
      ...(wayOn === undefined ? [] : [`      <p class="decision-end"><a class="button" href="${escapeHtml(wayOn.href)}">${escapeHtml(wayOn.text)}</a></p>`]),
      "      </div>",
    ].join("\n"),
  );
}

/** A review page's form as it was posted: its fields, and the values entered in its own fields, text or file. */
interface PostedForm {
  get(name: string): string | null;
  /** A value entered in one of the page's own fields: its text, or a file's text; undefined when none was sent. */
  sealed(name: string): string | undefined;
}

/**
 * Reads the posted form: URL-encoded, or multipart when the page asked for a
 * file. A file larger than a review page takes counts as no value, which the
 * command's schema then refuses; a body that is no multipart form counts as an
 * empty form, which the write checks then refuse.
 */
async function formOf(request: Request): Promise<PostedForm> {
  if (!/^multipart\/form-data\b/i.test(request.headers.get("content-type") ?? "")) {
    const fields = new URLSearchParams(await request.text());
    return { get: (name) => fields.get(name), sealed: (name) => fields.get(name) ?? undefined };
  }
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    data = new FormData();
  }
  const texts = new Map<string, string>();
  for (const [name, value] of data) {
    if (texts.has(name)) continue;
    if (typeof value === "string") texts.set(name, value);
    else if (value.size <= SEALED_FILE_MAX_BYTES) texts.set(name, await value.text());
  }
  return { get: (name) => texts.get(name) ?? null, sealed: (name) => texts.get(name) };
}

const PROPOSAL_PAGE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/undo)?$/;

/**
 * The proposal a page's path names: /confirm/{proposal}, its confirm page, or
 * /confirm/{proposal}/undo, the undo page its receipt links; none for any
 * other path.
 */
function proposalPageOf(pathname: string): { proposal?: string; undo: boolean } {
  if (!pathname.startsWith(CONFIRM_PATH)) return { undo: false };
  const match = PROPOSAL_PAGE.exec(pathname.slice(CONFIRM_PATH.length).toLowerCase());
  return match === null ? { undo: false } : { proposal: match[1] ?? "", undo: match[2] !== undefined };
}

/** The command a review page's path names; empty, which names none, for any other path. */
function commandIdOf(pathname: string): string {
  if (!pathname.startsWith(CONFIRM_PATH)) return "";
  try {
    return decodeURIComponent(pathname.slice(CONFIRM_PATH.length));
  } catch {
    return "";
  }
}

/**
 * The action's input from its JSON text, or the refusal of text that is not
 * JSON, which the review and execute() give after the membership re-check.
 */
function parseInput(text: string | null): { input: unknown; refusal?: Refusal } {
  try {
    return { input: JSON.parse(text ?? "{}") };
  } catch {
    return { input: {}, refusal: new Refusal("invalid-input", "The input of an action to confirm is JSON.") };
  }
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal on a review page cannot be framed either.
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] },
  });
}

function page(html: string): Response {
  return new Response(html, { headers: PAGE_HEADERS });
}

/** Sends a browser without a session to the sign-in page, which brings it back to this path; the answer holds nothing of the page. */
function signInFirst(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `/sign-in?return=${encodeURIComponent(path)}`,
      "cache-control": "no-store",
      "content-security-policy": PAGE_HEADERS["content-security-policy"],
    },
  });
}

/** Sends the browser on to a path on the install; anything that is not a path on the install is refused as a bug. */
function onTo(path: string): Response {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("A confirmation sends the browser on only to a path on the install.");
  return new Response(null, {
    status: 303,
    headers: { location: path, "cache-control": "no-store", "content-security-policy": PAGE_HEADERS["content-security-policy"] },
  });
}

/** The file a confirmed action answers with: sent as an attachment, never cached, and, like a page, not framed. */
function file({ filename, contentType, body }: Download): Response {
  return new Response(body, {
    headers: {
      ...PAGE_HEADERS,
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "")}"`,
    },
  });
}

/** One of the page's own fields, which the page renders empty and the person fills in. */
function sealedField(field: SealedField): string[] {
  const id = `sealed-${field.name}`;
  const control =
    field.kind === "password"
      ? `<input type="password" id="${id}" name="${escapeHtml(field.name)}" autocomplete="off" required>`
      : `<input type="file" id="${id}" name="${escapeHtml(field.name)}" required>`;
  return ['        <div class="field">', `          <label for="${id}">${escapeHtml(field.label)}</label>`, `          ${control}`, "        </div>"];
}

/**
 * What will happen, in Tiehall's own words, as a list, a warning among it in
 * the notice colors; each quote of text someone else wrote breaks the list
 * and stands as a fenced panel, whose first line names where the text came
 * from, as its label.
 */
function reviewLines(lines: Review["lines"]): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of lines) {
    if ("text" in line) {
      if (!open) out.push('      <ul class="review-lines">');
      open = true;
      out.push(`        <li${line.warning === true ? ' class="warning"' : ""}>${escapeHtml(line.text)}</li>`);
      continue;
    }
    if (open) out.push("      </ul>");
    open = false;
    out.push(`      <blockquote class="untrusted" data-origin="${escapeHtml(line.origin)}"><p>${escapeHtml(quotePreamble(line.origin))}</p><pre>${escapeHtml(line.quote)}</pre></blockquote>`);
  }
  if (open) out.push("      </ul>");
  return out;
}

/**
 * The review page: what will happen, and the form that applies it, posted to
 * this path, with a form that rejects it on a proposal's page. The consent
 * screen renders its review with it too.
 */
export function renderReviewPage(
  path: string,
  review: Review,
  input: string,
  nonce: string,
  csrf: string,
  rejectable = false,
  fields: readonly SealedField[] = [],
): string {
  const multipart = fields.some(({ kind }) => kind === "file");
  return htmlPage(
    `Confirm: ${review.title}`,
    [
      '      <p class="eyebrow">Review, then confirm</p>',
      `      <h1>${escapeHtml(review.title)}</h1>`,
      '      <div class="panel decision">',
      ...reviewLines(review.lines),
      '      <div class="decision-end">',
      `      <form method="post" action="${escapeHtml(path)}"${multipart ? ' enctype="multipart/form-data"' : ""}>`,
      `        <input type="hidden" name="input" value="${escapeHtml(input)}">`,
      `        <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      ...fields.flatMap(sealedField),
      `        <button type="submit">Confirm</button>`,
      `      </form>`,
      ...(rejectable
        ? [
            `      <form method="post" action="${escapeHtml(path)}">`,
            `        <input type="hidden" name="action" value="reject">`,
            `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
            `        <button type="submit" class="secondary">Reject</button>`,
            `      </form>`,
          ]
        : []),
      `      <a class="link-action" href="/">Cancel</a>`,
      "      </div>",
      "      </div>",
    ].join("\n"),
  );
}
