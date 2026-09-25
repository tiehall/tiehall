import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";

// The database roles (design.md, Technical decisions: T4; self-host-install:
// Only the migrate step holds the database owner's credentials). The migrate
// step connects as the database owner, which owns every table, and creates or
// updates the app role that web, worker, all and the operator commands connect
// as. The app role owns nothing, so it can never alter or drop a table or the
// trigger that keeps the event tables append-only (activity-log: The activity
// log is append-only); it changes the data of the app's tables, and may only
// insert into and read the event tables.

/** The schemas whose tables the app role reads and changes. */
export const APP_SCHEMAS: readonly string[] = ["public"];

/** The event tables, as schema.table: the app role may only insert into them and read them. */
export const EVENT_TABLES: readonly string[] = ["public.events"];

export interface AppRole {
  /** The role's name, which is the user in the app's database URL. */
  name: string;
  password: string;
}

export interface AppRoleGrants {
  schemas: readonly string[];
  appendOnlyTables: readonly string[];
}

/** A setting of the app role that the migrate step refuses; its message says why, and names no secret. */
export class DatabaseRoleError extends Error {
  override name = "DatabaseRoleError";
}

type Queryable = Pick<pg.ClientBase, "query">;

/** Role attributes that would let the app role do more than change data. */
const FORBIDDEN_ATTRIBUTES = [
  ["rolsuper", "SUPERUSER"],
  ["rolcreaterole", "CREATEROLE"],
  ["rolcreatedb", "CREATEDB"],
  ["rolreplication", "REPLICATION"],
  ["rolbypassrls", "BYPASSRLS"],
] as const;

type RoleAttributes = Record<(typeof FORBIDDEN_ATTRIBUTES)[number][0], boolean>;

/**
 * Creates the app role, or updates its password when it exists, and sets its
 * rights to exactly what the app needs, in one transaction on the owner's
 * connection. It runs on every migrate, after the migrations, so the rights
 * follow the tables the migrations created. It refuses a role that is the owner,
 * that can become the owner, or that holds any attribute beyond logging in.
 */
