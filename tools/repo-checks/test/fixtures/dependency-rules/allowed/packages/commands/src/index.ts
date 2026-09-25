// Allowed: packages/commands imports packages/db.
import { orgs } from "../../db/src/index.ts";
import type { Org } from "@tiehall/db";

export const first: Org | undefined = orgs[0];
