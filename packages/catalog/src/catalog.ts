import { ADMIN_ACTIONS } from "@tiehall/core";
import { z } from "zod";
import { COMMAND_SURFACES, SCOPES, STABILITY_LEVELS, type CliCommand, type CommandDefinition, type Deprecation, type EarlierShape, type HttpMethod, type StabilityLevel } from "./command.ts";
import { lowerToolSchema, ToolSchemaError } from "./tool-schemas.ts";

// Registering definitions (public-api: One definition per operation, the same
// on every surface; agent-safety: The confirmation step runs only in the web
// UI). A catalog holds each operation once and refuses a definition that
// would make the surfaces disagree or offer to an agent what only a person may
// do: a second definition with the same id, a scope outside the three OAuth
// scopes, a REST operation without its method and path or with the method and
// path of another, even with its parameters named differently, and a command that
// needs the confirmation step, or is an admin action, but is offered on an
// agent surface (agent-surfaces: Admin actions and trust changes are on no
// agent surface). A REST
// operation's input is an object, or, sent as a JSON body, variants of
// objects, as a tool whose input has variants takes (agent-surfaces: Tool
// schemas that current clients accept). A tool's
// input and output must lower to schemas that current MCP clients accept
// (agent-surfaces: Tool schemas that current clients accept). No operation
// changes or deletes an event of the activity log, on any surface: the web UI
// runs its operations through this same catalog, so an operation on the
// event log only reads, gets, lists, waits for, acknowledges or exports
// events, is never offered with DELETE, PUT or PATCH, and no summary says an
// operation changes or deletes events (activity-log: The activity log is
// append-only).

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

/** The namespaces and the REST paths of the operations on the event log, the activity log. */
const EVENT_LOG_NAMESPACES: ReadonlySet<string> = new Set(["events", "activity_log"]);
const EVENT_LOG_PATH = /^\/api\/v1\/(events|activity-log)(\/|$)/;
/** What an operation on the event log may do: read it, in one form or another, and never change it. */
const EVENT_LOG_VERBS: ReadonlySet<string> = new Set(["read", "get", "list", "wait", "acknowledge", "export"]);
const EVENT_LOG_REFUSED_METHODS: ReadonlySet<string> = new Set(["DELETE", "PUT", "PATCH"]);
/**
 * A summary that says the operation changes, deletes or rewrites events,
 * within a few words, such as "delete its events" or "redact one field of an
 * event"; a noun such as "a change" is not a verb.
 */
const CHANGES_EVENTS =
  /(?<!\b(?:a|an|the|its|their|this|that|of|no|each|every)\s)\b(delete|remove|change|edit|rewrite|update|purge|redact|clear|erase|drop|truncate|alter|modify|overwrite)(?:s|d|ed|ing)?\b(?:\s+\S+){0,3}?\s+(?:(?:a|an|the|its|their|every|all|these|those)\s+)?(?:events?|activity log)\b/i;

/** Where every path of /api/v1 starts, the API's first major version (public-api: The major version is in the path). */
export const API_PREFIX = "/api/v1/";

/**
 * Where every REST path starts: /api/v<N>/, with the API's major version N in
 * the path (public-api: The major version is in the path; public-api: After
 * graduation, breaking changes go to a new major version).
 */
export const API_PATH = /^\/api\/v([1-9][0-9]{0,2})\//;

/** The major version of the API a path lies under, such as 2 for /api/v2/requests; undefined for any other path. */
export function apiMajorOfPath(path: string): number | undefined {
  const match = API_PATH.exec(path);
  return match === null ? undefined : Number(match[1]);
}

/** The major version of the API whose path a REST operation's current shape has, such as 1; undefined for an operation with no such path. */
export function apiMajorOf(definition: Pick<CommandDefinition, "path">): number | undefined {
  return definition.path === undefined ? undefined : apiMajorOfPath(definition.path);
}

/**
 * One shape of a REST operation, as the document of its major version states
 * it and its path answers (design.md, Where the specs leave room: Two API
 * versions): the operation's current shape, or one of its earlier shapes,
 * which `earlier` then holds.
 */
export interface RestShape {
  readonly definition: CommandDefinition;
  readonly major: number;
  readonly method: HttpMethod;
  readonly path: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly stability: StabilityLevel;
  readonly deprecated: Deprecation | undefined;
  /** The CLI commands this shape's document names; none for a shape the CLI does not offer. */
  readonly cli: readonly CliCommand[];
  /** The earlier shape this is, for one an earlier major version keeps serving; undefined for the current shape. */
  readonly earlier: EarlierShape | undefined;
}

