import { z } from "zod";
import { createDocument, type ZodOpenApiOperationObject, type ZodOpenApiPathsObject, type ZodOpenApiResponsesObject } from "zod-openapi";
import { bodyLimitOf, MIB } from "./body-limits.ts";
import { restShapesOf, variantsOf, type Catalog, type RestShape } from "./catalog.ts";
import type { CliCommand } from "./command.ts";
import { packet, PACKET_COMPONENT } from "./packet.ts";
import { proposalAnswer } from "./proposals.ts";

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
//   body of any other method; an input with variants keeps them in its body,
//   one schema per variant;
// - the optional Idempotency-Key header on a POST, and the required If-Match
//   header on an operation that adds a packet revision, which answers 412 and
//   428 too, and the ETag header of an answer that states one;
// - its answer, 200 with its output, and for a commitment also 202 with the
//   proposal a call that makes one creates instead, and its errors as RFC
//   9457 problems; an operation whose method takes a body also lists 413,
//   described with the limit on its body, 2 MiB or 16 MiB for
//   contract.report (public-api: Request bodies have a size limit);
// - x-tiehall-cli with the CLI's commands, on each operation the CLI offers,
//   from which the CLI builds its request commands (design.md, Self-hosting
//   decisions: S16): each command's name, the input fields it takes as
//   positional arguments, in order, and the input it sets itself or by
//   default, as { commands: [{ command, arguments, input, defaults }] }.
// Response schemas never set `additionalProperties: false`, so a response can
// gain a field without breaking a strictly generated client, and a schema used
// in requests and responses, such as the packet, keeps one component id: the
// packet is the component Packet wherever an operation takes or returns one
// (handoff-packet: One definition for the schema and the API). The document
// holds no data of any install and is the same for every reader.
//
// Each major version of the API has a document of its own (public-api: After
// graduation, breaking changes go to a new major version; design.md, Where
// the specs leave room: Two API versions): the document of /api/vN lists the
// operations whose current path lies under it and the earlier shapes kept for
// it, each as that shape states it. So the v1 document stays as it was when an
// operation gains a breaking shape under /api/v2 and keeps its earlier shape.

/** The API's version while it is beta: 0.N.0, bumped with every breaking change (D28 #27). */
export const API_VERSION = "0.1.0";

