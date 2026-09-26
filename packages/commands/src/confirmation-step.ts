import type { Catalog } from "@tiehall/catalog";
import { Refusal, type RefusalIssue, type Review } from "@tiehall/core";
import type { z } from "zod";
import type { WebSessionCaller } from "./caller.ts";
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
// - parses the input against the command's schema first, refusing input that
//   fails it with 400, so the page reviews the input the command will get;
// - runs inside withOrg() in a read-only transaction, so a review can read
//   what it needs and can never change anything.

/** What a review reads with: the call's read-only transaction, the install's org and the signed-in user. */
export interface ReviewContext extends OrgContext {
  readonly caller: WebSessionCaller;
}

/** Says what a command that needs the confirmation step will do with this parsed input. */
export type ReviewHandler = (input: unknown, context: ReviewContext) => Promise<Review>;

/** One review per command of the catalog that needs the confirmation step, by the command's id. */
export type Reviews = Readonly<Record<string, ReviewHandler>>;

/** An action ready for its review page: the command, its parsed input and what it will do. */
export interface ReviewedAction {
  commandId: string;
  /** The input as the command's schema parsed it, which the page's form sends back. */
  input: unknown;
  review: Review;
}

export interface ConfirmationStepServices {
  catalog: Catalog;
  reviews: Reviews;
  store: Pick<Store, "database">;
}

export interface ConfirmationStep {
  /** The review of an action, for its review page; it changes nothing. */
  review(commandId: string, caller: WebSessionCaller, input: unknown): Promise<ReviewedAction>;
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
    async review(commandId, caller, input) {
      const definition = catalog.get(commandId);
      const handler = reviews[commandId];
      if (definition === undefined || !definition.confirm || handler === undefined) throw noReviewPage();
      if (caller.kind !== "web_session") throw noReviewPage();
      const parsed = definition.input.safeParse(input);
      if (!parsed.success) {
        throw new Refusal("invalid-input", `The input of ${commandId} does not match its schema.`, { issues: issuesOf(parsed.error) });
      }
      const review = await withOrg(services.store.database, (context) => handler(parsed.data, { ...context, caller }), { readOnly: true });
      return { commandId, input: parsed.data, review };
    },
  };
}

/** Where the input fails its schema, by path and by the schema's own message, never with the value. */
function issuesOf(error: z.ZodError): RefusalIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
    message: issue.message,
  }));
}