/** The major versions of the API that the catalog's operations are served under, in order, such as [1] or [1, 2]. */
export function apiMajorsOf(catalog: Pick<Catalog, "commands">): number[] {
  return [...new Set(restShapesOf(catalog).map(({ major }) => major))].sort((a, b) => a - b);
}

/** Every REST shape of the catalog's operations, that is each operation offered on REST, at its current path, and each of its earlier shapes. */
export function restShapesOf(catalog: Pick<Catalog, "commands">): RestShape[] {
  return catalog.commands.flatMap((definition) => {
    const { method, path } = definition;
    const major = apiMajorOf(definition);
    if (!definition.surfaces.includes("rest") || method === undefined || path === undefined || major === undefined) return [];
    const cli = definition.surfaces.includes("cli") ? (definition.cli ?? []) : [];
    const current: RestShape = {
      definition,
      major,
      method,
      path,
      input: definition.input,
      output: definition.output,
      stability: definition.stability,
      deprecated: definition.deprecated,
      cli,
      earlier: undefined,
    };
    const earlier = (definition.earlier ?? []).map(
      (shape): RestShape => ({
        definition,
        major: shape.major,
        method: shape.method,
        path: shape.path,
        input: shape.input,
        output: shape.output,
        stability: shape.stability,
        deprecated: shape.deprecated,
        cli: definition.surfaces.includes("cli") ? (shape.cli ?? []) : [],
        earlier: shape,
      }),
    );
    return [current, ...earlier];
  });
}
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
    if (definition.sealed !== undefined && definition.sealed.length > 0) {
      // Values entered on a review page exist only for an action that has one.
      if (!definition.confirm) problem("it takes values entered on a review page, which only an action that needs the confirmation step has.");
      const names = definition.sealed.map(({ name }) => name);
      if (new Set(names).size !== names.length) problem("two of the values entered on its review page share a name.");
      for (const { name } of definition.sealed) {
        if (!/^[a-z][A-Za-z0-9]*$/.test(name) || ["input", "nonce", "csrf", "action"].includes(name)) {
          problem(`the value ${name} entered on its review page needs a camelCase name that the page's form does not use itself.`);
        }
        if (definition.input instanceof z.ZodObject && Object.hasOwn(definition.input.shape, name)) {
          problem(`the value ${name} entered on its review page is also a field of its input, which the review page's URL carries.`);
        }
      }
    }
    if (definition.admin !== undefined) {
      if (!(ADMIN_ACTIONS as readonly string[]).includes(definition.admin)) {
        problem(`the admin action ${definition.admin} is not one of ${ADMIN_ACTIONS.join(", ")}.`);
      } else if (offered) {
        problem("it is an admin action, which runs only in the web UI, so no agent surface offers it.");
      }
    }
    if (definition.system === true) {
      // A system action runs only in the worker, for a job or an integration event, and needs nobody to confirm it.
      if (offered) problem("it is a system action, which only Tiehall's jobs and verified integration events run, so no agent surface offers it.");
      if (definition.confirm || definition.commitment) problem("it is a system action, which needs no proposal and no confirmation.");
      if (definition.admin !== undefined) problem("it is a system action, which acts for no admin.");
    }
    // The activity log is append-only: no operation on any surface changes or deletes an event.
    const [namespace = "", verb = ""] = definition.id.split(".");
    if (EVENT_LOG_NAMESPACES.has(namespace) || (definition.path !== undefined && EVENT_LOG_PATH.test(definition.path))) {
      if (!EVENT_LOG_VERBS.has(verb)) {
        problem(
          `it is an operation on the activity log, which is append-only, so it only reads, gets, lists, waits for, acknowledges or exports events; ${verb} is none of these.`,
        );
      }
      if (definition.method !== undefined && EVENT_LOG_REFUSED_METHODS.has(definition.method)) {
        problem("it is an operation on the activity log, which is append-only, so it is not offered with DELETE, PUT or PATCH.");
      }
    }
    if (CHANGES_EVENTS.test(definition.summary)) {
      problem("its summary says it changes or deletes events, which the activity log, being append-only, lets no operation do.");
    }
    if (definition.commitment) {
      // A call that makes a commitment answers { proposal } instead of the output, so the output never has that field.
      if (definition.output instanceof z.ZodObject && Object.hasOwn(definition.output.shape, "proposal")) {
        problem("it is a commitment, which answers a call that makes one with { proposal }, so its own output has no field named proposal.");
      }
      if (definition.confirm) problem("it is a commitment, which becomes a proposal people confirm, so it does not need the confirmation step itself.");
      if (definition.method === "GET") problem("it is a commitment, which changes something, so it is not offered with GET.");
    }
    if (offered && !definition.confirm && definition.scopes.length === 0) {
      problem("it is offered on an agent surface, so it names the scopes a token needs to run it.");
    }
    if (surfaces.includes("rest")) {
      const { method, path } = definition;
      if (method === undefined || path === undefined) {
        problem("it is offered on REST, so it names its method and its path.");
      } else {
        if (!API_PATH.test(path)) problem(`its path ${path} does not start with /api/v<N>/, where the API's major version N lives.`);
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
    const cli = definition.cli ?? [];
    if (surfaces.includes("cli")) {
      if (!surfaces.includes("rest")) problem("it is offered on the CLI, which calls REST, so it is offered on REST too.");
      if (cli.length === 0) problem("it is offered on the CLI, so it names its CLI command.");
    } else if (cli.length > 0) {
      problem("it names CLI commands, so it is offered on the CLI.");
    }
    const fieldNames = inputFieldsOfAnyVariant(definition.input);
    for (const command of cli) {
      if (!CLI_COMMAND.test(command.command)) {
        problem(`its CLI command ${command.command} is not lower-case words, such as get or "contract report".`);
        continue;
      }
      claim(cliCommands, command.command, "the CLI command");
      const set = [...Object.keys(command.input ?? {}), ...Object.keys(command.defaults ?? {})];
      const taken = new Set<string>();
      for (const argument of command.arguments ?? []) {
        if (taken.has(argument)) problem(`its CLI command ${command.command} takes ${argument} as an argument twice.`);
        taken.add(argument);
        if (!fieldNames.has(argument)) problem(`its CLI command ${command.command} takes ${argument} as an argument, which is not a field of its input.`);
        else if (set.includes(argument)) problem(`its CLI command ${command.command} both takes ${argument} as an argument and sets it.`);
      }
      for (const field of new Set(set)) {
        if (!fieldNames.has(field)) problem(`its CLI command ${command.command} sets ${field}, which is not a field of its input.`);
        else if (set.indexOf(field) !== set.lastIndexOf(field)) problem(`its CLI command ${command.command} sets ${field} twice.`);
      }
    }
    if (definition.ifMatch !== undefined || definition.etag !== undefined) {
      if (!surfaces.includes("rest")) {
        problem("If-Match and ETag are REST headers, so only an operation offered on REST names them.");
      } else {
        const field = definition.ifMatch;
        // An input with variants names the field in the variants that change the packet, and only those.
        const shapes = (definition.input instanceof z.ZodObject ? [definition.input] : (variantsOf(definition.input) ?? [])).map(
          (object) => object.shape as Record<string, z.ZodType>,
        );
        const having = shapes.filter((shape) => field !== undefined && Object.hasOwn(shape, field));
        if (field !== undefined && (having.length === 0 || having.some((shape) => !(shape[field] instanceof z.ZodOptional)))) {
          problem(`its If-Match fills ${field}, which is not an optional field of its input.`);
        }
        const outputShape = definition.output instanceof z.ZodObject ? (definition.output.shape as Record<string, z.ZodType>) : {};
        if (definition.etag !== undefined && outputShape[definition.etag] === undefined) {
          problem(`its ETag comes from ${definition.etag}, which is not a field of its output.`);
        }
      }
    }
    const { deprecated } = definition;
    if (deprecated !== undefined && (!isDate(deprecated.since) || (deprecated.sunset !== undefined && !isDate(deprecated.sunset)))) {
      problem("its deprecation dates are calendar dates, such as 2026-12-15.");
    }
    if (duplicate) problem("two definitions have this id.");
  }
  // The earlier shapes, once every operation's current path is claimed, so a shape that takes another's path is the one named.
  for (const definition of definitions) {
    for (const text of earlierShapeProblems(definition, routes)) problems.push(`${definition.id}: ${text}`);
  }
  return problems;
}

