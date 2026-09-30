// @tiehall/client: the REST client of a Tiehall install, generated from the
// OpenAPI document (public-api: The client package `@tiehall/client`;
// design.md, Technical decisions: T10). It is openapi-fetch, typed by the
// paths and operations that `pnpm client:generate` writes from
// openapi/v1.json, together with the command table the tiehall CLI builds its
// request commands from. It is licensed under Apache-2.0 and imports no
// server code (public-api: The license map); it stays unpublished until
// someone asks to build on the API.

import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/openapi.ts";

export type { components, operations, paths } from "./generated/openapi.ts";
export { COMMAND_TABLE } from "./generated/commands.ts";
export type { CommandEntry, CommandField, CommandValue, FieldType } from "./command-table.ts";

/** A client of one install's /api/v1. */
export type TiehallClient = Client<paths>;

export interface TiehallClientOptions {
  /** The install's URL, TIEHALL_URL, such as https://tiehall.example.com. */
  baseUrl: string;
  /** The headers every call carries, such as its Authorization. */
  headers?: Record<string, string>;
  /** The fetch that sends each call; the global fetch unless given. */
  fetch?: (request: Request) => Promise<Response>;
}

/** A client of the install at this URL. */
export function createTiehallClient(options: TiehallClientOptions): TiehallClient {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
