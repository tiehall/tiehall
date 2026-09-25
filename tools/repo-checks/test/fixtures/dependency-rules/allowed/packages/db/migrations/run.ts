// Allowed: the migrations import packages/db.
import { orgs } from "../src/index.ts";

export const count: number = orgs.length;
