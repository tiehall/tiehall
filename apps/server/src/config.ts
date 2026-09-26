import { readFileSync } from "node:fs";
import { secretKeyProblem } from "@tiehall/commands";

// Configuration comes only from environment variables and from secret files
// named by *_FILE variables (design.md decision 1). Any setting can come from a
// file, and a secret should: then it never appears in the environment, in
// `docker inspect` or in a Compose file. Error messages name settings and
// files, never values.

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  /** The database to connect to. The password may be left out of it and given as DATABASE_PASSWORD. */
  databaseUrl: string;
  databasePassword?: string;
  /**
   * The app role, which only the migrate role reads: it connects as the
   * database owner and creates or updates this role. APP_DATABASE_URL names the
   * role as its user; the password may be left out of it and given as
   * APP_DATABASE_PASSWORD.
   */
  appRole?: { name: string; password: string };
  /** The port the web server listens on. */
  port: number;
  /**
   * TIEHALL_SECRET_KEY, which encrypts the integration secrets Tiehall stores
   * (self-host-install: Stored integration secrets are encrypted). It lives
   * only in the install's settings, never in the database. Task 5.1 makes it
   * required.
   */
  secretKey?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function readConfig(env: Environment): Config {
  const databaseUrl = required(env, "DATABASE_URL");
  if (!isPostgresUrl(databaseUrl)) throw new ConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL.");
  const databasePassword = optional(env, "DATABASE_PASSWORD");
  const appRole = readAppRole(env);
  const port = Number(optional(env, "PORT") ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("PORT must be a whole number from 1 to 65535.");
  }
  const secretKey = optional(env, "TIEHALL_SECRET_KEY");
  const problem = secretKey === undefined ? undefined : secretKeyProblem(secretKey);
  if (problem !== undefined) throw new ConfigError(problem);
  return {
    databaseUrl,
    ...(databasePassword === undefined ? {} : { databasePassword }),
    ...(appRole === undefined ? {} : { appRole }),
    port,
    ...(secretKey === undefined ? {} : { secretKey }),
  };
}

function readAppRole(env: Environment): Config["appRole"] {
  const appDatabaseUrl = optional(env, "APP_DATABASE_URL");
  if (appDatabaseUrl === undefined) return undefined;
  if (!isPostgresUrl(appDatabaseUrl)) throw new ConfigError("APP_DATABASE_URL must be a postgres:// or postgresql:// URL.");
  const url = new URL(appDatabaseUrl);
  const name = decodeURIComponent(url.username);
  if (name === "") throw new ConfigError("APP_DATABASE_URL must name the app role as its user.");
  const password = optional(env, "APP_DATABASE_PASSWORD") ?? decodeURIComponent(url.password);
  if (password === "") {
    throw new ConfigError(
      "The app role has no password. Set APP_DATABASE_PASSWORD or APP_DATABASE_PASSWORD_FILE, or give it in APP_DATABASE_URL.",
    );
  }
  return { name, password };
}

function required(env: Environment, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new ConfigError(`${name} is not set. Set ${name} or ${name}_FILE.`);
  return value;
}

/** A setting from NAME, or from the file that NAME_FILE names, with one trailing newline removed. */
function optional(env: Environment, name: string): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new ConfigError(`${name}_FILE names ${file}, which cannot be read (${code}).`);
    }
  }
  return direct === "" ? undefined : direct;
}

function isPostgresUrl(value: string): boolean {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
