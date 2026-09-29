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
  /** The CLI command, for a command offered on the CLI, such as get or "contract report". */
  readonly cliCommand?: string;
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
