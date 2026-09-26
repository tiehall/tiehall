import { defineCatalog } from "./catalog.ts";

// Tiehall's operations, one definition each (public-api: One definition per
// operation, the same on every surface). Each task that builds an operation
// adds its definition here, and registering the catalog checks it.
export const CATALOG = defineCatalog([]);
