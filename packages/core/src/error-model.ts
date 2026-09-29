// The error model (public-api: One error model for Tiehall's own refusals;
// public-api: Errors are RFC 9457 problem details; design.md, Decisions this
// change rests on: D28 #1). When Tiehall refuses a call for one of its own
// reasons, it throws a Refusal that names the reason. Each reason is a row of
// the public-api spec's table, with the HTTP status that row gives and a
// problem type of its own, so that every surface answers the same refusal the
// same way:
// - every HTTP endpoint answers with an RFC 9457 problem details object, with
//   the media type application/problem+json (httpProblem);
// - the MCP tools answer with a tool error: a tool result with isError set,
//   whose content is the same problem and so names its type (toolError).
// The reasons whose status a protocol sets keep that status: the OAuth
// refusals, 412 for an If-Match that does not match, and 422 for an
// Idempotency-Key reused with a different body.
//
// A problem type is a URI under https://tiehall.com/problems/, one per row.
// It identifies the kind of refusal and is the same on every install; like the
// packet schema's $id, no install fetches it and it need not resolve. Where
// the spec names a type (setup-required, needs-human, upgrade-required,
// payload-too-large, integration-unavailable), that name ends the URI.

/** Where every problem type's URI starts. */
export const PROBLEM_TYPE_BASE = "https://tiehall.com/problems/";

interface Row {
  status: number;
  /** A short summary of the kind of refusal, the same for every occurrence of it (RFC 9457's title). */
  title: string;
  /** The Retry-After a refusal of this kind always carries, or "required" when each refusal says how long. */
  retryAfter?: number | "required";
  /** The WWW-Authenticate challenge of an OAuth refusal. */
  challenge?: string;
}

export const REFUSAL_REASONS = {
  /** No such route, or an operation that this surface does not offer. */
  "route-not-found": { status: 404, title: "No such operation" },
  /** The record that the path or the input names does not exist. */
  "record-not-found": { status: 404, title: "No such record" },
  /** Setup is not complete. */
  "setup-required": { status: 503, title: "Setup is not complete" },
  /** The app is shutting down, for example for an upgrade. */
  "shutting-down": { status: 503, title: "Tiehall is shutting down", retryAfter: 0 },
  /** The input fails the operation's input schema. */
  "invalid-input": { status: 400, title: "Invalid input" },
  /** A value is outside what the install's settings allow. */
  "outside-settings": { status: 400, title: "Outside the install's settings" },
  /** The CLI is older than its minimum supported version. */
  "upgrade-required": { status: 400, title: "Upgrade required" },
  /** The caller's role in the install, or their part in the request or record, does not allow the action. */
  forbidden: { status: 403, title: "Not allowed" },
  /** A GitHub account may not sign in under the install's sign-in rules. */
  "sign-in-refused": { status: 403, title: "Sign-in refused" },
  /** The admin has switched personal access tokens off. */
  "personal-access-tokens-off": { status: 403, title: "Personal access tokens are switched off" },
  /** A confirmation that the action needs is missing or invalid. */
  "confirmation-required": { status: 403, title: "Confirmation required" },
  /** The caller has been removed from the install. */
  "removed-member": { status: 403, title: "Removed from the install" },
  /** A retried MCP call carries a request state that is not valid for it. */
  "request-state-refused": { status: 403, title: "Request state refused" },
  /** An invalid bearer token, such as a replayed CI token, as OAuth answers it. */
  "invalid-token": { status: 401, title: "Invalid token", challenge: 'Bearer error="invalid_token"' },
  /** A CI caller calls an operation other than contract.report, or reports for an API outside its repository. */
  "ci-caller-refused": { status: 403, title: "Not allowed for a CI caller" },
  /** An agent write to a request flagged needs_human. */
  "needs-human": { status: 409, title: "The request needs a person" },
  /** Any other state conflict. */
  conflict: { status: 409, title: "Conflict" },
  /**
   * A request body is larger than the size limit: 2 MiB, or 16 MiB for
   * contract.report. Its detail names the limit that applied. It carries no
   * Retry-After, because the same body is refused again.
   */
  "payload-too-large": { status: 413, title: "Request body too large" },
  /** A packet revision is sent without If-Match. */
  "if-match-required": { status: 428, title: "If-Match required" },
  /** A write limit, a budget or a request cap is exceeded. */
  "rate-limited": { status: 429, title: "Limit exceeded", retryAfter: "required" },
  /**
   * GitHub or the Jira site failed a call that the action needs: it answered
   * with an error the action gives no answer of its own for, or did not answer
   * within 10 seconds. The action changes nothing and leaves its confirmation
   * unused. It carries no Retry-After, because nobody can say when GitHub or
   * the Jira site answers again.
   */
  "integration-unavailable": { status: 502, title: "Integration unavailable" },
  /** A call without a token, as OAuth answers it. */
  unauthenticated: { status: 401, title: "Authentication required", challenge: "Bearer" },
  /** A token without a scope the operation needs, as OAuth answers it. */
  "insufficient-scope": { status: 403, title: "Insufficient scope", challenge: 'Bearer error="insufficient_scope"' },
  /** An If-Match that does not match the current revision. */
  "precondition-failed": { status: 412, title: "Precondition failed" },
  /** An Idempotency-Key reused with a different body. */
  "idempotency-key-reused": { status: 422, title: "Idempotency-Key reused" },
} as const satisfies Readonly<Record<string, Row>>;

