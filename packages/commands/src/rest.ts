import { API_PREFIX, deprecationHeaders, isProposalAnswer, type Catalog, type CommandDefinition } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { agentJson } from "@tiehall/packet/render";
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
//   on REST, answers 404 and runs nothing, whoever calls it. Where two paths
//   match, as /api/v1/requests/search and /api/v1/requests/{key} do, the one
//   with a literal segment where the other has a parameter, from the left,
//   wins, as OpenAPI matches concrete paths before templated ones;
// - it asks who is calling, and answers a call without credentials with 401;
// - it builds the input from the path's parameters and, for GET and DELETE,
//   the query string, or, for the other methods, the JSON object in the body,
//   where a path parameter wins over a body field of the same name; a call
//   whose body is not a JSON object, or whose Idempotency-Key or If-Match
//   header it cannot take, is refused through execute(), after the membership
//   re-check, so a removed member gets 403 whatever they send
//   (teams-and-roles: Membership is re-checked on every call);
// - it runs the operation through execute() and answers with its output as
//   JSON, with 200, or, for a call that makes a commitment, with 202 and the
//   proposal it became (public-api: Commitments over the API answer 202 with
//   a proposal). Its callers are
//   agents and their tools, and the JSON variant of a request URL is the same
//   read, so the output is JSON as agents read it: without the invisible
//   characters the renderer strips, while what people wrote stays stored as
//   they wrote it (agent-safety: Invisible characters are stripped from the
//   agent view);
// - a POST with an Idempotency-Key runs once per key, caller and body for 24
//   hours, and a repeat gets the first response (public-api: POST operations
//   take an Idempotency-Key);
// - it answers every error as an RFC 9457 problem, with the media type
//   application/problem+json, as the error model gives it for each refusal
//   (public-api: One error model for Tiehall's own refusals). A failure that is
//   not one of Tiehall's own refusals answers 500 and says nothing about
//   itself; the log records it by its name and stack, never its message;
// - GET /api/v1/openapi.json answers anyone, without authentication, with
//   the OpenAPI document, the same for every reader (public-api: Every
//   install serves the OpenAPI 3.1 document without authentication);
// - an operation that adds a packet revision takes the revision the caller
//   expects from the If-Match header, as the ETag of that revision, such as
//   "3", and never from the body; a header that is not one such ETag, such as
//   a weak one, a list or *, matches no revision and answers 412, and a call
//   without it reaches the operation without a revision, which answers 428;
//   an answer that states its ETag, such as a packet read, sends it as the
//   ETag header (public-api: Packet revisions use ETag and If-Match);
// - every answer of a deprecated operation, its errors included, carries the
//   Deprecation header and, once it has a sunset date, the Sunset header,
//   from the same metadata as the OpenAPI document (public-api: Deprecated
//   operations send Deprecation and Sunset headers).

