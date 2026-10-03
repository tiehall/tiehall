import { dropUnknownVariantKeys, isProposalAnswer, overlongArrays, proposalAnswer, type Catalog, type CommandDefinition } from "@tiehall/catalog";
import { Refusal, type Provenance, type RefusalIssue } from "@tiehall/core";
import type { z } from "zod";
import { actsForUser, catalogSurfaceOf, provenanceOf, type Caller } from "./caller.ts";
import { issuesOf } from "./input-issues.ts";
import { confirmationSubjectOf, type ConfirmationSubjects } from "./confirmation-step.ts";
import type { EventWakeups } from "./event-wakeups.ts";
import type { InstallGitHub } from "./install-github.ts";
import type { JobData, JobOptions, JobType } from "./jobs.ts";
import type { SecretBox } from "./secret-box.ts";
import { assertRoleAllows, memberOf, type Member } from "./members.ts";
import { createProposal, type Commitment, type ProposalAnswer } from "./proposals.ts";
import type { RequestRow } from "./request-views.ts";
import { countTokenWrite, tokenKeyOf } from "./write-limits.ts";
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
// 2. opens the call's transaction in withOrg(), which, for a caller that acts
//    for a user, first re-checks that the user is still a member, refusing a
//    removed one with 403 before anything else about the call is judged or
//    looked up, its input included (teams-and-roles: Membership is re-checked
//    on every call; public-api: One error model for Tiehall's own refusals),
//    and, for a call made with a personal access token, that the install's
//    PAT switch is on, refusing it with 403 personal-access-tokens-off while
//    it is off (agent-access: Every token call is checked against the
//    install's current state);
//    then refuses a call made with an OAuth token or a personal access token
//    that lacks a scope the operation needs, with 403 insufficient_scope
//    naming that scope, before anything runs (agent-access: Missing and
//    insufficient tokens get standard challenges);
//    an integration event that acts for a mapped user is not refused: it acts
//    for that user only while they are a member, as read in the call's
//    transaction, and for no user otherwise, such as a person removed after
//    the event was mapped to them (agent-access: Six kinds of caller;
//    github-layer-hardening: design.md, Technical decisions: T7); a refusal
//    the surface already found in the call itself, such as a REST body that
//    is not JSON, is given next;
// 3. parses the input against the operation's input schema, refusing input
//    that fails it with 400 before anything runs, and drops keys it does not
//    know: for an input whose variants are strict, which refuse a field of
//    another variant, the keys no variant has are dropped first; an array
//    longer than its schema allows is refused before any of its elements is
//    judged, since zod judges them all before it checks the array's length,
//    and a refusal names at most the first 100 places where the input fails,
//    so the work a body within its size limit causes, and the refusal it
//    gets, stay bounded whatever it holds (public-api: Request bodies have a
//    size limit; input-bounds.ts);
// 4. lets each kind of caller run only what its kind may run: a CI caller
//    only contract.report, which it is refused before its input or the
//    call's own refusal is judged, so it gets 403 whatever it sends to any
//    other operation; a system job or an integration event only
//    internal commands, and a system action, which takes effect with no
//    proposal and no confirmation, only a system job or an integration event
//    (requests: System actions need no proposal or confirmation);
// 5. asks for the confirmation step for a `confirm` command, refusing one
//    without a valid confirmation nonce with 403: only a web session may run
//    it, and its nonce, bound to that user, that session and this command
//    with this exact input, or, for a proposal's confirmation, what the
//    proposal proposes and the request it applies to, is checked and consumed
//    in the call's transaction (agent-safety: One confirmation approves one
//    action); then it parses the values the person entered on the review
//    page, such as a secret, which are no part of the input, against their
//    schemas, refusing one that fails with 400 that names the field and never
//    the value;
// 6. runs the handler in that transaction, so its change, its events and its
//    jobs commit together or not at all, with the provenance it stamps from
//    the caller, never from the payload, whose keys for it the schema drops
//    (requests: Provenance is stamped by the server); the handler of an
//    operation flagged as a commitment turns a call that makes one into a
//    proposal instead, through propose(), for the user the call acts for,
//    from any surface and from the web UI alike (requests: Commitments become
//    proposals); execute() consults the
//    role matrix with the role the membership re-check read, refusing an
//    admin action to anyone whose role does not allow it with 403 before the
//    nonce is consumed or the handler runs (teams-and-roles: The role bounds
//    every caller acting for a user); a job or an integration event acts for
//    no admin, so it runs no admin action either;
// 7. returns only output that passes the operation's output schema, or, for a
//    call that made a commitment, the proposal schema: any other output rolls
//    the call back and is never returned.
// A call made in an operation's earlier shape, which an earlier major version
// of the API keeps serving (public-api: After graduation, breaking changes go
// to a new major version; design.md, Where the specs leave room: Two API
// versions), has its input parsed against that shape's schema in step 3, and
// refused there as any input that fails its schema is, then carried to the
// current shape, which the handler alone runs; its output, once it passes the
// current output schema, is carried back to the earlier shape and returned
// only when it passes that shape's schema. A major version in which the
// operation has no shape serves no such operation (404).
// A call made with an OAuth token or a personal access token that writes is
// counted, in its transaction and before its change, against the token's
// limit and the install's daily budget, and gets 429 beyond either
// (write-limits.ts); the write path counts it against the loop limit of the
// request it writes on (loop-limit.ts).
//
// A step before the transaction (design.md, Technical decisions: T3 and T16).
// No call to GitHub is made inside a transaction, so a slow GitHub holds no
// connection in a transaction and no lock. A handler that must ask GitHub
// before it changes anything, such as the lookup of an invite's username or
// the check of a rotated App key, gives execute() a step that runs before the
// call's transaction: execute() first authorizes the call, steps 2 to 5, in a
// short read-only transaction, checking the confirmation nonce without
// consuming it; then runs the step, outside any transaction, where it may read
// in read-only transactions of its own and call GitHub; then opens the call's
// transaction, authorizes the call again, consumes the nonce and runs the
// handler with what the step returned. The handler reads again what it
// depends on and refuses with 409 when that changed meanwhile. A step that
// fails, such as when GitHub does not answer, leaves the nonce unused, so the
// person can post the same review page again. The long-poll wait uses the same
// step to hold a call open without holding a connection or a transaction: it
// reads in short read-only transactions between wake-ups (events-wait.ts).

