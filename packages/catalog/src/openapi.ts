import { z } from "zod";
import { createDocument, type ZodOpenApiOperationObject, type ZodOpenApiPathsObject, type ZodOpenApiResponsesObject } from "zod-openapi";
import type { Catalog } from "./catalog.ts";
import type { CommandDefinition } from "./command.ts";

// The OpenAPI 3.1 document of /api/v1, generated from the catalog (public-api:
// What the document states for each operation; public-api: Responses can gain
// fields without breaking clients; public-api: Each operation carries a
// stability level; public-api: The API version number while the API is beta;
// design.md, Technical decisions: T10). It lists every operation the catalog
// offers on REST, and states for each:
// - its command id as operationId, and its summary;
// - its scopes under security, as the bearer token's scopes (OpenAPI 3.1
//   lets a security requirement of any scheme list them), so the document
//   holds no install's URLs;
// - its stability level in x-stability-level, and for a deprecated operation
//   `deprecated: true` with its sunset date in x-sunset, which the
//   compatibility check reads;
// - its parameters and body: the input fields its path names are path
//   parameters, and the rest are the query of a GET or DELETE and the JSON
//   body of any other method;
// - the optional Idempotency-Key header on a POST;
// - its answer, 200 with its output, or 202 with the proposal for a
//   commitment, and its errors as RFC 9457 problems;
// - x-tiehall-cli with the CLI's command, on each operation the CLI offers,
//   from which the CLI builds its request commands (design.md, Self-hosting
//   decisions: S16).
// Response schemas never set `additionalProperties: false`, so a response can
// gain a field without breaking a strictly generated client, and a schema used
// in requests and responses, such as the packet, keeps one component id. The
// document holds no data of any install and is the same for every reader.

/** The API's version while it is beta: 0.N.0, bumped with every breaking change (D28 #27). */
export const API_VERSION = "0.1.0";

const BETA_VERSION = /^0\.(0|[1-9]\d*)\.0$/;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface OpenApiOptions {
  /** info.version, of the form 0.N.0 while the API is beta. */
  version?: string;
}

/** The document as JSON. */
export type OpenApiDocument = Record<string, unknown>;

/** An RFC 9457 problem details object, as the error model gives it (public-api: Errors are RFC 9457 problem details). */
const problem = z
  .object({
    type: z.string().meta({ description: "The problem type: a URI under https://tiehall.com/problems/ that names the kind of refusal." }),
    title: z.string().meta({ description: "A short summary of the kind of refusal." }),
    status: z.number().int().meta({ description: "The HTTP status." }),
    detail: z.string().meta({ description: "What happened, in Tiehall's own words." }),
    errors: z
      .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
      .optional()
      .meta({ description: "For input that fails the schema: where it fails." }),
    retryAfter: z.number().int().optional().meta({ description: "For a limit or a shutdown: the seconds to wait, as Retry-After says." }),
  })
  .meta({ id: "Problem", description: "An RFC 9457 problem details object." });

const retryAfter = z.object({ "Retry-After": z.string().meta({ description: "The seconds to wait before retrying." }) });

const idempotencyKey = z.object({
  "Idempotency-Key": z
    .string()
    .optional()
    .meta({
      description:
        "A key of your choice that makes a retried POST run once: a repeat with the same key and body within 24 hours gets the first response, and the same key with another body gets 422 (draft-ietf-httpapi-idempotency-key-header).",
    }),
});

/** The errors every operation can answer with, and those of writes and of POSTs. */
const ERRORS: Readonly<Record<string, string>> = {
  "400": "The input fails the operation's schema, or is outside what the install's settings allow.",
  "401": "The call carries no valid token.",
  "403": "The caller may not take this action.",
  "404": "There is no such operation, or the record the call names does not exist.",
  "429": "A limit is exceeded; retry after the time Retry-After gives.",
  "503": "Setup is not complete, or Tiehall is shutting down.",
};
const WRITE_ERRORS: Readonly<Record<string, string>> = { "409": "The request's state does not allow this action." };
const POST_ERRORS: Readonly<Record<string, string>> = { "422": "The Idempotency-Key was sent with a different body in the last 24 hours." };

