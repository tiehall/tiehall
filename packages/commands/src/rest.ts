import { API_PREFIX, type Catalog, type CommandDefinition } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { Caller } from "./caller.ts";
import type { Execute, ExecuteOptions } from "./execute.ts";
import { idempotencyCallerOf, IdempotentReplay, parseIdempotencyKey, requestDigest, runOnce } from "./idempotency.ts";
import { createLogger, type Logger } from "./log.ts";

// The REST catch-all route under /api/v1 (public-api: Operations not offered on
// REST answer 404; public-api: Errors are RFC 9457 problem details; public-api:
// The major version is in the path; design.md, Technical decisions: T3). One
// route handler serves every operation the catalog offers on REST, so REST
// cannot drift from the other surfaces:
// - it finds the operation by method and path among the catalog's REST
//   operations; any other path, including one whose operation is not offered
//   on REST, answers 404 and runs nothing, whoever calls it;
// - it asks who is calling, and answers a call without credentials with 401;
// - it builds the input from the path's parameters and, for GET and DELETE,
//   the query string, or, for the other methods, the JSON object in the body,
//   where a path parameter wins over a body field of the same name;
// - it runs the operation through execute() and answers with its output as
//   JSON, or 202 for a commitment, which becomes a proposal;
// - a POST with an Idempotency-Key runs once per key, caller and body for 24
//   hours, and a repeat gets the first response (public-api: POST operations
//   take an Idempotency-Key);
// - it answers every error as an RFC 9457 problem, with the media type
//   application/problem+json, as the error model gives it for each refusal
//   (public-api: One error model for Tiehall's own refusals). A failure that is
//   not one of Tiehall's own refusals answers 500 and says nothing about
//   itself; the log records it by its name and stack, never its message.

export interface RestOptions {
  catalog: Catalog;
  execute: Execute;
  /** Who is calling, from the call's credentials; undefined when it carries none that are valid. */
  authenticate(request: Request): Promise<Caller | undefined>;
  logger?: Logger;
  /** The clock Idempotency-Keys are kept by; the system clock unless a test controls it. */
  now?: () => Date;
}

export type RestHandler = (request: Request) => Promise<Response>;

interface Route {
  definition: CommandDefinition;
  pattern: RegExp;
  parameters: string[];
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export function createRestHandler(options: RestOptions): RestHandler {
  const logger = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());
  const routes = options.catalog.commands.filter(({ surfaces }) => surfaces.includes("rest")).map(routeOf);

  return async function handle(request) {
    const url = new URL(request.url);
    const found = resolve(routes, request.method, url.pathname);
    if (found === undefined) return problem(new Refusal("route-not-found", "There is no such operation here."));
    const { definition, parameters } = found;
    try {
      const caller = await options.authenticate(request);
      if (caller === undefined) {
        return problem(new Refusal("unauthenticated", "This operation needs a token in the Authorization header."));
      }
      const idempotencyHeader = request.method === "POST" ? request.headers.get("idempotency-key") : null;
      const idempotencyKey = idempotencyHeader === null ? undefined : parseIdempotencyKey(idempotencyHeader);
      if (idempotencyHeader !== null && idempotencyKey === undefined) {
        return problem(new Refusal("invalid-input", "The Idempotency-Key header is a string of 1 to 255 visible characters."));
      }
      const body = BODY_METHODS.has(request.method) ? await request.text() : "";
      const input = inputOf(request, url, body, parameters);
      if (input === undefined) {
        return problem(new Refusal("invalid-input", "The body of this operation is a JSON object, sent as application/json."));
      }
      const status = definition.commitment ? 202 : 200;
      const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const executeOptions: ExecuteOptions = {
        origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) },
      };
      if (idempotencyKey !== undefined) {
        const claim = {
          caller: idempotencyCallerOf(caller),
          key: idempotencyKey,
          digest: requestDigest(request.method, url.pathname, body),
          now: now(),
        };
        executeOptions.around = (context, run) => runOnce(context, claim, run, (output) => ({ status, body: JSON.stringify(output) }));
      }
      const output = await options.execute(definition.id, caller, input, executeOptions);
      return json(status, JSON.stringify(output));
    } catch (error) {
      if (error instanceof IdempotentReplay) return json(error.response.status, error.response.body);
      if (error instanceof Refusal) return problem(error);
      logger.error("rest: the operation failed", { operationId: definition.id, error });
      return response(internalErrorProblem());
    }
  };
}

function routeOf(definition: CommandDefinition): Route {
  const parameters: string[] = [];
  const source = (definition.path ?? "")
    .split("/")
    .map((segment) => {
      const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment)?.[1];
      if (parameter === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      parameters.push(parameter);
      return "([^/]+)";
    })
    .join("/");
  return { definition, pattern: new RegExp(`^${source}$`), parameters };
}

/** The operation at this method and path, with the path's parameters, decoded; none when no REST operation is there. */
function resolve(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { definition: CommandDefinition; parameters: Record<string, string> } | undefined {
  if (!pathname.startsWith(API_PREFIX)) return undefined;
  for (const route of routes) {
    if (route.definition.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match === null) continue;
    const parameters: Record<string, string> = {};
    try {
      route.parameters.forEach((name, index) => {
        parameters[name] = decodeURIComponent(match[index + 1] ?? "");
      });
    } catch {
      // A path segment that is not valid percent-encoding names nothing.
      return undefined;
    }
    return { definition: route.definition, parameters };
  }
  return undefined;
}

/** The operation's input: the query or the JSON body, with the path's parameters; undefined for a body that is not a JSON object. */
function inputOf(request: Request, url: URL, text: string, parameters: Record<string, string>): Record<string, unknown> | undefined {
  if (!BODY_METHODS.has(request.method)) {
    const query: Record<string, string | string[]> = {};
    for (const name of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name);
      query[name] = values.length === 1 ? (values[0] ?? "") : values;
    }
    return { ...query, ...parameters };
  }
  if (text.trim() === "") return { ...parameters };
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(mediaType)) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return { ...(body as Record<string, unknown>), ...parameters };
}

/** An operation's JSON answer. */
function json(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** A refusal as an RFC 9457 problem details response. */
function problem(refusal: Refusal): Response {
  return response(httpProblem(refusal));
}

function response({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
