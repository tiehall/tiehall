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
  /** The agent surfaces that offer it; none makes it an internal command. */
  readonly surfaces: readonly CommandSurface[];
  /** The MCP tool's name, for a command offered on MCP, such as get_request. */
  readonly tool?: string;
  /** The CLI command, for a command offered on the CLI, such as get or "contract report". */
  readonly cliCommand?: string;
  readonly stability: StabilityLevel;
  readonly deprecated?: Deprecation;
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
