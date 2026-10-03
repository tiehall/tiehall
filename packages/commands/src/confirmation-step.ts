import type { Catalog, SealedField } from "@tiehall/catalog";
import { Refusal, type Review } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { ConfirmationNonces } from "./confirmations.ts";
import { issuesOf } from "./input-issues.ts";
import type { InstallGitHub } from "./install-github.ts";
import { assertRoleAllows, type Member } from "./members.ts";
import { withOrg, type OrgContext } from "./with-org.ts";
import type { Store } from "./write.ts";

// The confirmation step's review (agent-safety: The review page of the
// confirmation step; design.md, Self-hosting decisions: S7). Every command
// that needs the confirmation step has a review: a function that says, in
// Tiehall's own words, exactly what the command will do with this input, and
// quotes any text Tiehall did not write, such as another team's, with its
// origin. A review page shows it before the person confirms. A review:
// - exists only for a command that needs the confirmation step; any other
//   command, and an unknown one, has no review page (404);
// - is only for a user signed in to the web UI;
// - runs inside withOrg() in a read-only transaction, so a review can read
//   what it needs and can never change anything, and only for a user who is
//   still a member (403 removed-member otherwise, before anything else about
//   the page is judged, its input included);
// - then parses the input against the command's schema, refusing input that
//   is not JSON or fails the schema with 400, so the page reviews the input
//   the command will get, and runs only for a user whose role allows the
//   action (403 for a member on an admin action's page);
// - comes with the confirmation nonce for the page, bound to the user, the
//   session and the command with that exact input, or, for a proposal's
//   confirmation, what the proposal proposes and the request it applies to,
//   which stores nothing (agent-safety: One confirmation approves one action).
//
// A step before the review's transaction (github-layer-hardening: design.md,
// Technical decisions: T6). No call to GitHub is made inside a transaction,
// so a review that must ask GitHub, such as the invite's, which reads the
// account it names by its id, gives the review a step, as definePreparedHandler
// gives execution one (execute.ts): the review first authorizes the page, the
// membership re-check, the input and the role, in a short read-only
// transaction; then runs the step, outside any transaction, where it may read
// in read-only transactions of its own and call GitHub; then reviews in its
// read-only transaction with what the step returned. A step that fails, such
// as when GitHub does not answer, refuses the page.

/** What a review reads with: the call's read-only transaction, the install's org and the signed-in user. */
export interface ReviewContext extends OrgContext {
  readonly caller: WebSessionCaller;
  /** What the review's step before its transaction returned; undefined for a review without one. */
  readonly prepared: unknown;
}

/** What a review's step before its transaction gets besides the parsed input. */
export interface ReviewPrepareContext {
  readonly caller: WebSessionCaller;
  /** The membership the authorization read. */
  readonly member: Member | undefined;
  /** The install's GitHub App, which the step may ask; undefined where the process has none. */
  readonly github: InstallGitHub | undefined;
  /** Reads, in a short read-only transaction of its own, as the install's org. */
  read<T>(read: (context: OrgContext) => Promise<T>): Promise<T>;
}

/** Says what a command that needs the confirmation step will do with this parsed input; it may have a step before its transaction. */
export type ReviewHandler = ((input: unknown, context: ReviewContext) => Promise<Review>) & {
  readonly prepare?: (input: unknown, context: ReviewPrepareContext) => Promise<unknown>;
};

/**
 * A review that must ask GitHub before it can say what the action will do:
 * its step, `prepare`, runs outside any transaction, before the review's
 * read-only transaction, and what it returns is the review's `prepared`.
 */
export function definePreparedReview<P>(
  prepare: (input: unknown, context: ReviewPrepareContext) => Promise<P>,
  review: (input: unknown, context: ReviewContext & { readonly prepared: P }) => Promise<Review>,
): ReviewHandler {
  return Object.assign((input: unknown, context: ReviewContext) => review(input, context as ReviewContext & { readonly prepared: P }), {
    prepare: prepare as (input: unknown, context: ReviewPrepareContext) => Promise<unknown>,
  });
}

/** One review per command of the catalog that needs the confirmation step, by the command's id. */
export type Reviews = Readonly<Record<string, ReviewHandler>>;

/**
 * What a command's confirmation nonce is bound to, when it is not the
 * command's input: a function of the parsed input, read in the call's
 * transaction. A proposal's confirm page binds its nonce to what the proposal
 * proposes and the request it applies to (design.md, Technical decisions: T3).
 */
export type ConfirmationSubjects = Readonly<Record<string, (input: unknown, context: OrgContext) => Promise<unknown>>>;

