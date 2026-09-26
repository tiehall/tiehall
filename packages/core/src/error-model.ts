// The error model (public-api: One error model for Tiehall's own refusals;
// design.md, Decisions this change rests on: D28 #1). When Tiehall refuses a
// call for one of its own reasons, it throws a Refusal that names the reason;
// each surface turns it into its own form of the same answer. Each reason is a
// row of the public-api spec's table, with the HTTP status that row gives.
// Task 6.4 completes the table and the forms each surface answers with.

export const REFUSAL_REASONS = {
  /** No such route, or an operation that this surface does not offer. */
  "route-not-found": { status: 404 },
  /** The input fails the operation's input schema. */
  "invalid-input": { status: 400 },
  /** The caller's role in the install, or their part in the request or record, does not allow the action. */
  forbidden: { status: 403 },
  /** A confirmation that the action needs is missing or invalid. */
  "confirmation-required": { status: 403 },
  /** A CI caller calls an operation other than contract.report, or reports for an API outside its repository. */
  "ci-caller-refused": { status: 403 },
} as const satisfies Readonly<Record<string, { status: number }>>;

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
  readonly issues: readonly RefusalIssue[];
  readonly [SERVER_TEXT] = true;

  constructor(reason: RefusalReason, detail: string, options: RefusalOptions = {}) {
    super(detail);
    this.reason = reason;
    this.status = REFUSAL_REASONS[reason].status;
    this.issues = options.issues ?? [];
  }
}
