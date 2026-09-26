import type { Catalog, CommandDefinition } from "@tiehall/catalog";
import { Refusal, type Provenance, type RefusalIssue } from "@tiehall/core";
import type { z } from "zod";
import { actsForUser, catalogSurfaceOf, provenanceOf, type Caller } from "./caller.ts";
import { assertRoleAllows, type Member } from "./members.ts";
import { withOrg, type OrgContext } from "./with-org.ts";
import { writeIn, type Origin, type Store, type Writer } from "./write.ts";

// execute(commandId, caller, input) (public-api: One definition per operation,
// the same on every surface; public-api: Input and output follow the published
// schemas; agent-access: Six kinds of caller; agent-safety: The confirmation
// step runs only in the web UI; design.md, Technical decisions: T3). Every
// operation runs through it, whichever surface starts it: REST, MCP, the CLI
// through REST, a negotiated URL, the web UI or the worker. In order, it:
// 1. refuses, as a path that is not there (404), an operation that the
//    surface the call came through does not offer, which is every internal
//    command for a token or CI caller;
// 2. parses the input against the operation's input schema, refusing input
//    that fails it with 400 before anything runs, and drops keys it does not
//    know;
// 3. lets each kind of caller run only what its kind may run: a CI caller
//    only contract.report, and a system job or an integration event only
//    internal commands;
// 4. asks for the confirmation step for a `confirm` command, refusing one
//    without a valid confirmation nonce with 403: only a web session may run
//    it, and its nonce, bound to that user, that session and this command
//    with this exact input, is checked and consumed in the call's transaction
//    (agent-safety: One confirmation approves one action);
// 5. runs the handler inside withOrg(), so its change, its events and its jobs
//    commit together or not at all, with the provenance it stamps from the
//    caller, never from the payload, whose keys for it the schema drops
//    (requests: Provenance is stamped by the server); for a caller that acts
//    for a user, withOrg() first re-checks that the user is still a member, refusing a
//    removed one with 403 before anything is looked up (teams-and-roles:
//    Membership is re-checked on every call), and execute() consults the
//    role matrix with the role that re-check read, refusing an admin action
//    to anyone whose role does not allow it with 403 before the nonce is
//    consumed or the handler runs (teams-and-roles: The role bounds every
//    caller acting for a user); a job or an integration event acts for no
//    admin, so it runs no admin action either;
// 6. returns only output that passes the operation's output schema: any
//    other output rolls the call back and is never returned.
// Later tasks add the token's side of the rules (15.5) and commitments that
// become proposals (14.4).

/** What a handler gets besides its parsed input. */
export interface HandlerContext extends OrgContext {
  readonly caller: Caller;
  /** The membership of the user the caller acts for, as this call read it; none for a caller that acts for no user. */
  readonly member: Member | undefined;
  /** Who causes what this call changes, stamped from the caller alone, never from the payload. */
  readonly provenance: Provenance;
  /**
   * Runs a change in the call's transaction, with the event that records it
   * and the caller's provenance, to which the handler adds the team the user
   * acted for, which it decides from the record, never from the payload.
   */
  write<R>(change: (writer: Writer) => Promise<R>, options?: { teamId?: string | undefined }): Promise<R>;
}

/** The provenance of a change made for a team the user acted for. */
export function actingFor(provenance: Provenance, teamId: string | undefined): Provenance {
  return teamId === undefined || provenance.actorKind === "operator" ? provenance : { ...provenance, teamId };
}

/** Runs one operation: it gets the parsed input and returns the output its schema describes. */
export type Handler = (input: unknown, context: HandlerContext) => Promise<unknown>;

/** One handler per operation of the catalog, by the operation's id. */
export type Handlers = Readonly<Record<string, Handler>>;

/** A handler typed by its definition's schemas. */
export function defineHandler<D extends CommandDefinition>(
  _definition: D,
  handler: (input: z.output<D["input"]>, context: HandlerContext) => Promise<z.input<D["output"]>>,
): Handler {
  return handler as Handler;
}

/** The confirmation step's check of a nonce (confirmations.ts). */
export interface Confirmations {
  /** Checks and consumes the nonce, inside the call's transaction; false when it is not valid for this exact action. */
  consume(context: OrgContext, claim: ConfirmationClaim): Promise<boolean>;
}

export interface ConfirmationClaim {
  nonce: string;
  userId: string;
  sessionId: string;
  commandId: string;
  /** The parsed input, whose digest the nonce is bound to. */
  input: unknown;
}

export interface ExecuteServices {
  catalog: Catalog;
  handlers: Handlers;
  store: Store;
  confirmations?: Confirmations;
}