export function openApiDocument(catalog: Catalog, options: OpenApiOptions = {}): OpenApiDocument {
  const version = options.version ?? API_VERSION;
  if (!BETA_VERSION.test(version)) throw new Error(`The API's version is ${version}; while the API is beta it has the form 0.N.0.`);
  const paths: ZodOpenApiPathsObject = {};
  for (const definition of catalog.commands) {
    if (!definition.surfaces.includes("rest") || definition.method === undefined || definition.path === undefined) continue;
    const item = (paths[definition.path] ??= {});
    item[definition.method.toLowerCase() as "get"] = operationOf(definition, definition.method);
  }
  return createDocument(
    {
      openapi: "3.1.0",
      info: {
        title: "Tiehall API",
        version,
        description:
          "The REST API of a Tiehall install, under /api/v1. It is beta: each operation carries its stability level, and breaking changes follow the notice rules on the changelog page at /docs/api/changelog.",
      },
      paths,
      components: {
        securitySchemes: {
          bearer: {
            type: "http",
            scheme: "bearer",
            description:
              "An OAuth access token or a personal access token, in the Authorization header; for contract.report, a GitHub Actions OIDC token. Each operation lists the scopes its token needs.",
          },
        },
      },
    },
    {
      // Open objects: a response may gain fields without breaking a strictly generated client.
      override: ({ jsonSchema, io }) => {
        if (io === "output" && jsonSchema.additionalProperties === false) delete jsonSchema.additionalProperties;
      },
    },
  ) as unknown as OpenApiDocument;
}

function operationOf(definition: CommandDefinition, method: string): ZodOpenApiOperationObject {
  const pathKeys = new Set([...(definition.path ?? "").matchAll(/\{([^}]*)\}/g)].map(([, name]) => name ?? ""));
  // The catalog checks that a REST operation's input is an object that holds every parameter its path names.
  const fields = Object.entries((definition.input as z.ZodObject).shape);
  const inPath = z.object(Object.fromEntries(fields.filter(([key]) => pathKeys.has(key))));
  const rest = z.object(Object.fromEntries(fields.filter(([key]) => !pathKeys.has(key))));
  const hasBody = BODY_METHODS.has(method);
  const operation: ZodOpenApiOperationObject & Record<`x-${string}`, unknown> = {
    operationId: definition.id,
    summary: definition.summary,
    security: [{ bearer: [...definition.scopes] }],
    "x-stability-level": definition.stability,
    requestParams: {
      ...(pathKeys.size > 0 ? { path: inPath } : {}),
      ...(!hasBody && Object.keys(rest.shape).length > 0 ? { query: rest } : {}),
      ...(method === "POST" ? { header: idempotencyKey } : {}),
    },
    ...(hasBody && Object.keys(rest.shape).length > 0 ? { requestBody: { content: { "application/json": { schema: rest } } } } : {}),
    responses: responsesOf(definition, method),
  };
  if (definition.deprecated !== undefined) {
    operation.deprecated = true;
    if (definition.deprecated.sunset !== undefined) operation["x-sunset"] = definition.deprecated.sunset;
  }
  if (definition.surfaces.includes("cli")) operation["x-tiehall-cli"] = { command: definition.cliCommand };
  return operation;
}

function responsesOf(definition: CommandDefinition, method: string): ZodOpenApiResponsesObject {
  const responses: ZodOpenApiResponsesObject = {
    [definition.commitment ? "202" : "200"]: {
      description: definition.commitment
        ? "The commitment became a proposal, which takes effect once the people it needs have confirmed it in the web UI."
        : "The operation's result.",
      content: { "application/json": { schema: definition.output } },
    },
  };
  const errors = { ...ERRORS, ...(method === "GET" ? {} : WRITE_ERRORS), ...(method === "POST" ? POST_ERRORS : {}) };
  for (const [status, description] of Object.entries(errors)) {
    responses[status as "400"] = {
      description,
      ...(status === "429" || status === "503" ? { headers: retryAfter } : {}),
      content: { "application/problem+json": { schema: problem } },
    };
  }
  return responses;
}

/** The document as it is committed: every object's keys sorted, two-space indents and a final newline. */
export function serializeDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
