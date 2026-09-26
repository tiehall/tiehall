import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The migrations folder that drizzle-kit writes (design.md, Technical
// decisions: T4): meta/_journal.json lists the migrations in order, and each
// <tag>.sql holds its statements, separated by statement breakpoints. A
// migration may start with directive comments for the runner:
//   -- migrate: no-transaction
// runs the migration's statements one by one outside a transaction, as
// CREATE INDEX CONCURRENTLY needs; each statement then sits between breakpoints
// of its own.

export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** A problem with the migrations or with applying them; its message says which migration and why. */
export class MigrationError extends Error {
  override name = "MigrationError";
}

export interface Migration {
  /** The migration's tag, such as 0003_add_teams: the file name without .sql, and its id in the database. */
  id: string;
  /** The SHA-256 of the file. A migration never changes once it has run. */
  hash: string;
  /** Its statements, as the breakpoints split them. */
  statements: string[];
  /** False for a migration marked `-- migrate: no-transaction`. */
  transactional: boolean;
}

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Reads the migrations of a folder in journal order. */
export function readMigrations(folder: string): Migration[] {
  const journal = JSON.parse(readFile(folder, join("meta", "_journal.json"))) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => parseMigration(tag, readFile(folder, `${tag}.sql`)));
}

export function parseMigration(id: string, text: string): Migration {
  const directives = headerDirectives(text);
  for (const directive of directives) {
    if (directive !== "no-transaction") {
      throw new MigrationError(`Migration ${id} has an unknown directive: -- migrate: ${directive}`);
    }
  }
  return {
    id,
    hash: createHash("sha256").update(text).digest("hex"),
    statements: text
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement !== ""),
    transactional: !directives.includes("no-transaction"),
  };
}

/** The `-- migrate: …` comments among the comment lines a migration starts with. */
function headerDirectives(text: string): string[] {
  const directives: string[] = [];
  for (const line of text.split("\n").map((each) => each.trim())) {
    if (line === "") continue;
    if (!line.startsWith("--") || line.startsWith(STATEMENT_BREAKPOINT)) break;
    const directive = /^--\s*migrate:\s*(.*)$/.exec(line)?.[1];
    if (directive !== undefined) directives.push(directive.trim());
  }
  return directives;
}

function readFile(folder: string, file: string): string {
  try {
    return readFileSync(join(folder, file), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new MigrationError(`The migrations in ${folder} cannot be read: ${file} is missing or unreadable (${code}).`);
  }
}
