// Allowed: the Apache-2.0 CLI imports the other Apache-2.0 pieces, npm packages
// and Node built-ins.
import { readFileSync } from "node:fs";
import createFetchClient from "openapi-fetch";
import { createClient } from "../../client/src/index.ts";
import type { Packet } from "@tiehall/packet";

export const client: unknown = createClient;
export const fetchClient: unknown = createFetchClient;
export const read: typeof readFileSync = readFileSync;
export type CliPacket = Packet;
