// Fixture: a type-only import still couples the web app to packages/db.
import type { Org } from "@tiehall/db";

export type WebOrg = Org;