export interface RestOptions {
  catalog: Catalog;
  /** The OpenAPI document served at /api/v1/openapi.json, as JSON text. */
  document: string;
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
  /** Per path segment, 0 for a literal and 1 for a parameter, by which literal paths sort first. */
  shape: number[];
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Where the OpenAPI document is served. */
export const DOCUMENT_PATH = `${API_PREFIX}openapi.json`;

export function createRestHandler(options: RestOptions): RestHandler {
  const logger = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());
  const routes = options.catalog.commands
    .filter(({ surfaces }) => surfaces.includes("rest"))
    .map(routeOf)
    .sort((a, b) => literalFirst(a.shape, b.shape));

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === DOCUMENT_PATH && (request.method === "GET" || request.method === "HEAD")) {
      // Needs no authentication and holds nothing of the install, so it is the same for every reader.
      return new Response(request.method === "HEAD" ? null : options.document, {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-cache" },
      });
    }
    const found = resolve(routes, request.method, url.pathname);
    if (found === undefined) return problem(new Refusal("route-not-found", "There is no such operation here."));
    const response = await answer(request, url, found);
    for (const [name, value] of Object.entries(deprecationHeaders(found.definition))) response.headers.set(name, value);
    return response;
  };

  async function answer(request: Request, url: URL, found: ResolvedRoute): Promise<Response> {
    const { definition, parameters } = found;
    try {
      const caller = await options.authenticate(request);
      if (caller === undefined) {
        return problem(new Refusal("unauthenticated", "This operation needs a token in the Authorization header."));
      }
      // What is wrong with the call itself is refused by execute(), once it has re-checked the caller's membership.
      let refusal: Refusal | undefined;
      const idempotencyHeader = request.method === "POST" ? request.headers.get("idempotency-key") : null;
      const idempotencyKey = idempotencyHeader === null ? undefined : parseIdempotencyKey(idempotencyHeader);
      if (idempotencyHeader !== null && idempotencyKey === undefined) {
        refusal = new Refusal("invalid-input", "The Idempotency-Key header is a string of 1 to 255 visible characters.");
      }
      const body = BODY_METHODS.has(request.method) ? await request.text() : "";
      const built = inputOf(request, url, body, parameters);
      if (built === undefined) {
        refusal ??= new Refusal("invalid-input", "The body of this operation is a JSON object, sent as application/json.");
      }
      const input = built ?? {};
      if (definition.ifMatch !== undefined) {
        delete input[definition.ifMatch];
        const ifMatch = request.headers.get("if-match");
        if (ifMatch !== null) {
          const revision = revisionOfEtag(ifMatch);
          if (revision === undefined) {
            refusal ??= new Refusal("precondition-failed", 'If-Match names no current revision: send the ETag of the packet\'s current revision, such as "3".');
          } else {
            input[definition.ifMatch] = revision;
          }
        }
      }
      const statusOf = (output: unknown) => (definition.commitment && isProposalAnswer(output) ? 202 : 200);
      const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const executeOptions: ExecuteOptions = {
        origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) },
        ...(refusal === undefined ? {} : { refusal }),
      };
      if (idempotencyKey !== undefined && refusal === undefined) {
        const claim = {
          caller: idempotencyCallerOf(caller),
          key: idempotencyKey,
          digest: requestDigest(request.method, url.pathname, body),
          now: now(),
        };
        executeOptions.around = (context, run) => runOnce(context, claim, run, (output) => ({ status: statusOf(output), body: JSON.stringify(output) }));
      }
      const output = await options.execute(definition.id, caller, input, executeOptions);
      const status = statusOf(output);
      return json(status, JSON.stringify(agentJson(output)), status === 200 ? etagOf(definition, output) : undefined);
    } catch (error) {
      if (error instanceof IdempotentReplay) {
        const replayed = error.response;
        const output: unknown = JSON.parse(replayed.body);
        return json(replayed.status, JSON.stringify(agentJson(output)), replayed.status < 300 ? etagOf(definition, output) : undefined);
      }
      if (error instanceof Refusal) return problem(error);
      logger.error("rest: the operation failed", { operationId: definition.id, error });
      return response(internalErrorProblem());
    }
  }
}

function routeOf(definition: CommandDefinition): Route {
  const parameters: string[] = [];
  const shape: number[] = [];
  const source = (definition.path ?? "")
    .split("/")
    .map((segment) => {
      const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment)?.[1];
      shape.push(parameter === undefined ? 0 : 1);
      if (parameter === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      parameters.push(parameter);
      return "([^/]+)";
    })
    .join("/");
  return { definition, pattern: new RegExp(`^${source}$`), parameters, shape };
}

/** Orders two paths so that, at the first segment where one has a literal and the other a parameter, the literal comes first. */
function literalFirst(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  // Paths of different lengths never match the same URL; ordering them by length keeps the order total.
  return a.length - b.length;
}

/** An operation found by method and path, with the path's parameters, decoded. */
interface ResolvedRoute {
  definition: CommandDefinition;
  parameters: Record<string, string>;
}

/** The operation at this method and path; none when no REST operation is there. */
function resolve(routes: readonly Route[], method: string, pathname: string): ResolvedRoute | undefined {
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

/** The revision a strong ETag such as "3" names; undefined for anything else, such as W/"3", "3", "4" or *. */
function revisionOfEtag(header: string): number | undefined {
  const digits = /^\s*"([1-9]\d{0,9})"\s*$/.exec(header)?.[1];
  const revision = digits === undefined ? undefined : Number(digits);
  return revision !== undefined && Number.isSafeInteger(revision) ? revision : undefined;
}

/** The ETag of an answer whose operation states one, from the output field it names. */
function etagOf(definition: CommandDefinition, output: unknown): string | undefined {
  if (definition.etag === undefined || typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>)[definition.etag];
  return typeof value === "number" || typeof value === "string" ? `"${value}"` : undefined;
}

/** An operation's JSON answer, with its ETag when it states one. */
function json(status: number, body: string, etag?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (etag !== undefined) headers["etag"] = etag;
  return new Response(body, { status, headers });
}

/** A refusal as an RFC 9457 problem details response. */
function problem(refusal: Refusal): Response {
  return response(httpProblem(refusal));
}

function response({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
