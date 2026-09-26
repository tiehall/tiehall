import { defineConfig } from "drizzle-kit";

// drizzle-kit writes the migrations from the schema: `pnpm --filter @tiehall/db generate --name <what-it-does>`,
// or `generate --custom --name <what-it-does>` for a migration written by hand, such as one marked
// `-- migrate: no-transaction` for CREATE INDEX CONCURRENTLY.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
