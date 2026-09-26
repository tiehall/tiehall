import { z } from "zod";
import { COMMAND_SURFACES, SCOPES, STABILITY_LEVELS, type CommandDefinition } from "./command.ts";
import { lowerToolSchema, ToolSchemaError } from "./tool-schemas.ts";

// Registering definitions (public-api: One definition per operation, the same
// on every surface; agent-safety: The confirmation step runs only in the web
// UI). A catalog holds each operation once and refuses a definition that
// would make the surfaces disagree or offer to an agent what only a person may
// do: a second definition with the same id, a scope outside the three OAuth
// scopes, a REST operation without its method and path or with the method and
// path of another, even with its parameters named differently, and a command that
// needs the confirmation step but is offered on an agent surface. A REST
// operation's input is an object, or, sent as a JSON body, variants of
// objects, as a tool whose input has variants takes (agent-surfaces: Tool
// schemas that current clients accept). A tool's
// input and output must lower to schemas that current MCP clients accept
// (agent-surfaces: Tool schemas that current clients accept).

/** A catalog that breaks the rules; its message names every problem, one per line. */
export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface Catalog {
  /** Every definition, in the order it was registered. */
  readonly commands: readonly CommandDefinition[];
  get(id: string): CommandDefinition | undefined;
}

const ID = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** Where every REST path starts: the API's major version is in the path (public-api: The major version is in the path). */
export const API_PREFIX = "/api/v1/";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every rule the definitions break, as a sentence; none when they keep them. */
export function catalogProblems(definitions: readonly CommandDefinition[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const routes = new Map<string, string>();
  const tools = new Map<string, string>();
  const cliCommands = new Map<string, string>();
  for (const definition of definitions) {
    const problem = (text: string) => problems.push(`${definition.id}: ${text}`);
    const surfaces: readonly string[] = definition.surfaces;
    const offered = surfaces.length > 0;
    // A second definition with an id already taken is reported once, not again for its path, tool and command.
    const duplicate = ids.has(definition.id);
    ids.add(definition.id);
    const claim = (names: Map<string, string>, name: string, what: string) => {
      if (duplicate) return;
      const other = names.get(name);
      if (other === undefined) names.set(name, definition.id);
      else problem(`${what} ${name} is also the ${what.replace(/^the /, "")} of ${other}.`);
    };
    if (!ID.test(definition.id)) problem('the id is not a dotted lower-case name, such as "requests.create".');
    for (const scope of definition.scopes) {
      if (!(SCOPES as readonly string[]).includes(scope)) problem(`the scope ${scope} is not one of ${SCOPES.join(", ")}.`);
    }
    for (const surface of surfaces) {
      if (!(COMMAND_SURFACES as readonly string[]).includes(surface)) {
        problem(`the surface ${surface} is not one of ${COMMAND_SURFACES.join(", ")}; a command that no surface offers is internal.`);
      }
    }
    if (!(STABILITY_LEVELS as readonly string[]).includes(definition.stability)) {
      problem(`the stability level ${definition.stability} is not one of ${STABILITY_LEVELS.join(", ")}.`);
    }
    if (definition.confirm && offered) {
      problem("it needs the confirmation step, which runs only in the web UI, so no agent surface offers it.");
    }
    if (offered && !definition.confirm && definition.scopes.length === 0) {
      problem("it is offered on an agent surface, so it names the scopes a token needs to run it.");
    }
    if (surfaces.includes("rest")) {
      const { method, path } = definition;
      if (method === undefined || path === undefined) {
        problem("it is offered on REST, so it names its method and its path.");
      } else {
        if (!path.startsWith(API_PREFIX)) problem(`its path ${path} does not start with ${API_PREFIX}, where the API's major version 1 lives.`);
        const fields = inputFields(definition.input);
        if (fields === undefined) {
          problem("it is offered on REST, so its input is an object, or variants of objects, whose fields the path, query or body carry.");
        } else if (fields.variants && !BODY_METHODS.has(method)) {
          problem("its input has variants, which only a JSON body carries, so it is offered on REST with POST, PUT or PATCH.");
        }
        for (const [, parameter = ""] of path.matchAll(/\{([^}]*)\}/g)) {
          if (fields !== undefined && !fields.names.includes(parameter)) problem(`its path names {${parameter}}, which is not a field of its input.`);
        }
        if (!duplicate) {
          // Paths that differ only in their parameters' names match the same URLs, and OpenAPI counts them as one.
          const route = `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`;
          const other = routes.get(route);
          if (other === undefined) routes.set(route, definition.id);
          else problem(`${method} ${path} is also the path of ${other}.`);
        }
      }
    }
    if (surfaces.includes("mcp")) {
      if (definition.tool === undefined) problem("it is offered on MCP, so it names its tool.");
      else claim(tools, definition.tool, "the tool");
      for (const [io, schema] of [["input", definition.input], ["output", definition.output]] as const) {
        try {
          lowerToolSchema(schema, io);
        } catch (error) {
          if (!(error instanceof ToolSchemaError)) throw error;
          problem(`its tool's ${io} schema cannot be lowered: ${error.message}`);
        }
      }
    }
    if (surfaces.includes("cli")) {
      if (!surfaces.includes("rest")) problem("it is offered on the CLI, which calls REST, so it is offered on REST too.");
      if (definition.cliCommand === undefined) problem("it is offered on the CLI, so it names its CLI command.");
      else claim(cliCommands, definition.cliCommand, "the CLI command");
    }
    const { deprecated } = definition;
    if (deprecated !== undefined && (!isDate(deprecated.since) || (deprecated.sunset !== undefined && !isDate(deprecated.sunset)))) {
      problem("its deprecation dates are calendar dates, such as 2026-12-15.");
    }
    if (duplicate) problem("two definitions have this id.");
  }
  return problems;
}

/** A catalog of these definitions; it throws CatalogError, naming every problem, when they break a rule. */
export function defineCatalog(definitions: readonly CommandDefinition[]): Catalog {
  const problems = catalogProblems(definitions);
  if (problems.length > 0) throw new CatalogError(problems.join("\n"));
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return {
    commands: [...definitions],
    get: (id) => byId.get(id),
  };
}

/** The methods whose input comes in a JSON body, which alone can carry an input with variants. */
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/**
 * The fields an input has whatever its variant: an object's fields, or those
 * that every variant of a union of objects has; undefined for an input that is
 * neither.
 */
function inputFields(input: z.ZodType): { names: string[]; variants: boolean } | undefined {
  if (input instanceof z.ZodObject) return { names: Object.keys(input.shape), variants: false };
  const variants = variantsOf(input);
  if (variants === undefined) return undefined;
  const [first = [], ...others] = variants.map((variant) => Object.keys(variant.shape));
  return { names: first.filter((name) => others.every((names) => names.includes(name))), variants: true };
}

/** The variants of an input that is a union of objects, such as a union on kind; undefined for any other input. */
export function variantsOf(input: z.ZodType): z.ZodObject[] | undefined {
  if (!(input instanceof z.ZodUnion)) return undefined;
  const options = input.def.options as readonly z.ZodType[];
  if (options.length === 0 || !options.every((option) => option instanceof z.ZodObject)) return undefined;
  return options as z.ZodObject[];
}

/** A real calendar day written as YYYY-MM-DD. */
function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}