/**
 * What an operation's earlier shapes break (design.md, Where the specs leave
 * room: Two API versions): only a REST operation has them, one per earlier
 * major version below its own, each at a path of its own major version that
 * no other operation takes, with an input its path and its CLI commands can
 * be built from; an operation with If-Match or an ETag has none yet.
 */
function earlierShapeProblems(definition: CommandDefinition, routes: Map<string, string>): string[] {
  const earlier = definition.earlier ?? [];
  if (earlier.length === 0) return [];
  if (!definition.surfaces.includes("rest")) return ["it has an earlier shape, which only an operation offered on REST has."];
  const problems: string[] = [];
  if (definition.ifMatch !== undefined || definition.etag !== undefined) {
    problems.push("it has an earlier shape and names If-Match or an ETag, which earlier shapes do not carry yet.");
  }
  const own = apiMajorOf(definition);
  const seen = new Set<number>();
  for (const shape of earlier) {
    const version = `/api/v${shape.major}`;
    if (!Number.isInteger(shape.major) || shape.major < 1) {
      problems.push(`its earlier shape names the major version ${shape.major}, which is not a whole number from 1.`);
      continue;
    }
    if (seen.has(shape.major)) {
      problems.push(`it has two earlier shapes for ${version}.`);
      continue;
    }
    seen.add(shape.major);
    if (own !== undefined && shape.major >= own) problems.push(`its earlier shape for ${version} is not under an earlier major version than its own, /api/v${own}.`);
    if (!shape.path.startsWith(`${version}/`)) problems.push(`the path ${shape.path} of its earlier shape for ${version} does not start with ${version}/.`);
    if (!(STABILITY_LEVELS as readonly string[]).includes(shape.stability)) {
      problems.push(`its earlier shape for ${version} has the stability level ${shape.stability}, which is not one of ${STABILITY_LEVELS.join(", ")}.`);
    }
    const fields = inputFields(shape.input);
    if (fields === undefined) {
      problems.push(`its earlier shape for ${version} has an input that is not an object, or variants of objects, whose fields the path, query or body carry.`);
    } else if (fields.variants && !BODY_METHODS.has(shape.method)) {
      problems.push(`its earlier shape for ${version} has an input with variants, which only a JSON body carries, so it is offered with POST, PUT or PATCH.`);
    }
    for (const [, parameter = ""] of shape.path.matchAll(/\{([^}]*)\}/g)) {
      if (fields !== undefined && !fields.names.includes(parameter)) {
        problems.push(`the path ${shape.path} of its earlier shape names {${parameter}}, which is not a field of its input.`);
      }
    }
    const route = `${shape.method} ${shape.path.replace(/\{[^}]*\}/g, "{}")}`;
    const other = routes.get(route);
    if (other === undefined) routes.set(route, definition.id);
    else problems.push(`${shape.method} ${shape.path}, the path of its earlier shape for ${version}, is also the path of ${other}.`);
    const cli = shape.cli ?? [];
    if (cli.length > 0 && !definition.surfaces.includes("cli")) problems.push(`its earlier shape for ${version} names CLI commands, so it is offered on the CLI.`);
    const names = inputFieldsOfAnyVariant(shape.input);
    for (const command of cli) {
      for (const argument of command.arguments ?? []) {
        if (!names.has(argument)) problems.push(`its earlier shape's CLI command ${command.command} takes ${argument} as an argument, which is not a field of its input.`);
      }
      for (const field of [...Object.keys(command.input ?? {}), ...Object.keys(command.defaults ?? {})]) {
        if (!names.has(field)) problems.push(`its earlier shape's CLI command ${command.command} sets ${field}, which is not a field of its input.`);
      }
    }
    const { deprecated } = shape;
    if (deprecated !== undefined && (!isDate(deprecated.since) || (deprecated.sunset !== undefined && !isDate(deprecated.sunset)))) {
      problems.push(`the deprecation dates of its earlier shape for ${version} are calendar dates, such as 2026-12-15.`);
    }
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

/** A CLI command's name: one or more lower-case words, such as get, link-pr or "contract report". */
const CLI_COMMAND = /^[a-z][a-z-]*( [a-z][a-z-]*)*$/;

/** Every field an input has in any of its variants: an object's fields, or those of each variant of a union of objects. */
function inputFieldsOfAnyVariant(input: z.ZodType): ReadonlySet<string> {
  if (input instanceof z.ZodObject) return new Set(Object.keys(input.shape));
  return new Set((variantsOf(input) ?? []).flatMap((variant) => Object.keys(variant.shape)));
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
