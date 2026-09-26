// The Drizzle schema of the app's tables (design.md, Technical decisions: T4).
// drizzle-kit generates the migrations in ../migrations from it with
// `pnpm --filter @tiehall/db generate --name <what-it-does>`, and a test fails
// when the two disagree. Columns name their SQL names explicitly, in snake_case.
// Every table after `orgs` carries `org_id` (teams-and-roles: One org per
// install); tasks 4.5 and on add the tables.
export {};