/** What a handler's step before the call's transaction gets besides the parsed input. */
export interface PrepareContext {
  readonly caller: Caller;
  /** The membership of the user the caller acts for, as the authorization read it; none for a caller that acts for no user. */
  readonly member: Member | undefined;
  /** The install's GitHub App, which the step may ask; undefined where the process has none. */
  readonly github: InstallGitHub | undefined;
  /** TIEHALL_SECRET_KEY's box; undefined where the process has none. */
  readonly secrets: (() => SecretBox) | undefined;
  /** The values the person entered on the review page, parsed, by field name. */
  readonly sealed: Readonly<Record<string, string>>;
  /** Reads, in a short read-only transaction of its own, as the install's org. */
  read<T>(read: (context: OrgContext) => Promise<T>): Promise<T>;
  /** The install's URL, TIEHALL_URL, as its origin; undefined where the process has none. */
  readonly url: string | undefined;
  /** How the long-poll waits hold, for a step that waits; undefined where the process sets none. */
  readonly waits: WaitSettings | undefined;
}

/**
 * How the long-poll waits hold (requester-loop: The long-poll wait endpoint):
 * what wakes them when an event commits, how long they hold, 60 seconds
 * unless a test shortens it, and the signal that ends them when the app shuts
 * down, the process's own unless a test gives another.
 */
export interface WaitSettings {
  wakeups?: EventWakeups;
  holdMs?: number;
  shutdown?: AbortSignal;
}

/** A handler's step before the call's transaction, such as a call to GitHub; what it returns is the handler's `prepared`. */
export type Prepare = (input: unknown, context: PrepareContext) => Promise<unknown>;

