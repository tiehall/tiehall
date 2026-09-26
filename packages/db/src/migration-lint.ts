import { parseDirectives, readMigrationTexts } from "./migration-files.ts";

// The migration lint (self-host-install: Migrations expand, then contract;
// design.md, Self-hosting decisions: S12). A release's migrations only add to
// the schema, so the previous release's image still runs on it and going back
// only takes switching the image. A step that removes or rewrites (dropping or
// renaming a table or a column, setting NOT NULL, adding a NOT NULL column the
// previous release's inserts leave out, or rewriting a table) must be marked
// `-- migrate: contract after <release>`, naming the release of the expand step
// it follows. No migration changes data: backfills run as batched background
// jobs. The lint reads the SQL as drizzle-kit and people write it, with
// comments, string literals, quoted identifiers and dollar-quoted bodies set
// apart, so a word inside one of them is never taken for a statement.

export interface LintProblem {
  migration: string;
  message: string;
}

export interface LintResult {
  migrations: number;
  problems: LintProblem[];
}

const CONTRACT_ONLY = "which only a contract step may do";

export function lintMigrationFolder(folder: string): LintResult {
  const migrations = readMigrationTexts(folder);
  return { migrations: migrations.length, problems: migrations.flatMap(({ id, text }) => lintMigration(id, text)) };
}

export function lintMigration(id: string, text: string): LintProblem[] {
  const { directives, problems } = parseDirectives(text);
  const contract = directives.some((directive) => directive.kind === "contract");
  const found = problems.map((message) => ({ migration: id, message }));
  for (const statement of splitStatements(text)) {
    for (const { what, contractOnly } of classify(statement.shape)) {
      if (contractOnly && contract) continue;
      const rule = contractOnly ? CONTRACT_ONLY : "which a migration never does";
      found.push({ migration: id, message: `${what}, ${rule}: ${abbreviate(statement.display)}` });
    }
  }
  return found;
}

interface Finding {
  what: string;
  contractOnly: boolean;
}

const IDENTIFIER = String.raw`(?:""|[A-Z_][A-Z0-9_$]*)`;
const NAME = String.raw`${IDENTIFIER}(?:\.${IDENTIFIER})*`;
const ALTER_TABLE = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${NAME} ?\*? (.*)$`);
const ALTER_COLUMN_TYPE = new RegExp(String.raw`^ALTER (?:COLUMN )?${IDENTIFIER} (?:SET DATA )?TYPE\b`);
const SET_NOT_NULL = new RegExp(String.raw`^ALTER (?:COLUMN )?${IDENTIFIER} SET NOT NULL\b`);
const ADD_COLUMN = new RegExp(
  String.raw`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b)${IDENTIFIER} (.*)$`,
);
/** Column defaults that Postgres must compute for every existing row, which rewrites the table. */
const VOLATILE_DEFAULT =
  /\bDEFAULT\b.*\b(?:GEN_RANDOM_UUID|UUIDV4|UUIDV7|UUID_GENERATE_V1|UUID_GENERATE_V4|GEN_RANDOM_BYTES|RANDOM|CLOCK_TIMESTAMP|TIMEOFDAY|NEXTVAL) ?\(/;

/** What a statement does that an expand step may not, from its shape: upper case, literals and quoted names blanked. */
function classify(shape: string): Finding[] {
  const contract = (what: string): Finding => ({ what, contractOnly: true });
  if (/^(?:INSERT|UPDATE|DELETE|MERGE|COPY|TRUNCATE|DO)\b/.test(shape) || /^WITH\b.*\b(?:INSERT|UPDATE|DELETE|MERGE)\b/.test(shape)) {
    return [{ what: "changes data", contractOnly: false }];
  }
  if (/^DROP TABLE\b/.test(shape)) return [contract("drops a table")];
  if (/^DROP SCHEMA\b/.test(shape)) return [contract("drops a schema and its tables")];
  if (/^(?:CLUSTER\b|VACUUM\b.*\bFULL\b)/.test(shape)) return [contract("rewrites the table")];
  const actions = ALTER_TABLE.exec(shape)?.[1];
  if (actions === undefined) return [];
  return splitTopLevel(actions).flatMap((action): Finding[] => {
    if (/^DROP (?!CONSTRAINT\b)/.test(action)) return [contract("drops a column")];
    if (/^RENAME (?!CONSTRAINT\b)/.test(action)) return [contract("renames a table or a column")];
    if (ALTER_COLUMN_TYPE.test(action)) return [contract("rewrites the table")];
    if (SET_NOT_NULL.test(action)) return [contract("sets NOT NULL on an existing column")];
    if (/^SET (?:LOGGED|UNLOGGED|TABLESPACE|ACCESS METHOD)\b/.test(action)) return [contract("rewrites the table")];
    const column = ADD_COLUMN.exec(action)?.[1];
    if (column === undefined) return [];
    if (
      /^(?:SMALL|BIG)?SERIAL[248]?\b/.test(column) ||
      /\bGENERATED\b.*\b(?:STORED|IDENTITY)\b/.test(column) ||
      VOLATILE_DEFAULT.test(column)
    ) {
      return [contract("rewrites the table")];
    }
    if (/\bNOT NULL\b/.test(column) && !/\bDEFAULT\b/.test(column)) {
      return [contract("adds a NOT NULL column without a default")];
    }
    return [];
  });
}

/** The comma-separated parts of a list, split only outside parentheses. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

export interface Statement {
  /** The statement without its comments, on one line, as the lint quotes it. */
  display: string;
  /** The same in upper case, with every literal as '' or $$ and every quoted name as "", for matching keywords. */
  shape: string;
}

/**
 * Splits SQL into statements at the semicolons outside comments, string
 * literals, quoted identifiers and dollar-quoted bodies. drizzle-kit's
 * statement breakpoints are line comments, so they fall away with the rest.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let display = "";
  let shape = "";
  const flush = () => {
    const text = oneLine(display);
    if (text !== "") statements.push({ display: text, shape: oneLine(shape).toUpperCase() });
    display = "";
    shape = "";
  };
  const identifierBefore = (index: number) => index > 0 && /[A-Za-z0-9_$]/.test(sql[index - 1] ?? "");

  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      display += " ";
      shape += " ";
    } else if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) (depth++, (index += 2));
        else if (sql.startsWith("*/", index)) (depth--, (index += 2));
        else index++;
      }
      display += " ";
      shape += " ";
    } else if (char === "'" || char === '"') {
      // An E'…' string takes backslash escapes; a doubled quote escapes itself in every kind.
      const backslashes = char === "'" && /[Ee]/.test(sql[index - 1] ?? "") && !identifierBefore(index - 1);
      let end = index + 1;
      while (end < sql.length) {
        if (backslashes && sql[end] === "\\") end += 2;
        else if (sql[end] === char && sql[end + 1] === char) end += 2;
        else if (sql[end] === char) break;
        else end++;
      }
      display += sql.slice(index, end + 1);
      shape += char === "'" ? "''" : '""';
      index = end + 1;
    } else if (char === "$" && !identifierBefore(index) && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0] ?? "$$";
      const close = sql.indexOf(tag, index + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      display += sql.slice(index, end);
      shape += "$$";
      index = end;
    } else if (char === ";") {
      flush();
      index++;
    } else {
      display += char;
      shape += char;
      index++;
    }
  }
  flush();
  return statements;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function abbreviate(text: string): string {
  return text.length <= 100 ? text : `${text.slice(0, 100).trimEnd()}…`;
}
