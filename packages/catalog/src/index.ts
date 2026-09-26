// @tiehall/catalog: The command definitions and their zod schemas. Holds no database code, and no Apache-2.0 client piece imports it.
export {
  COMMAND_SURFACES,
  defineCommand,
  HTTP_METHODS,
  SCOPES,
  STABILITY_LEVELS,
  type CommandDefinition,
  type CommandInput,
  type CommandOutput,
  type CommandSurface,
  type Deprecation,
  type HttpMethod,
  type Scope,
  type StabilityLevel,
} from "./command.ts";
export { CatalogError, catalogProblems, defineCatalog, type Catalog } from "./catalog.ts";
export { CATALOG } from "./commands.ts";