/** What a handler gets besides its parsed input. */
export interface HandlerContext extends OrgContext {
  readonly caller: Caller;
  /** The membership of the user the caller acts for, as this call read it; none for a caller that acts for no user. */
  readonly member: Member | undefined;
  /** Who causes what this call changes, stamped from the caller alone, never from the payload. */
  readonly provenance: Provenance;
  /** The clock of this call, which the limits on agent writes count by. */
  now(): Date;
  /**
   * The install's GitHub App, for the few operations that must ask GitHub
   * before they change anything, such as resolving an invite's username;
   * undefined where the process has none.
   */
  readonly github: InstallGitHub | undefined;
  /**
   * TIEHALL_SECRET_KEY's box, which encrypts the integration secrets an
   * operation stores; undefined where the process has none.
   */
  readonly secrets: (() => SecretBox) | undefined;
  /** The values the person entered on the review page, parsed, by field name; empty for a command that takes none. */
  readonly sealed: Readonly<Record<string, string>>;
  /** The install's URL, TIEHALL_URL, as its origin, such as whoami names; undefined where the process has none. */
  readonly url: string | undefined;
  /** What the handler's step before the transaction returned; undefined for a handler without one. */
  readonly prepared: unknown;
  /**
   * Runs a change in the call's transaction, with the event that records it
   * and the caller's provenance, to which the handler adds the team the user
   * acted for, which it decides from the record, never from the payload.
   */
  write<R>(change: (writer: Writer) => Promise<R>, options?: { teamId?: string | undefined }): Promise<R>;
  /**
   * Starts a job that commits with the call's transaction, for a call whose
   * change records no event, such as a contract report it stores: the job
   * runs only once the call has committed, and never for a call rolled back.
   */
  enqueue<D extends JobData>(type: JobType<D>, data: D, options?: JobOptions): Promise<void>;
  /**
   * Runs again, in the call's transaction, the job of a type whose jobs run
   * one key at a time, such as a request's mirror job, that used up its
   * attempts and moved to the dead-letter queue: it gets one more attempt,
   * once the call has committed. False when the key has no such job, as when
   * it runs again already, or the process sends jobs to no queue.
   */
  retryFailed<D extends JobData>(type: JobType<D>, key: string): Promise<boolean>;
  /**
   * Creates the proposal for a commitment the call makes on a request whose
   * row it has locked, instead of applying it; only an operation flagged as a
   * commitment may. The handler answers with what it returns.
   */
  propose(request: RequestRow, commitment: Commitment): Promise<ProposalAnswer>;
}

/** The provenance of a change made for a team the user acted for. */
export function actingFor(provenance: Provenance, teamId: string | undefined): Provenance {
  return teamId === undefined || provenance.actorKind === "operator" ? provenance : { ...provenance, teamId };
}

/** Runs one operation: it gets the parsed input and returns the output its schema describes; it may have a step before the call's transaction. */
export type Handler = ((input: unknown, context: HandlerContext) => Promise<unknown>) & { readonly prepare?: Prepare };

/** One handler per operation of the catalog, by the operation's id. */
export type Handlers = Readonly<Record<string, Handler>>;

/**
 * A handler typed by its definition's schemas. A commitment's handler may
 * answer with the proposal propose() created instead of the output; execute()
 * takes that answer from an operation flagged as a commitment only.
 */
export function defineHandler<D extends CommandDefinition>(
  _definition: D,
  handler: (input: z.output<D["input"]>, context: HandlerContext) => Promise<z.input<D["output"]> | ProposalAnswer>,
): Handler {
  return handler as Handler;
}

/**
 * A handler that must ask GitHub before it changes anything: its step,
 * `prepare`, runs outside any transaction, before the call's transaction and
 * the use of its confirmation nonce, and what it returns is the handler's
 * `prepared` (execute(): A step before the transaction).
 */
export function definePreparedHandler<D extends CommandDefinition, P>(
  _definition: D,
  prepare: (input: z.output<D["input"]>, context: PrepareContext) => Promise<P>,
  handler: (input: z.output<D["input"]>, context: HandlerContext & { readonly prepared: P }) => Promise<z.input<D["output"]> | ProposalAnswer>,
): Handler {
  return Object.assign((input: unknown, context: HandlerContext) => handler(input as z.output<D["input"]>, context as HandlerContext & { readonly prepared: P }), {
    prepare: prepare as Prepare,
  });
}

