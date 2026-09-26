import type pg from "pg";
import { TIEHALL_SCHEMA } from "./database-roles.ts";

// The org id lint (teams-and-roles: One org per install; design.md,
// Self-hosting decisions: S1). v1 has no tenant layer, but every table except
// `orgs` keeps an org_id: never null, first in the primary key, such as
// (org_id, id), referencing orgs (id), and part of every foreign key to another
// table, such as (org_id, team_id) to teams (org_id, id). Then a later version
// can hold several orgs through migrations alone, and a row can never point at
// another org's row. It reads the catalog, so it sees every table the
// migrations made. The job queue's schema belongs to pg-boss and is left out.

type Queryable = Pick<pg.ClientBase, "query">;

const ORGS = "public.orgs";

interface Table {
  oid: number;
  name: string;
  org_id_not_null: boolean | null;
}

interface Constraint {
  table_oid: number;
  name: string;
  kind: "p" | "f";
  target: string | null;
  columns: string[];
  target_columns: string[];
}

/** Each way a table in the app's schemas breaks the rule, as a sentence; none when all keep it. */
export async function lintOrgIds(client: Queryable, schemas: readonly string[] = [TIEHALL_SCHEMA]): Promise<string[]> {
  const tables = await client.query<Table>(
    `SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS name,
            (SELECT a.attnotnull FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS org_id_not_null
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[]) AND format('%I.%I', n.nspname, c.relname) <> $2
      ORDER BY 2`,
    [schemas, ORGS],
  );
  const constraints = await client.query<Constraint>(
    `SELECT con.conrelid::int AS table_oid, con.conname AS name, con.contype AS kind,
            (SELECT format('%I.%I', tn.nspname, tc.relname)
               FROM pg_class tc JOIN pg_namespace tn ON tn.oid = tc.relnamespace
              WHERE tc.oid = con.confrelid) AS target,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.position) AS columns,
            ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, position)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.position)
              AS target_columns
       FROM pg_constraint con
      WHERE con.contype IN ('p', 'f') AND con.conrelid = ANY($1::oid[])
      ORDER BY con.conname`,
    [tables.rows.map(({ oid }) => oid)],
  );

  const problems: string[] = [];
  for (const table of tables.rows) {
    if (table.org_id_not_null === null) {
      problems.push(`${table.name} has no org_id column; every table but orgs belongs to the install's org.`);
      continue;
    }
    if (!table.org_id_not_null) problems.push(`${table.name}: org_id may be null.`);
    const own = constraints.rows.filter(({ table_oid }) => table_oid === table.oid);
    const key = own.find(({ kind }) => kind === "p");
    if (key === undefined) problems.push(`${table.name} has no primary key; it should start with org_id, as (org_id, id) does.`);
    else if (key.columns[0] !== "org_id") {
      problems.push(
        `${table.name}: its primary key (${key.columns.join(", ")}) does not start with org_id, as (org_id, id) does.`,
      );
    }
    const foreignKeys = own.filter(({ kind }) => kind === "f");
    if (!foreignKeys.some(({ target, columns, target_columns }) => isOrgReference(target, columns, target_columns))) {
      problems.push(`${table.name}: org_id does not reference orgs (id).`);
    }
    for (const { name, target, columns, target_columns } of foreignKeys) {
      if (target === ORGS) continue;
      const position = columns.indexOf("org_id");
      if (position === -1 || target_columns[position] !== "org_id") {
        problems.push(
          `${table.name}: foreign key ${name} (${columns.join(", ")}) to ${target} ` +
            `(${target_columns.join(", ")}) leaves out org_id; it should be (org_id, ${columns.join(", ")}) to ` +
            `(org_id, ${target_columns.join(", ")}).`,
        );
      }
    }
  }
  return problems;
}

function isOrgReference(target: string | null, columns: string[], targetColumns: string[]): boolean {
  return target === ORGS && columns.length === 1 && columns[0] === "org_id" && targetColumns[0] === "id";
}