export async function setUpAppRole(
  owner: Queryable,
  role: AppRole,
  grants: AppRoleGrants = { schemas: APP_SCHEMAS, appendOnlyTables: EVENT_TABLES },
): Promise<void> {
  if (role.password === "") throw new DatabaseRoleError("The app role's password is empty.");
  await owner.query("BEGIN");
  try {
    await setUp(owner, role, grants);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function setUp(owner: Queryable, role: AppRole, grants: AppRoleGrants): Promise<void> {
  const session = (
    await owner.query<{ current: string; database: string; database_owner: string }>(
      `SELECT current_user AS current, current_database() AS database, pg_get_userbyid(datdba) AS database_owner
         FROM pg_database WHERE datname = current_database()`,
    )
  ).rows[0];
  if (session === undefined) throw new DatabaseRoleError("The current database could not be found.");
  const owners = [...new Set([session.current, session.database_owner])];
  for (const name of owners) {
    if (role.name === name) throw new DatabaseRoleError(`The app role must not be the database owner (${name}).`);
  }

  const app = pg.escapeIdentifier(role.name);
  const secret = pg.escapeLiteral(scramSha256Secret(role.password));
  const existing = (
    await owner.query<RoleAttributes>(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [role.name],
    )
  ).rows[0];
  if (existing === undefined) {
    // A new role holds no attribute beyond LOGIN.
    await owner.query(`CREATE ROLE ${app} LOGIN PASSWORD ${secret}`);
  } else {
    const held = FORBIDDEN_ATTRIBUTES.filter(([column]) => existing[column]).map(([, attribute]) => attribute);
    if (held.length > 0) throw new DatabaseRoleError(`The app role ${role.name} must not have ${held.join(", ")}.`);
    await owner.query(`ALTER ROLE ${app} LOGIN PASSWORD ${secret}`);
  }
  for (const name of owners) {
    const member = await owner.query<{ member: boolean }>("SELECT pg_has_role($1, $2, 'MEMBER') AS member", [
      role.name,
      name,
    ]);
    if (member.rows[0]?.member) {
      throw new DatabaseRoleError(`The app role ${role.name} must not be a member of the database owner (${name}).`);
    }
  }

  await owner.query(grantStatements(app, session.database, await tablesOf(owner, grants.schemas), grants));

  const owned = await owner.query<{ object: string }>(
    `SELECT 'table ' || c.oid::regclass::text AS object FROM pg_class c WHERE c.relowner = $1::regrole
     UNION ALL SELECT 'schema ' || quote_ident(n.nspname) FROM pg_namespace n WHERE n.nspowner = $1::regrole
     ORDER BY object`,
    [app],
  );
  if (owned.rows.length > 0) {
    const objects = owned.rows.map(({ object }) => object).join(", ");
    throw new DatabaseRoleError(`The app role ${role.name} must own nothing, but owns ${objects}.`);
  }
}

interface Table {
  schema: string;
  name: string;
}

async function tablesOf(owner: Queryable, schemas: readonly string[]): Promise<{ schemas: string[]; tables: Table[] }> {
  const present = await owner.query<{ schema: string }>(
    "SELECT nspname AS schema FROM pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname",
    [schemas],
  );
  const tables = await owner.query<Table>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
      ORDER BY n.nspname, c.relname`,
    [schemas],
  );
  return { schemas: present.rows.map(({ schema }) => schema), tables: tables.rows };
}

/**
 * The app role's rights, set from scratch on every run: whatever it held
 * before is revoked first, so a right it should no longer have does not linger.
 * No one but the owner may create objects in the database or its schemas, so
 * the app role can never come to own a table. TRUNCATE is never granted: it
 * would bypass the triggers that refuse deletes.
 */
function grantStatements(
  app: string,
  database: string,
  { schemas, tables }: { schemas: string[]; tables: Table[] },
  { appendOnlyTables }: AppRoleGrants,
): string {
  const appendOnly = new Set(appendOnlyTables);
  const statements = [
    `REVOKE CREATE ON DATABASE ${pg.escapeIdentifier(database)} FROM PUBLIC, ${app}`,
    `GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO ${app}`,
  ];
  for (const schema of schemas.map((name) => pg.escapeIdentifier(name))) {
    statements.push(
      `REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${app}`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${app}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${app}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${app}`,
    );
  }
  for (const { schema, name } of tables) {
    const table = `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
    const rights = appendOnly.has(`${schema}.${name}`) ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE, DELETE";
    statements.push(`REVOKE ALL ON TABLE ${table} FROM ${app}`, `GRANT ${rights} ON TABLE ${table} TO ${app}`);
  }
  return statements.map((statement) => `${statement};`).join("\n");
}

/**
 * The SCRAM-SHA-256 secret Postgres stores for a password, computed here so
 * the password itself never reaches the server, its logs or its statistics.
 * Postgres stores a secret given in this form as it is. The password goes
 * through the same SASLprep mapping the Postgres driver applies when it logs
 * in (RFC 4013: non-ASCII spaces to a space, characters mapped to nothing
 * removed, then NFKC), and the salt length and iteration count are Postgres's
 * defaults.
 */
export function scramSha256Secret(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(saslPrep(password), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

function saslPrep(password: string): string {
  // RFC 3454 table C.1.2 (non-ASCII spaces) and table B.1 (commonly mapped to nothing).
  const nonAsciiSpace = /[   -​  　]/g;
  // eslint-disable-next-line no-misleading-character-class
  const mappedToNothing = /[­͏᠆᠋᠌᠍‌‍⁠︀-️﻿]/g;
  return password.replace(nonAsciiSpace, " ").replace(mappedToNothing, "").normalize("NFKC");
}