const BETA_VERSION = /^0\.(0|[1-9]\d*)\.0$/;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface OpenApiOptions {
  /** info.version, of the form 0.N.0 while the API is beta. */
  version?: string;
  /** The API's major version whose document this is, such as 2 for /api/v2; 1 unless given. */
  major?: number;
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

/** The If-Match header of an operation that adds a packet revision (public-api: Packet revisions use ETag and If-Match). */
const ifMatchHeader = z.object({
  "If-Match": z.string().meta({
    description:
      'The ETag of the packet\'s current revision, as the packet read returned it, such as "3". Without it the answer is 428; when it is not the current revision\'s, 412, and nothing is added.',
  }),
});

/** The If-Match header of an operation whose input has variants, only some of which add a packet revision. */
const optionalIfMatchHeader = z.object({
  "If-Match": z
    .string()
    .optional()
    .meta({
      description:
        'For a call that changes the packet: the ETag of the packet\'s current revision, as the packet read returned it, such as "3". Such a call without it gets 428, and one whose If-Match is not the current revision\'s gets 412, and nothing changes.',
    }),
});

/** The ETag header of an answer that states one. */
const etagHeader = z.object({
  ETag: z.string().meta({ description: 'The ETag of the revision the answer holds, such as "3", for If-Match on the next write.' }),
});

/** The errors of an operation that adds a packet revision. */
const IF_MATCH_ERRORS: Readonly<Record<string, string>> = {
  "412": "If-Match is not the ETag of the current revision, which someone else has changed since; nothing is added.",
  "428": "The call has no If-Match header, which adding a revision needs; nothing is added.",
};

/** The errors every operation can answer with, and those of writes and of POSTs. */
const ERRORS: Readonly<Record<string, string>> = {
  "400": "The input fails the operation's schema, or is outside what the install's settings allow, or the tiehall CLI that sent it is older than the install supports (upgrade-required).",
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
  const major = options.major ?? 1;
  const paths: ZodOpenApiPathsObject = {};
  // The shapes this major version serves: the operations whose current path lies under it, and the earlier shapes kept for it.
  for (const shape of restShapesOf(catalog).filter((candidate) => candidate.major === major)) {
    const item = (paths[shape.path] ??= {});
    item[shape.method.toLowerCase() as "get"] = operationOf(shape);
  }
  const document = createDocument(
    {
      openapi: "3.1.0",
      info: {
        title: "Tiehall API",
        version,
        description:
          `The REST API of a Tiehall install, under /api/v${major}. It is beta: each operation carries its stability level, and breaking changes follow the notice rules on the changelog page at /docs/api/changelog.`,
      },
      paths,
      components: {
        schemas: { [PACKET_COMPONENT]: packet },
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
  ) as unknown as OpenApiDocument & { components: { schemas: Record<string, unknown> } };
  // The packet component stays only where an operation refers to it.
  if (!JSON.stringify(document["paths"]).includes(`"#/components/schemas/${PACKET_COMPONENT}"`)) {
    delete document.components.schemas[PACKET_COMPONENT];
  }
  return document;
}

/** The operation of one REST shape, as its major version's document states it. */
function operationOf(shape: RestShape): ZodOpenApiOperationObject {
  const { definition, method, input } = shape;
  const pathKeys = new Set([...shape.path.matchAll(/\{([^}]*)\}/g)].map(([, name]) => name ?? ""));
  // The catalog checks that a REST operation's input is an object, or, for a method with a body, variants of
  // objects, and that each variant holds every parameter its path names.
  const variants = variantsOf(input);
  // The field REST fills from If-Match is a header, never a field of the query or the body.
  const fields = Object.entries((variants?.[0] ?? (input as z.ZodObject)).shape).filter(([key]) => key !== definition.ifMatch);
  const inPath = z.object(Object.fromEntries(fields.filter(([key]) => pathKeys.has(key))));
  const rest = z.object(Object.fromEntries(fields.filter(([key]) => !pathKeys.has(key))));
  const hasBody = BODY_METHODS.has(method);
  const notInBody = new Set([...pathKeys, ...(definition.ifMatch === undefined ? [] : [definition.ifMatch])]);
  const body = variants === undefined ? (Object.keys(rest.shape).length > 0 ? rest : undefined) : bodyVariants(input, variants, notInBody);
  // An input with variants takes If-Match only in the variants that change the packet, so there it is optional.
  const ifMatch = variants === undefined ? ifMatchHeader : optionalIfMatchHeader;
  const operation: ZodOpenApiOperationObject & Record<`x-${string}`, unknown> = {
    operationId: definition.id,
    summary: definition.summary,
    security: [{ bearer: [...definition.scopes] }],
    "x-stability-level": shape.stability,
    requestParams: {
      ...(pathKeys.size > 0 ? { path: inPath } : {}),
      ...(!hasBody && Object.keys(rest.shape).length > 0 ? { query: rest } : {}),
      ...(method === "POST" || definition.ifMatch !== undefined
        ? { header: definition.ifMatch === undefined ? idempotencyKey : method === "POST" ? idempotencyKey.extend(ifMatch.shape) : ifMatch }
        : {}),
    },
    ...(hasBody && body !== undefined ? { requestBody: { content: { "application/json": { schema: body } } } } : {}),
    responses: responsesOf(shape),
  };
  if (shape.deprecated !== undefined) {
    operation.deprecated = true;
    if (shape.deprecated.sunset !== undefined) operation["x-sunset"] = shape.deprecated.sunset;
  }
  // The current shape of an operation the CLI offers always names its commands; an earlier shape, those its document named.
  if (definition.surfaces.includes("cli") && (shape.earlier === undefined || shape.cli.length > 0)) {
    operation["x-tiehall-cli"] = { commands: shape.cli.map(cliCommandOf) };
  }
  return operation;
}

/** A CLI command as x-tiehall-cli states it: its name, and its arguments and the input it sets, where it has them. */
function cliCommandOf({ command, arguments: positional, input, defaults }: CliCommand): Record<string, unknown> {
  return {
    command,
    ...(positional === undefined || positional.length === 0 ? {} : { arguments: [...positional] }),
    ...(input === undefined || Object.keys(input).length === 0 ? {} : { input: { ...input } }),
    ...(defaults === undefined || Object.keys(defaults).length === 0 ? {} : { defaults: { ...defaults } }),
  };
}

/**
 * The body of an input with variants: each variant without the fields the
 * path carries, or REST fills from If-Match, in the same kind of union.
 */
function bodyVariants(input: z.ZodType, variants: readonly z.ZodObject[], notInBody: ReadonlySet<string>): z.ZodType {
  const options = variants.map((variant) => {
    const mask: Record<string, true> = Object.fromEntries([...notInBody].filter((key) => Object.hasOwn(variant.shape, key)).map((key) => [key, true as const]));
    return variant.omit(mask as Parameters<typeof variant.omit>[0]);
  }) as [z.ZodObject, ...z.ZodObject[]];
  return input instanceof z.ZodDiscriminatedUnion ? z.discriminatedUnion(input.def.discriminator, options) : z.union(options);
}

function responsesOf(shape: RestShape): ZodOpenApiResponsesObject {
  const { definition, method } = shape;
  const responses: ZodOpenApiResponsesObject = {
    "200": {
      description: definition.commitment ? "The operation's result, for a call that makes no commitment." : "The operation's result.",
      ...(definition.etag === undefined ? {} : { headers: etagHeader }),
      content: { "application/json": { schema: shape.output } },
    },
  };
  if (definition.commitment) {
    responses["202"] = {
      description:
        "The call makes a commitment, which became this proposal instead: it takes effect once the people it needs have confirmed it in the web UI. The answer holds no confirm URL.",
      content: { "application/json": { schema: proposalAnswer } },
    };
  }
  const errors = {
    ...ERRORS,
    ...(method === "GET" ? {} : WRITE_ERRORS),
    ...(method === "POST" ? POST_ERRORS : {}),
    ...(BODY_METHODS.has(method) ? { "413": payloadTooLargeOf(definition) } : {}),
    ...(definition.ifMatch === undefined ? {} : IF_MATCH_ERRORS),
  };
  for (const [status, description] of Object.entries(errors)) {
    responses[status as "400"] = {
      description,
      ...(status === "429" || status === "503" ? { headers: retryAfter } : {}),
      content: { "application/problem+json": { schema: problem } },
    };
  }
  return responses;
}

/** The 413 of an operation that takes a body, which names the limit on its body. */
function payloadTooLargeOf(definition: RestShape["definition"]): string {
  return `The request body is larger than ${bodyLimitOf(definition.id) / MIB} MiB, the limit on this operation's body; it is not read, and nothing runs.`;
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
