import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { AppRole, DatabaseConnection } from "@tiehall/db";
import { SECRET_KEY_MIN_LENGTH, secretKeyProblem } from "./secret-box.ts";

// The install settings (self-host-install: One `.env` holds the install
// settings; self-host-install: `TIEHALL_URL` and TLS; design.md, Self-hosting
// decisions: S2). They live in one `.env` next to `compose.yaml`, and Compose
// hands each container the ones it needs as environment variables, under the
// same names. Every setting can also come from the file that its *_FILE form
// names, and a secret should: then it never appears in the environment, in
// `docker inspect` or in a Compose file. An empty value counts as unset, as
// Compose passes a setting that `.env` leaves out.
//
// The app roles (web, worker and all) and the migrate role read different
// settings: only migrate reads the database owner's, so a container that
// runs the app never needs them (self-host-install: Only the migrate step
// holds the database owner's credentials). A missing or unusable setting stops
// the role before it starts, with a message that names the setting and never
// its value.

/** A setting that is missing or cannot be used; its message names the setting and never its value. */
export class SettingsError extends Error {
  override name = "SettingsError";
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** The bundled Postgres of the Compose file, as its superuser, which owns the schema. */
export const BUNDLED_OWNER_DATABASE_URL = "postgres://tiehall@postgres:5432/tiehall";
/** The bundled Postgres of the Compose file, as the app role, which the migrate step creates. */
export const BUNDLED_APP_DATABASE_URL = "postgres://tiehall_app@postgres:5432/tiehall";

export type SmtpTls = "starttls" | "tls" | "none";

/** How Tiehall reaches the SMTP server that sends its email (self-host-install: Optional email through SMTP). */
export interface SmtpSettings {
  host: string;
  port: number;
  /** STARTTLS on the submission port, TLS from the first byte, or none for a relay on a trusted network. */
  tls: SmtpTls;
  user?: string;
  password?: string;
  /** The address email is sent from, alone or with a display name. */
  from: string;
}

/** The settings of the app roles: web, worker and all. */
export interface AppSettings {
  /** The install's public base URL, as its origin, such as https://tiehall.example.com. */
  url: string;
  /** The app role's connection. */
  database: DatabaseConnection;
  /** The port the web server listens on inside the container. */
  port: number;
  /** Encrypts the integration secrets Tiehall stores (self-host-install: Stored integration secrets are encrypted). */
  secretKey: string;
  /** Signs sessions and tokens. */
  authSecret: string;
  /** The reverse proxies whose forwarded headers are trusted: IP addresses, CIDR ranges and host names. */
  trustedProxies: readonly string[];
  /** Whether Client ID Metadata Documents are fetched (self-host-install: The setting that switches metadata-document fetching off). */
  clientMetadataFetch: boolean;
  /** The source a modified server offers its users (self-host-install: The running version links to its source). */
  sourceUrl?: string;
  /** Email is sent only when these are set. */
  smtp?: SmtpSettings;
}

/** The settings of the migrate role. */
export interface MigrateSettings {
  /** The database owner's connection. */
  owner: DatabaseConnection;
  /** The app role that migrate creates or updates. */
  appRole: AppRole;
}

export function readAppSettings(env: Environment): AppSettings {
  const url = readInstallUrl(env);
  const database = readAppDatabase(env);
  const port = readPort(env, "PORT", 3000);
  const secretKey = required(env, "TIEHALL_SECRET_KEY");
  const keyProblem = secretKeyProblem(secretKey);
  if (keyProblem !== undefined) throw new SettingsError(keyProblem);
  const authSecret = required(env, "TIEHALL_AUTH_SECRET");
  if (authSecret.length < SECRET_KEY_MIN_LENGTH) {
    throw new SettingsError(
      `TIEHALL_AUTH_SECRET must hold at least ${SECRET_KEY_MIN_LENGTH} characters, as 32 random bytes in base64url do.`,
    );
  }
  const sourceUrl = optional(env, "TIEHALL_SOURCE_URL");
  if (sourceUrl !== undefined && !/^https?:$/.test(parseUrl(sourceUrl)?.protocol ?? "")) {
    throw new SettingsError("TIEHALL_SOURCE_URL must be an https:// or http:// URL.");
  }
  const smtp = readSmtp(env);
  return {
    url,
    database,
    port,
    secretKey,
    authSecret,
    trustedProxies: readTrustedProxies(env),
    clientMetadataFetch: readClientMetadataFetch(env),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(smtp === undefined ? {} : { smtp }),
  };
}

export function readMigrateSettings(env: Environment): MigrateSettings {
  const ownerUrl = readPostgresUrl(env, "TIEHALL_DATABASE_OWNER_URL", BUNDLED_OWNER_DATABASE_URL);
  const ownerPassword = optional(env, "TIEHALL_DATABASE_OWNER_PASSWORD") ?? decodeURIComponent(new URL(ownerUrl).password);
  if (ownerPassword === "") {
    throw new SettingsError(
      "The database owner has no password. Set TIEHALL_DATABASE_OWNER_PASSWORD or TIEHALL_DATABASE_OWNER_PASSWORD_FILE, " +
        "or give it in TIEHALL_DATABASE_OWNER_URL.",
    );
  }
  const app = readAppDatabase(env);
  return {
    owner: { connectionString: ownerUrl, password: ownerPassword },
    appRole: { name: decodeURIComponent(new URL(app.connectionString).username), password: app.password ?? "" },
  };
}

/** The app role's connection: the bundled Postgres unless TIEHALL_DATABASE_APP_URL names another database. */
export function readAppDatabase(env: Environment): DatabaseConnection & { password: string } {
  const connectionString = readPostgresUrl(env, "TIEHALL_DATABASE_APP_URL", BUNDLED_APP_DATABASE_URL);
  const url = new URL(connectionString);
  if (url.username === "") throw new SettingsError("TIEHALL_DATABASE_APP_URL must name the app role as its user.");
  const password = optional(env, "TIEHALL_DATABASE_APP_PASSWORD") ?? decodeURIComponent(url.password);
  if (password === "") {
    throw new SettingsError(
      "The app role has no password. Set TIEHALL_DATABASE_APP_PASSWORD or TIEHALL_DATABASE_APP_PASSWORD_FILE, " +
        "or give it in TIEHALL_DATABASE_APP_URL.",
    );
  }
  return { connectionString, password };
}

/**
 * TIEHALL_URL, as its origin. It must use HTTPS, except http://localhost with
 * or without a port, for a trial on one machine; http://127.0.0.1 is not a
 * trial URL (design.md, Self-hosting decisions: S2).
 */
function readInstallUrl(env: Environment): string {
  const value = required(env, "TIEHALL_URL");
  const url = parseUrl(value);
  const trial = url?.protocol === "http:" && url.hostname === "localhost";
  if (url === undefined || !(url.protocol === "https:" || trial)) {
    throw new SettingsError(
      "TIEHALL_URL must be an https:// URL, or http://localhost with or without a port for a trial on one machine.",
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "" || /[?#]$/.test(value)) {
    throw new SettingsError(
      "TIEHALL_URL must be the install's base URL, with no path, query, fragment or credentials, such as https://tiehall.example.com.",
    );
  }
  return url.origin;
}

const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function readTrustedProxies(env: Environment): string[] {
  const entries = (optional(env, "TIEHALL_TRUSTED_PROXIES") ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
  for (const entry of entries) {
    if (!isProxyEntry(entry)) {
      throw new SettingsError(
        "TIEHALL_TRUSTED_PROXIES must list IP addresses, CIDR ranges or host names, separated by commas, such as caddy,10.0.0.5.",
      );
    }
  }
  return entries;
}

function isProxyEntry(entry: string): boolean {
  const [address = "", prefix, ...rest] = entry.split("/");
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (prefix === undefined) return family !== 0 || HOST_NAME.test(address);
  if (family === 0 || !/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

function readClientMetadataFetch(env: Environment): boolean {
  const value = optional(env, "TIEHALL_CLIENT_METADATA_FETCH") ?? "on";
  if (value !== "on" && value !== "off") throw new SettingsError("TIEHALL_CLIENT_METADATA_FETCH must be on or off.");
  return value === "on";
}

const SMTP_SETTINGS = ["TIEHALL_SMTP_PORT", "TIEHALL_SMTP_TLS", "TIEHALL_SMTP_USER", "TIEHALL_SMTP_PASSWORD", "TIEHALL_SMTP_FROM"];
const DEFAULT_SMTP_PORTS: Record<SmtpTls, number> = { starttls: 587, tls: 465, none: 25 };
/** An address, alone or after a display name in angle brackets. */
const EMAIL_ADDRESS = /^(?:[^<>@\r\n]*<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

function readSmtp(env: Environment): SmtpSettings | undefined {
  const host = optional(env, "TIEHALL_SMTP_HOST");
  if (host === undefined) {
    if (SMTP_SETTINGS.some((name) => optional(env, name) !== undefined)) {
      throw new SettingsError(
        "TIEHALL_SMTP_HOST is not set, but other SMTP settings are. Set it to send email, or leave them all unset.",
      );
    }
    return undefined;
  }
  const from = optional(env, "TIEHALL_SMTP_FROM");
  if (from === undefined) throw new SettingsError("TIEHALL_SMTP_FROM is not set. Email needs the address it is sent from.");
  if (!EMAIL_ADDRESS.test(from)) {
    throw new SettingsError(
      "TIEHALL_SMTP_FROM must be an email address, such as tiehall@example.com or Tiehall <tiehall@example.com>.",
    );
  }
  const tls = optional(env, "TIEHALL_SMTP_TLS") ?? "starttls";
  if (tls !== "starttls" && tls !== "tls" && tls !== "none") {
    throw new SettingsError("TIEHALL_SMTP_TLS must be starttls, tls or none.");
  }
  const port = readPort(env, "TIEHALL_SMTP_PORT", DEFAULT_SMTP_PORTS[tls]);
  const user = optional(env, "TIEHALL_SMTP_USER");
  const password = optional(env, "TIEHALL_SMTP_PASSWORD");
  if ((user === undefined) !== (password === undefined)) {
    throw new SettingsError("Set both TIEHALL_SMTP_USER and TIEHALL_SMTP_PASSWORD, or neither.");
  }
  return {
    host,
    port,
    tls,
    ...(user === undefined || password === undefined ? {} : { user, password }),
    from,
  };
}

function readPort(env: Environment, name: string, fallback: number): number {
  const value = optional(env, name);
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SettingsError(`${name} must be a whole number from 1 to 65535.`);
  }
  return port;
}

function readPostgresUrl(env: Environment, name: string, fallback: string): string {
  const value = optional(env, name) ?? fallback;
  if (!["postgres:", "postgresql:"].includes(parseUrl(value)?.protocol ?? "")) {
    throw new SettingsError(`${name} must be a postgres:// or postgresql:// URL.`);
  }
  return value;
}

function required(env: Environment, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new SettingsError(`${name} is not set. Set ${name} or ${name}_FILE.`);
  return value;
}

/** A setting from NAME, or from the file that NAME_FILE names, with one trailing newline removed. */
function optional(env: Environment, name: string): string | undefined {
  const direct = present(env[name]);
  const file = present(env[`${name}_FILE`]);
  if (direct !== undefined && file !== undefined) throw new SettingsError(`Set ${name} or ${name}_FILE, not both.`);
  if (file === undefined) return direct;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new SettingsError(`${name}_FILE names ${file}, which cannot be read (${code}).`);
  }
  return present(content.replace(/\r?\n$/, ""));
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