/** The confirmation step's check of a nonce (confirmations.ts). */
export interface Confirmations {
  /** Checks and consumes the nonce, inside the call's transaction; false when it is not valid for this exact action. */
  consume(context: OrgContext, claim: ConfirmationClaim): Promise<boolean>;
  /** Checks the nonce without consuming it, before a handler's step outside the transaction; false when it is not valid now. */
  check?(context: OrgContext, claim: ConfirmationClaim): Promise<boolean>;
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
  /** What each command's confirmation nonce is bound to, where it is not the command's input. */
  subjects?: ConfirmationSubjects;
  /** The clock the limits on agent writes are counted by; the system clock unless a test controls it. */
  now?: () => Date;
  /** The install's GitHub App, which the operations that ask GitHub call it as. */
  github?: InstallGitHub;
  /** TIEHALL_SECRET_KEY's box, which the operations that store an integration secret encrypt it with. */
  secrets?: () => SecretBox;
  /** The install's URL, TIEHALL_URL, as its origin, which the operations that name the install, such as whoami, give. */
  url?: string;
  /** How the long-poll waits hold. */
  waits?: WaitSettings;
}

export interface ExecuteOptions {
  /** The confirmation step's nonce, which a `confirm` command needs. */
  confirmation?: { nonce: string };
  /**
   * The values the person entered on the review page of a `confirm` command
   * that takes some, such as a secret, by field name: sent only in the body
   * of the POST that applies the action, never in its input.
   */
  sealed?: Readonly<Record<string, string>>;
  /** Where the call came from, kept for the security events it appends. */
  origin?: Origin;
  /**
   * Runs around the handler and its output check, in the call's transaction,
   * such as the REST route's Idempotency-Key, which claims its key there.
   */
  around?: (context: OrgContext, run: () => Promise<unknown>) => Promise<unknown>;
  /** Runs the call in a read-only transaction, in which any write fails, as a web page's read does. */
  readOnly?: boolean;
  /**
   * Told the id of the proposal the call created through propose(), such as
   * the MCP route, which elicits a confirmation only for a proposal its call
   * created, and never for one the call answers with after ending it.
   */
  proposed?: (proposalId: string) => void;
  /**
   * A refusal the surface found in the call itself before execute() ran, such
   * as a REST body that is not JSON: it is given after the membership
   * re-check, so a removed member's call gets 403 whatever it sends.
   */
  refusal?: Refusal;
  /**
   * The earlier major version of the API whose shape of the operation the
   * call was made in, such as 1 for a call to /api/v1 after a breaking change
   * moved the operation to /api/v2; the operation's current shape unless given.
   */
  major?: number;
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
  const now = services.now ?? (() => new Date());
  const missing = catalog.commands.filter(({ id }) => typeof handlers[id] !== "function").map(({ id }) => `${id} has no handler.`);
  const extra = Object.keys(handlers)
    .filter((id) => catalog.get(id) === undefined)
    .map((id) => `${id} is a handler for an operation the catalog does not hold.`);
  if (missing.length > 0 || extra.length > 0) throw new Error([...missing, ...extra].join("\n"));

