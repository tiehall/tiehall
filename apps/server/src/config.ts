import { readFileSync } from "node:fs";

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
  /** The port the web server listens on. */
  port: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function readConfig(env: Environment): Config {
  const databaseUrl = required(env, "DATABASE_URL");
  if (!isPostgresUrl(databaseUrl)) throw new ConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL.");
  const databasePassword = optional(env, "DATABASE_PASSWORD");
  const port = Number(optional(env, "PORT") ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("PORT must be a whole number from 1 to 65535.");
  }
  return { databaseUrl, ...(databasePassword === undefined ? {} : { databasePassword }), port };
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
