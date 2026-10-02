import type { AdminAction } from "@tiehall/core";
import type { z } from "zod";

// One definition per operation (public-api: One definition per operation, the
// same on every surface; design.md, Technical decisions: T3). A definition is
// the one source that REST, MCP, the CLI, the OpenAPI document and the web UI
// all take an operation from: its id, which is also its OpenAPI operationId;
// zod schemas for its input and output; its method and path on REST; the
// scopes a token needs to run it; two flags, `commitment` (it becomes a
// proposal a person confirms) and `confirm` (it needs the confirmation step in
// the web UI); the admin action it is, for an operation only admins may run;
// the surfaces that offer it; and its stability level, with its deprecation
// dates once it is deprecated.

/** The three OAuth scopes (agent-access: OAuth scopes are coarse). There is no admin scope. */
export const SCOPES = ["requests:read", "requests:write", "contracts:report"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The agent surfaces that can offer an operation. A command that none of them
 * offers is internal: it runs only for a web session, through the web UI, or
 * in the worker, for a system job or an integration event (agent-access: Six
 * kinds of caller).
 */
export const COMMAND_SURFACES = ["rest", "mcp", "cli"] as const;
export type CommandSurface = (typeof COMMAND_SURFACES)[number];

/** The stability levels (public-api: Each operation carries a stability level). */
export const STABILITY_LEVELS = ["alpha", "beta", "stable"] as const;
export type StabilityLevel = (typeof STABILITY_LEVELS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** When a deprecated operation was deprecated and, once set, the day on or after which it may be removed. */
export interface Deprecation {
  /** The calendar day the deprecation was released, such as 2026-12-01. */
  since: string;
  /** The calendar day on or after which the operation may be removed, such as 2026-12-15. */
  sunset?: string;
}

/**
 * A value the person enters on the review page of an action that needs the
 * confirmation step, such as a secret (agent-safety: The review page of the
 * confirmation step; github-app-reachability: design.md, Design rules: Moving
 * to webhook mode). It is not part of the action's input: the review page
 * takes the input from its URL and renders it, so a value that must stay out
 * of URLs and pages travels only in the body of the POST that applies the
 * action. It is in no review, no confirmation digest and no URL, and no page
 * shows it.
 */
export interface SealedField {
  /** The form field's name, which the handler reads the value by. */
  readonly name: string;
  /** The field's label on the review page, in Tiehall's own words. */
  readonly label: string;
  /** password: typed or pasted, and never shown; file: a file the person picks, read as text, such as a PEM key. */
  readonly kind: "password" | "file";
  /** The value's schema; a value that fails it gets 400, and the refusal names the field, never the value. */
  readonly schema: z.ZodType<string>;
}

/** A value a CLI command sets in its operation's input, such as the kind of a message. */
export type CliValue = string | number | boolean;

/**
 * A command of the CLI that runs an operation (agent-surfaces: CLI request
 * commands; design.md, Self-hosting decisions: S16). The CLI may not import
 * the catalog, so the OpenAPI document states each command in its operation's
 * x-tiehall-cli extension, and the CLI builds the command from it: its name;
 * the input fields it takes as positional arguments, in this order; the input
 * it sets itself, for which it offers no option; and the input it sets unless
 * an option gives another value. Every other field of the operation's input,
 * and each header the operation takes, such as If-Match, is an option named
 * after it, such as --question-id. Two commands can run one operation, as ask
 * and reply both post a message.
 */
export interface CliCommand {
  /** One or more lower-case words, such as get or "contract report". */
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly input?: Readonly<Record<string, CliValue>>;
  readonly defaults?: Readonly<Record<string, CliValue>>;
}

/**
 * An operation's earlier shape, which an earlier major version of the API
 * keeps serving after a breaking change moved the operation to a later one
 * (public-api: After graduation, breaking changes go to a new major version;
 * design.md, Where the specs leave room: Two API versions). It holds what the
 * earlier version's document states and its path answers: its method and path
 * under /api/v<major>/, its input and output schemas, its stability level and
 * deprecation, and the CLI commands that version's document names; and the two
 * functions that carry a call between the shapes: `toCurrent` turns an input
 * that passed the earlier schema into the operation's current input, and
 * `fromCurrent` turns the current output into the earlier one. The handler
 * runs the current shape alone.
 */
export interface EarlierShape {
  /** The earlier major version, such as 1 for /api/v1, below the operation's own. */
  readonly major: number;
  readonly method: HttpMethod;
  /** The path, under /api/v<major>/. */
  readonly path: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /** Carries a parsed earlier input to the operation's current input, which its schema then parses. */
  readonly toCurrent: (input: never) => unknown;
  /** Carries the current output, as its schema passed it, to the earlier output, which the earlier schema then checks. */
  readonly fromCurrent: (output: never) => unknown;
  /** The CLI commands the earlier version's document names, for an operation the CLI offers. */
  readonly cli?: readonly CliCommand[];
  readonly stability: StabilityLevel;
  readonly deprecated?: Deprecation;
}

export interface CommandDefinition<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
  /** A dotted lower-case name, such as requests.create; the OpenAPI operationId. */
  readonly id: string;
  /** One sentence in Tiehall's own words, which the OpenAPI document and the tool list show. */
  readonly summary: string;
  readonly input: Input;
  readonly output: Output;
  /** The operation's method on REST, for a command offered on REST. */
  readonly method?: HttpMethod;
  /** The operation's path on REST, under /api/v1, for a command offered on REST. */
  readonly path?: string;
  /** The scopes a token needs to run it, each one of the three OAuth scopes. */
  readonly scopes: readonly Scope[];
  /** A commitment under D23: a user caller's call becomes a proposal that a person confirms. */
  readonly commitment: boolean;
  /** It needs the confirmation step, so it runs only in the web UI and no agent surface offers it. */
  readonly confirm: boolean;
  /**
   * The admin action it is, from the role matrix, for an operation only admins
   * may run (teams-and-roles: What admins and members may do): it runs only in
   * the web UI, so no agent surface offers it.
   */
  readonly admin?: AdminAction;
  /**
   * A system action (requests: System actions need no proposal or
   * confirmation): an internal command that only a system job or a verified
   * integration event runs, never a person or an agent, and that takes effect
   * without a proposal or a confirmation, such as a revision a contract
   * report adds.
   */
  readonly system?: boolean;
  /** The agent surfaces that offer it; none makes it an internal command. */
  readonly surfaces: readonly CommandSurface[];
  /** The MCP tool's name, for a command offered on MCP, such as get_request. */
  readonly tool?: string;
  /** The CLI's commands that run it, for a command offered on the CLI: most have one, such as get or "contract report". */
  readonly cli?: readonly CliCommand[];
  readonly stability: StabilityLevel;
  readonly deprecated?: Deprecation;
  /**
   * For an operation that adds a packet revision, the optional input field
   * REST fills from the If-Match header: the revision the caller expects, as
   * the ETag of the current revision names it (public-api: Packet revisions use
   * ETag and If-Match). REST never takes that field from the body; a call
   * without the header reaches the handler without it, which refuses it with
   * 428, as it refuses any other surface's call that names no revision.
   */
  readonly ifMatch?: string;
  /** The output field whose value is the answer's ETag, which REST sends as the ETag header, such as a packet's revision. */
  readonly etag?: string;
  /** The values the person enters on the action's review page, for a command that needs the confirmation step. */
  readonly sealed?: readonly SealedField[];
  /**
   * The operation's earlier shapes, one per earlier major version of the API
   * that still serves it, for a REST operation that a breaking change moved
   * to a later major version; its path names its current one.
   */
  readonly earlier?: readonly EarlierShape[];
}

/** A definition, typed by its schemas; the catalog checks it when it registers it. */
export function defineCommand<Input extends z.ZodType, Output extends z.ZodType>(
  definition: CommandDefinition<Input, Output>,
): CommandDefinition<Input, Output> {
  return definition;
}

/** A command's input, as its handler receives it after parsing. */
export type CommandInput<D extends CommandDefinition> = z.output<D["input"]>;
/** A command's output, as its handler returns it. */
export type CommandOutput<D extends CommandDefinition> = z.input<D["output"]>;
