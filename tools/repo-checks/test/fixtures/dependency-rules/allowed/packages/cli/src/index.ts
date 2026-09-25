// Allowed: the CLI imports the catalog's public entry point and the client.
import { operationIds } from "../../catalog/src/public.ts";
import { createClient } from "../../client/src/index.ts";
import type { Operation } from "@tiehall/catalog/public";

export const ids: string[] = operationIds;
export const client: unknown = createClient;
export type CliOperation = Operation;