  return async function execute(commandId, caller, input, options = {}) {
    const definition = catalog.get(commandId);
    const handler = handlers[commandId];
    if (definition === undefined || handler === undefined) throw notOffered();
    // The earlier shape the call was made in, if any.
    const earlier = options.major === undefined ? undefined : definition.earlier?.find(({ major }) => major === options.major);
    if (options.major !== undefined && earlier === undefined) throw notOffered();

    // 1. A token or CI call reaches only what the surface it came through offers.
    const surface = catalogSurfaceOf(caller);
    if (surface !== undefined && !definition.surfaces.includes(surface)) throw notOffered();

    // 2. withOrg() has refused a removed member already; then what the surface found wrong with the call.
    const writeOptions = { ...(options.origin === undefined ? {} : { origin: options.origin }), now };
    const forUser = actsForUser(caller) ? caller.userId : undefined;
    // A personal access token's call goes on only while the PAT switch is on, read at the time of the call.
    const personalAccessToken = caller.kind === "personal_access_token";
    // An access token issued before the user's current membership began was revoked by a removal.
    const issuedAt = caller.kind === "oauth_token" ? caller.issuedAt : undefined;

    /**
     * Steps 2 to 5 in the given transaction: the call's own refusal, the
     * input, what the caller's kind and role may run, and the confirmation
     * nonce, checked, or consumed in the call's transaction; returns the
     * parsed input, the membership and the values entered on the review page.
     */
    const authorize = async (context: OrgContext, nonce: "check" | "consume") => {
      // A token acts only within its scopes: a call that needs a scope the token lacks is refused first (15.4).
      if (caller.kind === "oauth_token" || caller.kind === "personal_access_token") {
        const missing = definition.scopes.filter((scope) => !caller.scopes.includes(scope));
        if (missing.length > 0) {
          throw new Refusal("insufficient-scope", `This operation needs the scope ${missing.join(" and ")}, which this token does not carry.`, {
            challenge: { scope: missing },
          });
        }
      }
      // A CI caller may call contract.report alone, whatever it sends (step 4).
      if (caller.kind === "ci" && commandId !== "contract.report") {
        throw new Refusal("ci-caller-refused", "A CI caller may only report contract changes.");
      }
      if (options.refusal !== undefined) throw options.refusal;

      // 3. Nothing runs on input that fails the schema: an earlier shape's, then, carried to it, the current one's.
      const schema = earlier?.input ?? definition.input;
      const known = dropUnknownVariantKeys(schema, input);
      // An array longer than its schema allows is refused before zod judges each of its elements.
      const overlong = overlongArrays(schema, known);
      if (overlong.length > 0) {
        throw new Refusal("invalid-input", `The input of ${commandId} does not match its schema.`, { issues: overlong });
      }
      let parsed = schema.safeParse(known);
      if (!parsed.success) {
        throw new Refusal("invalid-input", `The input of ${commandId} does not match its schema.`, { issues: issuesOf(parsed.error) });
      }
      if (earlier !== undefined) {
        parsed = definition.input.safeParse(earlier.toCurrent(parsed.data as never));
        if (!parsed.success) throw new Error(`The input of ${commandId}'s shape for /api/v${earlier.major} does not carry to its current shape.`);
      }

      // 4. What each kind of caller may run; a CI caller was refused any other operation than contract.report already.
      const worker = caller.kind === "system_job" || caller.kind === "integration_event";
      if (worker && definition.surfaces.length > 0) {
        throw new Refusal("forbidden", "Only internal commands run for a system job or an integration event.");
      }
      // A system action takes effect with no proposal or confirmation, so only Tiehall's own jobs and verified events run it.
      if (definition.system === true && !worker) {
        throw new Refusal("forbidden", "Only Tiehall's own jobs and verified integration events run a system action.");
      }

      // 5. The confirmation step, for a user signed in to the web UI only.
      const confirmation = options.confirmation;
      const confirmations = services.confirmations;
      if (definition.confirm && (caller.kind !== "web_session" || confirmation === undefined || confirmations === undefined)) {
        throw new Refusal("confirmation-required", "This action needs a confirmation in the web UI.");
      }

      // An admin action runs only for an admin: never for a job or an integration event, which act for no admin.
      const member = context.member;
      assertRoleAllows(definition, member);
      if (definition.confirm && caller.kind === "web_session" && confirmation !== undefined && confirmations !== undefined) {
        const subject = await confirmationSubjectOf(services.subjects, commandId, parsed.data, context);
        const claim = { nonce: confirmation.nonce, userId: caller.userId, sessionId: caller.sessionId, commandId, input: subject };
        const valid = nonce === "consume" ? await confirmations.consume(context, claim) : await (confirmations.check?.(context, claim) ?? true);
        if (!valid) throw new Refusal("confirmation-required", "This action needs a confirmation in the web UI.");
      }
      // The values entered on the review page, which no URL carries; a refusal names the field, never the value.
      const sealed: Record<string, string> = {};
      const sealedIssues: RefusalIssue[] = [];
      for (const field of definition.sealed ?? []) {
        const entered = field.schema.safeParse(options.sealed?.[field.name]);
        if (entered.success) sealed[field.name] = entered.data;
        else sealedIssues.push(...entered.error.issues.map((issue) => ({ path: [field.name], message: issue.message })));
      }
      if (sealedIssues.length > 0) {
        throw new Refusal("invalid-input", `A value entered for ${commandId} does not match its schema.`, { issues: sealedIssues });
      }
      return { input: parsed.data as unknown, member, sealed };
    };

    // The handler's step before the transaction, once the call is authorized, with its nonce checked and not yet used.
    let prepared: unknown;
    if (handler.prepare !== undefined) {
      const authorized = await withOrg(
        store.database,
        async (context) => ({ ...(await authorize(context, "check")), caller: await asMemberOrNoUser(context, caller) }),
        { readOnly: true, forUser, personalAccessToken, issuedAt },
      );
      prepared = await handler.prepare(authorized.input, {
        caller: authorized.caller,
        member: authorized.member,
        github: services.github,
        secrets: services.secrets,
        sealed: authorized.sealed,
        read: (read) => withOrg(store.database, read, { readOnly: true }),
        url: services.url,
        waits: services.waits,
      });
    }

    return withOrg(
      store.database,
      async (context) => {
        const { input: parsedInput, member, sealed } = await authorize(context, "consume");
        // Who the call acts for, as this transaction reads the membership, and the provenance stamped from it alone.
        const acting = await asMemberOrNoUser(context, caller);
        const provenance = provenanceOf(acting);

        // 6. and 7. The handler, in the install's org, and only output that passes its schema.
        // An agent token's call that writes is counted once, before its change, against the token's limit and the install's budget.
        const token = tokenKeyOf(caller);
        let counted = false;
        const handlerContext: HandlerContext = {
          ...context,
          caller: acting,
          member,
          provenance,
          now,
          github: services.github,
          secrets: services.secrets,
          sealed,
          url: services.url,
          prepared,
          write: (change, { teamId } = {}) =>
            writeIn(
              context,
              store.jobs,
              actingFor(provenance, teamId),
              async (writer) => {
                if (token !== undefined && !counted) {
                  counted = true;
                  await countTokenWrite(writer, token, now());
                }
                return change(writer);
              },
              writeOptions,
            ),
          enqueue: (type, data, jobOptions) => store.jobs.send(context.tx, type.queue, data, jobOptions),
          retryFailed: async (type, key) => (store.jobs.retryFailed === undefined ? false : store.jobs.retryFailed(context.tx, type.queue, key)),
          propose: async (request, commitment) => {
            if (!definition.commitment) throw new Error(`${commandId} is not flagged as a commitment, so it creates no proposal.`);
            const answer = await createProposal(handlerContext, request, commitment);
            options.proposed?.(answer.proposal.id);
            return answer;
          },
        };
        const run = async () => {
          const result = await handler(parsedInput, handlerContext);
          // A commitment's call that made one answers with its proposal instead of the operation's output.
          const proposed = definition.commitment && isProposalAnswer(result);
          const output = (proposed ? proposalAnswer : definition.output).safeParse(result);
          if (!output.success) throw new OutputSchemaError(commandId);
          if (earlier === undefined || proposed) return output.data;
          // The current output, carried back to the earlier shape the call was made in.
          const answer = earlier.output.safeParse(earlier.fromCurrent(output.data as never));
          if (!answer.success) throw new OutputSchemaError(commandId);
          return answer.data;
        };
        return options.around === undefined ? run() : options.around(context, run);
      },
      { readOnly: options.readOnly === true, forUser, personalAccessToken, issuedAt },
    );
  };
}

/**
 * The caller a call runs as, in the given transaction: an integration event
 * acts for its mapped user only while that user is a member of the install,
 * and for no user otherwise, rather than being refused, so the change it
 * brings is not lost (agent-access: Six kinds of caller;
 * github-layer-hardening: design.md, Technical decisions: T7). Every other
 * caller is as it came; withOrg() re-checks the membership of one that acts
 * for a user.
 */
async function asMemberOrNoUser(context: OrgContext, caller: Caller): Promise<Caller> {
  if (caller.kind !== "integration_event" || caller.userId === undefined) return caller;
  if ((await memberOf(context, caller.userId)) !== undefined) return caller;
  return { kind: caller.kind, source: caller.source };
}