export interface ExecuteOptions {
  /** The confirmation step's nonce, which a `confirm` command needs. */
  confirmation?: { nonce: string };
  /** Where the call came from, kept for the security events it appends. */
  origin?: Origin;
  /**
   * Runs around the handler and its output check, in the call's transaction,
   * such as the REST route's Idempotency-Key, which claims its key there.
   */
  around?: (context: OrgContext, run: () => Promise<unknown>) => Promise<unknown>;
  /** Runs the call in a read-only transaction, in which any write fails, as a web page's read does. */
  readOnly?: boolean;
}

export type Execute = (commandId: string, caller: Caller, input: unknown, options?: ExecuteOptions) => Promise<unknown>;

/**
 * A handler's output that fails its operation's output schema. It is a bug in
 * Tiehall, not a refusal: the call is rolled back and the output is never
 * returned. Its message names the operation and never the output.
 */
export class OutputSchemaError extends Error {
  override name = "OutputSchemaError";
  constructor(commandId: string) {
    super(`The output of ${commandId} fails its schema, so it was not returned and the call was rolled back.`);
  }
}

/** Refused as the error model's row for a path that serves no operation on the surface. */
function notOffered(): Refusal {
  return new Refusal("route-not-found", "There is no such operation here.");
}

export function createExecute(services: ExecuteServices): Execute {
  const { catalog, handlers, store } = services;
  const missing = catalog.commands.filter(({ id }) => typeof handlers[id] !== "function").map(({ id }) => `${id} has no handler.`);
  const extra = Object.keys(handlers)
    .filter((id) => catalog.get(id) === undefined)
    .map((id) => `${id} is a handler for an operation the catalog does not hold.`);
  if (missing.length > 0 || extra.length > 0) throw new Error([...missing, ...extra].join("\n"));

  return async function execute(commandId, caller, input, options = {}) {
    const definition = catalog.get(commandId);
    const handler = handlers[commandId];
    if (definition === undefined || handler === undefined) throw notOffered();

    // 1. A token or CI call reaches only what the surface it came through offers.
    const surface = catalogSurfaceOf(caller);
    if (surface !== undefined && !definition.surfaces.includes(surface)) throw notOffered();

    // 2. Nothing runs on input that fails the schema.
    const parsed = definition.input.safeParse(input);
    if (!parsed.success) {
      throw new Refusal("invalid-input", `The input of ${commandId} does not match its schema.`, { issues: issuesOf(parsed.error) });
    }

    // 3. What each kind of caller may run.
    if (caller.kind === "ci" && commandId !== "contract.report") {
      throw new Refusal("ci-caller-refused", "A CI caller may only report contract changes.");
    }
    if ((caller.kind === "system_job" || caller.kind === "integration_event") && definition.surfaces.length > 0) {
      throw new Refusal("forbidden", "Only internal commands run for a system job or an integration event.");
    }

    // 4. The confirmation step, for a user signed in to the web UI only.
    const confirmation = options.confirmation;
    const confirmations = services.confirmations;
    if (definition.confirm && (caller.kind !== "web_session" || confirmation === undefined || confirmations === undefined)) {
      throw new Refusal("confirmation-required", "This action needs a confirmation in the web UI.");
    }

    if (definition.commitment) {
      throw new Error(`${commandId} is a commitment, which becomes a proposal; proposals are not built yet.`);
    }

    // 5. and 6. The handler, in the install's org, and only output that passes its schema.
    const provenance = provenanceOf(caller);
    const writeOptions = options.origin === undefined ? {} : { origin: options.origin };
    return withOrg(
      store.database,
      async (context) => {
        // An admin action runs only for an admin: never for a job or an integration event, which act for no admin.
        const member = context.member;
        assertRoleAllows(definition, member);
        if (definition.confirm && caller.kind === "web_session" && confirmation !== undefined && confirmations !== undefined) {
          const claim = { nonce: confirmation.nonce, userId: caller.userId, sessionId: caller.sessionId, commandId, input: parsed.data };
          if (!(await confirmations.consume(context, claim))) {
            throw new Refusal("confirmation-required", "This action needs a confirmation in the web UI.");
          }
        }
        const handlerContext: HandlerContext = {
          ...context,
          caller,
          member,
          provenance,
          write: (change, { teamId } = {}) => writeIn(context, store.jobs, actingFor(provenance, teamId), change, writeOptions),
        };
        const run = async () => {
          const output = definition.output.safeParse(await handler(parsed.data, handlerContext));
          if (!output.success) throw new OutputSchemaError(commandId);
          return output.data;
        };
        return options.around === undefined ? run() : options.around(context, run);
      },
      { readOnly: options.readOnly === true, forUser: actsForUser(caller) ? caller.userId : undefined },
    );
  };
}

/** Where the input fails its schema, by path and by the schema's own message, never with the value. */
function issuesOf(error: z.ZodError): RefusalIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
    message: issue.message,
  }));
}
