// The CLI's command table (agent-surfaces: CLI request commands; public-api:
// The license map; design.md, Technical decisions: T3 and T10; design.md,
// Self-hosting decisions: S16). The tiehall CLI is Apache-2.0 and may not
// import the command catalog, which is server code under AGPL-3.0, so it
// builds its request commands from the OpenAPI document instead: every
// operation the CLI offers states its commands in its x-tiehall-cli
// extension, and `pnpm client:generate` reads them into this table, beside the
// client's types, with what the CLI needs to build each call from the
// document: the operation's method and path, and each field it takes, where
// the call carries it and the JSON types it takes.

/** A JSON type a field takes. */
export type FieldType = "string" | "integer" | "number" | "boolean" | "object" | "array" | "null";

/** A value a CLI command sets in its operation's input, such as the kind of a message. */
export type CommandValue = string | number | boolean;

/** A field of an operation, as a command gives it. */
export interface CommandField {
  /** The input field, such as questionId, or the header, such as If-Match. */
  readonly name: string;
  /** Where a call carries it: in the path, the query string, a header or the JSON body. */
  readonly in: "path" | "query" | "header" | "body";
  /** The JSON types it takes; none when the document does not say. */
  readonly types: readonly FieldType[];
  /** The only values it takes, where the document lists them, such as a request's states. */
  readonly values?: readonly (string | number | boolean | null)[];
  /** Whether every call of the command names it. */
  readonly required: boolean;
  readonly description?: string;
}

/** A command of the CLI, and the operation it runs. */
export interface CommandEntry {
  /** One or more lower-case words, such as get, link-pr or "contract report". */
  readonly command: string;
  /** The operation's id, such as requests.claim. */
  readonly operationId: string;
  /** The operation's summary, in Tiehall's own words. */
  readonly summary: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The operation's path, such as /api/v1/requests/{key}/claim. */
  readonly path: string;
  /** The operation's stability level: alpha, beta or stable. */
  readonly stability: string;
  /** The fields the command takes as positional arguments, in this order. */
  readonly arguments: readonly string[];
  /** The input the command sets itself; it offers no option for these fields. */
  readonly input: Readonly<Record<string, CommandValue>>;
  /** The input the command sets unless an option gives another value. */
  readonly defaults: Readonly<Record<string, CommandValue>>;
  /** Every field the operation takes, for the input the command sets itself: its path, query, body and headers. */
  readonly fields: readonly CommandField[];
  /** Whether a call may make a commitment, which the operation answers with 202 and the proposal it became. */
  readonly proposes: boolean;
}
