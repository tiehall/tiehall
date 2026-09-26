import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The migrations folder that drizzle-kit writes (design.md, Technical
// decisions: T4): meta/_journal.json lists the migrations in order, and each
// <tag>.sql holds its statements, separated by statement breakpoints. A
// migration may start with directive comments:
//   -- migrate: no-transaction
// runs the migration's statements one by one outside a transaction, as
// CREATE INDEX CONCURRENTLY needs; each statement then sits between breakpoints
// of its own.
//   -- migrate: contract after 1.3.0
// marks a contract step, which may drop, rename or rewrite what the expand
// step of the named release replaced (self-host-install: Migrations expand,
// then contract). The migration lint refuses such a step without the mark.

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
  /** For a contract step, the release of the expand step it follows. */
  contractAfter?: string;
}

export type Directive = { kind: "no-transaction" } | { kind: "contract"; after: string };

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Reads the migrations of a folder in journal order. */
export function readMigrations(folder: string): Migration[] {
  return readMigrationTexts(folder).map(({ id, text }) => parseMigration(id, text));
}

/** The text of each migration of a folder, in journal order. */
export function readMigrationTexts(folder: string): { id: string; text: string }[] {
  const journal = JSON.parse(readFile(folder, join("meta", "_journal.json"))) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => ({ id: tag, text: readFile(folder, `${tag}.sql`) }));
}

export function parseMigration(id: string, text: string): Migration {
  const { directives, problems } = parseDirectives(text);
  if (problems[0] !== undefined) throw new MigrationError(`Migration ${id} ${problems[0]}.`);
  const contract = directives.find((directive) => directive.kind === "contract");
  return {
    id,
    hash: createHash("sha256").update(text).digest("hex"),
    statements: text
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement !== ""),
    transactional: !directives.some((directive) => directive.kind === "no-transaction"),
    ...(contract === undefined ? {} : { contractAfter: contract.after }),
  };
}

/** The `-- migrate: …` comments among the comment lines a migration starts with, and what is wrong with them. */
export function parseDirectives(text: string): { directives: Directive[]; problems: string[] } {
  const directives: Directive[] = [];
  const problems: string[] = [];
  for (const line of text.split("\n").map((each) => each.trim())) {
    if (line === "") continue;
    if (!line.startsWith("--") || line.startsWith(STATEMENT_BREAKPOINT)) break;
    const directive = /^--\s*migrate:\s*(.*)$/.exec(line)?.[1]?.trim();
    if (directive === undefined) continue;
    const contract = /^contract\b(.*)$/.exec(directive);
    if (directive === "no-transaction") directives.push({ kind: "no-transaction" });
    else if (contract === null) problems.push(`has an unknown directive "${line}"`);
    else {
      const after = /^\s+after\s+(\d+\.\d+\.\d+)$/.exec(contract[1] ?? "")?.[1];
      if (after === undefined) {
        problems.push(
          `has a malformed directive "${line}"; a contract step names the release of the expand step it follows, ` +
            'as in "-- migrate: contract after 1.3.0"',
        );
      } else directives.push({ kind: "contract", after });
    }
  }
  return { directives, problems };
}

function readFile(folder: string, file: string): string {
  try {
    return readFileSync(join(folder, file), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new MigrationError(`The migrations in ${folder} cannot be read: ${file} is missing or unreadable (${code}).`);
  }
}