/** What a command's nonce is bound to: its subject, or its parsed input for a command with none. */
export async function confirmationSubjectOf(
  subjects: ConfirmationSubjects | undefined,
  commandId: string,
  input: unknown,
  context: OrgContext,
): Promise<unknown> {
  const subject = subjects?.[commandId];
  return subject === undefined ? input : subject(input, context);
}

/** An action ready for its review page: the command, its parsed input, what it will do and the page's nonce. */
export interface ReviewedAction {
  commandId: string;
  /** The input as the command's schema parsed it, which the page's form sends back. */
  input: unknown;
  review: Review;
  /** The confirmation nonce the page's form sends, valid for this action only. */
  nonce: string;
}

export interface ConfirmationStepServices {
  catalog: Catalog;
  reviews: Reviews;
  /** What each command's nonce is bound to, where it is not the command's input. */
  subjects?: ConfirmationSubjects;
  store: Pick<Store, "database">;
  confirmations: ConfirmationNonces;
  /** The install's GitHub App, which a review's step before its transaction may ask. */
  github?: InstallGitHub;
}

export interface ConfirmationStep {
  /**
   * The review of an action, for its review page; it changes nothing. A
   * refusal the page found in the input it was sent, such as input that is
   * not JSON, is given after the membership re-check.
   */
  review(commandId: string, caller: WebSessionCaller, input: unknown, refusal?: Refusal): Promise<ReviewedAction>;
  /** Whether a command needs the confirmation step, and so has a review page to be confirmed from. */
  needsConfirmation(commandId: string): boolean;
  /** The values a command's review page asks the person to enter in its form, such as a secret; none for most. */
  sealedFields(commandId: string): readonly SealedField[];
}

/** A command with no review page: an unknown one, or one that needs no confirmation step. */
function noReviewPage(): Refusal {
  return new Refusal("route-not-found", "There is no review page for this action.");
}

export function createConfirmationStep(services: ConfirmationStepServices): ConfirmationStep {
  const { catalog, reviews } = services;
  const confirmIds = catalog.commands.filter(({ confirm }) => confirm).map(({ id }) => id);
  const missing = confirmIds.filter((id) => typeof reviews[id] !== "function").map((id) => `${id} needs the confirmation step and has no review.`);
  const extra = Object.keys(reviews)
    .filter((id) => !confirmIds.includes(id))
    .map((id) => `${id} has a review but is not a command of the catalog that needs the confirmation step.`);
  if (missing.length > 0 || extra.length > 0) throw new Error([...missing, ...extra].join("\n"));

  return {
    needsConfirmation: (commandId) => confirmIds.includes(commandId),
    sealedFields: (commandId) => (confirmIds.includes(commandId) ? (catalog.get(commandId)?.sealed ?? []) : []),
    async review(commandId, caller, input, refusal) {
      const definition = catalog.get(commandId);
      const handler = reviews[commandId];
      if (definition === undefined || !definition.confirm || handler === undefined) throw noReviewPage();
      if (caller.kind !== "web_session") throw noReviewPage();
      /** The page's own refusal, the input and the role, in the given transaction; returns the parsed input. */
      const authorize = (context: OrgContext): unknown => {
        if (refusal !== undefined) throw refusal;
        const parsed = definition.input.safeParse(input);
        if (!parsed.success) {
          throw new Refusal("invalid-input", `The input of ${commandId} does not match its schema.`, { issues: issuesOf(parsed.error) });
        }
        assertRoleAllows(definition, context.member);
        return parsed.data as unknown;
      };
      // The review's step before its transaction, once the page is authorized.
      let prepared: unknown;
      if (handler.prepare !== undefined) {
        const authorized = await withOrg(services.store.database, async (context) => ({ input: authorize(context), member: context.member }), {
          readOnly: true,
          forUser: caller.userId,
        });
        prepared = await handler.prepare(authorized.input, {
          caller,
          member: authorized.member,
          github: services.github,
          read: (read) => withOrg(services.store.database, read, { readOnly: true }),
        });
      }
      const reviewed = await withOrg(
        services.store.database,
        async (context) => {
          const parsed = authorize(context);
          const subject = await confirmationSubjectOf(services.subjects, commandId, parsed, context);
          return { input: parsed, subject, review: await handler(parsed, { ...context, caller, prepared }) };
        },
        { readOnly: true, forUser: caller.userId },
      );
      return {
        commandId,
        input: reviewed.input,
        review: reviewed.review,
        nonce: services.confirmations.issue(caller, commandId, reviewed.subject),
      };
    },
  };
}