export type RefusalReason = keyof typeof REFUSAL_REASONS;

/** The mark the logger looks for on an error whose message is server text (the logger's LOGGABLE). */
const SERVER_TEXT: unique symbol = Symbol.for("tiehall.loggable");

/** Where the input fails its schema: the path to the value and what is wrong with it, never the value itself. */
export interface RefusalIssue {
  path: (string | number)[];
  message: string;
}

export interface RefusalOptions {
  /** For invalid input: each place the input fails its schema. */
  issues?: readonly RefusalIssue[];
  /** For a limit: how many seconds to wait before retrying. */
  retryAfterSeconds?: number;
}

/**
 * One of Tiehall's own refusals. Its message is server text, which says why
 * in Tiehall's own words and never quotes the caller's input, so the logger
 * keeps it.
 */
export class Refusal extends Error {
  override name = "Refusal";
  readonly reason: RefusalReason;
  readonly status: number;
  /** The problem type's URI. */
  readonly type: string;
  readonly issues: readonly RefusalIssue[];
  /** When to retry, in seconds, for the rows that say. */
  readonly retryAfterSeconds: number | undefined;
  readonly [SERVER_TEXT] = true;

  constructor(reason: RefusalReason, detail: string, options: RefusalOptions = {}) {
    super(detail);
    const row: Row = REFUSAL_REASONS[reason];
    this.reason = reason;
    this.status = row.status;
    this.type = `${PROBLEM_TYPE_BASE}${reason}`;
    this.issues = options.issues ?? [];
    if (row.retryAfter === "required" && options.retryAfterSeconds === undefined) {
      throw new TypeError(`A ${reason} refusal names when to retry, in retryAfterSeconds.`);
    }
    this.retryAfterSeconds = typeof row.retryAfter === "number" ? row.retryAfter : options.retryAfterSeconds;
  }
}

/** An RFC 9457 problem details object, with Tiehall's extensions. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  /** For invalid input: where the input fails its schema. */
  errors?: readonly RefusalIssue[];
  /** For a limit or a shutdown: how many seconds to wait before retrying, as the Retry-After header says. */
  retryAfter?: number;
}

/** A refusal as an HTTP answer: its status, its headers and its problem. */
export interface HttpProblem {
  status: number;
  headers: Record<string, string>;
  body: ProblemDetails;
}

const PROBLEM_HEADERS = { "content-type": "application/problem+json", "cache-control": "no-store" } as const;

/** The HTTP answer to a refusal, on every endpoint Tiehall serves. */
export function httpProblem(refusal: Refusal): HttpProblem {
  const row: Row = REFUSAL_REASONS[refusal.reason];
  const headers: Record<string, string> = { ...PROBLEM_HEADERS };
  if (refusal.retryAfterSeconds !== undefined) headers["retry-after"] = String(refusal.retryAfterSeconds);
  if (row.challenge !== undefined) headers["www-authenticate"] = row.challenge;
  return {
    status: refusal.status,
    headers,
    body: {
      type: refusal.type,
      title: row.title,
      status: refusal.status,
      detail: refusal.message,
      ...(refusal.issues.length > 0 ? { errors: refusal.issues } : {}),
      ...(refusal.retryAfterSeconds === undefined ? {} : { retryAfter: refusal.retryAfterSeconds }),
    },
  };
}

/** The HTTP answer to a failure that is not one of Tiehall's refusals: a 500 that says nothing about it. */
export function internalErrorProblem(): HttpProblem {
  return {
    status: 500,
    headers: { ...PROBLEM_HEADERS },
    body: { type: "about:blank", title: "Internal Server Error", status: 500, detail: "Tiehall could not complete this call." },
  };
}

/** A refusal as the MCP tools report it: a tool result with isError, whose content is the problem, naming its type. */
export interface ToolError {
  isError: true;
  content: [{ type: "text"; text: string }];
}

export function toolError(refusal: Refusal): ToolError {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(httpProblem(refusal).body) }] };
}
