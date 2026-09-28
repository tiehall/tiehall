import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLED_APP_DATABASE_URL,
  BUNDLED_OWNER_DATABASE_URL,
  isTrialUrl,
  readAppSettings,
  readMigrateSettings,
  SettingsError,
} from "../src/settings.ts";

// The install settings (self-host-install: One `.env` holds the install
// settings; self-host-install: `TIEHALL_URL` and TLS). The server reads every
// setting from the environment, which Compose fills from `.env`, and each
// secret also from the file its *_FILE form names. A missing or unusable
// setting stops the role before it starts, with a message that names the
// setting and never its value.

const SECRET_KEY = "k".repeat(43);
const AUTH_SECRET = "a".repeat(43);

/** The settings an app role (web, worker or all) needs, all valid. */
const APP = {
  TIEHALL_URL: "https://tiehall.example.com",
  TIEHALL_DATABASE_APP_PASSWORD: "app-password",
  TIEHALL_SECRET_KEY: SECRET_KEY,
  TIEHALL_AUTH_SECRET: AUTH_SECRET,
} as const;

/** The settings the migrate role needs. */
const MIGRATE = {
  TIEHALL_DATABASE_OWNER_PASSWORD: "owner-password",
  TIEHALL_DATABASE_APP_PASSWORD: "app-password",
} as const;

let secrets: string;

beforeAll(() => {
  secrets = mkdtempSync(join(tmpdir(), "tiehall-settings-"));
});

afterAll(() => {
  rmSync(secrets, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const path = join(secrets, name);
  writeFileSync(path, content);
  return path;
}

describe("TIEHALL_URL", () => {
  const refusal = new SettingsError(
    "TIEHALL_URL must be an https:// URL, or http://localhost with or without a port for a trial on one machine.",
  );

  it("accepts an https URL and keeps its origin", () => {
    expect(readAppSettings(APP).url).toBe("https://tiehall.example.com");
    expect(readAppSettings({ ...APP, TIEHALL_URL: "https://Tiehall.Example.com:8443/" }).url).toBe("https://tiehall.example.com:8443");
  });

  it("accepts http://localhost, with or without a port, for a trial on one machine", () => {
    expect(readAppSettings({ ...APP, TIEHALL_URL: "http://localhost" }).url).toBe("http://localhost");
    expect(readAppSettings({ ...APP, TIEHALL_URL: "http://localhost:3000" }).url).toBe("http://localhost:3000");
  });

  it("refuses a plain-HTTP public host", () => {
    expect(() => readAppSettings({ ...APP, TIEHALL_URL: "http://tiehall.example.com" })).toThrow(refusal);
  });

  it("refuses a plain-HTTP loopback address, which is not a trial URL", () => {
    expect(() => readAppSettings({ ...APP, TIEHALL_URL: "http://127.0.0.1:3000" })).toThrow(refusal);
    expect(() => readAppSettings({ ...APP, TIEHALL_URL: "http://[::1]:3000" })).toThrow(refusal);
    expect(() => readAppSettings({ ...APP, TIEHALL_URL: "http://localhost.example.com" })).toThrow(refusal);
  });

  // One check decides what a trial URL is, for the settings reader and for the GitHub App's manifest, whose
  // webhook follows it (github-app-reachability: design.md, Technical decisions: T1).
  it("takes exactly http://localhost, with or without a port, as a trial URL", () => {
    for (const url of ["http://localhost", "http://localhost:3000", "http://LOCALHOST:3000"]) expect(isTrialUrl(url), url).toBe(true);
    for (const url of ["https://localhost", "https://tiehall.example.com", "http://127.0.0.1:3000", "http://localhost.example.com", "localhost"]) {
      expect(isTrialUrl(url), url).toBe(false);
    }
    expect(readAppSettings({ ...APP, TIEHALL_URL: "http://LOCALHOST:3000" }).url).toBe("http://localhost:3000");
  });

  it("refuses other schemes and values that are not URLs", () => {
    expect(() => readAppSettings({ ...APP, TIEHALL_URL: "ftp://tiehall.example.com" })).toThrow(refusal);
    expect(() => readAppSettings({ ...APP, TIEHALL_URL: "tiehall.example.com" })).toThrow(refusal);
  });

  it("refuses a URL with a path, a query, a fragment or credentials, without echoing it", () => {
    const base = new SettingsError(
      "TIEHALL_URL must be the install's base URL, with no path, query, fragment or credentials, such as https://tiehall.example.com.",
    );
    for (const url of [
      "https://tiehall.example.com/tiehall",
      "https://tiehall.example.com/?a=1",
      "https://tiehall.example.com/#top",
      "https://admin:hunter2@tiehall.example.com",
    ]) {
      expect(() => readAppSettings({ ...APP, TIEHALL_URL: url }), url).toThrow(base);
    }
  });

  it("is required", () => {
    const { TIEHALL_URL: _, ...withoutUrl } = APP;
    expect(() => readAppSettings(withoutUrl)).toThrow(new SettingsError("TIEHALL_URL is not set. Set TIEHALL_URL or TIEHALL_URL_FILE."));
  });
});

describe("the app roles' settings", () => {
  it("connect to the bundled Postgres as the app role unless TIEHALL_DATABASE_APP_URL names another database", () => {
    expect(readAppSettings(APP).database).toEqual({ connectionString: BUNDLED_APP_DATABASE_URL, password: "app-password" });
    const external = "postgres://tiehall_app@db.example.com:5432/tiehall";
    expect(readAppSettings({ ...APP, TIEHALL_DATABASE_APP_URL: external }).database).toEqual({
      connectionString: external,
      password: "app-password",
    });
  });

  it("take the app role's password from its URL when it is not set apart", () => {
    const { TIEHALL_DATABASE_APP_PASSWORD: _, ...withoutPassword } = APP;
    const url = "postgres://tiehall_app:p%40ss@db.example.com:5432/tiehall";
    expect(readAppSettings({ ...withoutPassword, TIEHALL_DATABASE_APP_URL: url }).database).toEqual({
      connectionString: url,
      password: "p@ss",
    });
    expect(() => readAppSettings(withoutPassword)).toThrow(
      new SettingsError(
        "The app role has no password. Set TIEHALL_DATABASE_APP_PASSWORD or TIEHALL_DATABASE_APP_PASSWORD_FILE, or give it in TIEHALL_DATABASE_APP_URL.",
      ),
    );
  });

  it("never read the database owner's settings", () => {
    const settings = readAppSettings({ ...APP, TIEHALL_DATABASE_OWNER_PASSWORD: "owner-password" });
    expect(JSON.stringify(settings)).not.toContain("owner-password");
  });

  it("require TIEHALL_SECRET_KEY and TIEHALL_AUTH_SECRET, each long enough for 256 bits, without echoing them", () => {
    const { TIEHALL_SECRET_KEY: _, ...withoutKey } = APP;
    expect(() => readAppSettings(withoutKey)).toThrow(
      new SettingsError("TIEHALL_SECRET_KEY is not set. Set TIEHALL_SECRET_KEY or TIEHALL_SECRET_KEY_FILE."),
    );
    const { TIEHALL_AUTH_SECRET: __, ...withoutAuthSecret } = APP;
    expect(() => readAppSettings(withoutAuthSecret)).toThrow(
      new SettingsError("TIEHALL_AUTH_SECRET is not set. Set TIEHALL_AUTH_SECRET or TIEHALL_AUTH_SECRET_FILE."),
    );
    expect(() => readAppSettings({ ...APP, TIEHALL_SECRET_KEY: "hunter2" })).toThrow(
      new SettingsError("TIEHALL_SECRET_KEY must hold at least 43 characters, as 32 random bytes in base64url do."),
    );
    expect(() => readAppSettings({ ...APP, TIEHALL_AUTH_SECRET: "hunter2" })).toThrow(
      new SettingsError("TIEHALL_AUTH_SECRET must hold at least 43 characters, as 32 random bytes in base64url do."),
    );
  });

  it("read the web port, 3000 by default", () => {
    expect(readAppSettings(APP).port).toBe(3000);
    expect(readAppSettings({ ...APP, PORT: "8080" }).port).toBe(8080);
    expect(() => readAppSettings({ ...APP, PORT: "http" })).toThrow(new SettingsError("PORT must be a whole number from 1 to 65535."));
  });

  it("read the trusted proxies as addresses, ranges and host names, and trust none by default", () => {
    expect(readAppSettings(APP).trustedProxies).toEqual([]);
    expect(readAppSettings({ ...APP, TIEHALL_TRUSTED_PROXIES: "caddy, 10.0.0.5 172.16.0.0/12,fd00::/8" }).trustedProxies).toEqual([
      "caddy",
      "10.0.0.5",
      "172.16.0.0/12",
      "fd00::/8",
    ]);
    for (const value of ["10.0.0.0/33", "not a host!", "https://proxy.example.com"]) {
      expect(() => readAppSettings({ ...APP, TIEHALL_TRUSTED_PROXIES: value }), value).toThrow(
        new SettingsError(
          "TIEHALL_TRUSTED_PROXIES must list IP addresses, CIDR ranges or host names, separated by commas, such as caddy,10.0.0.5.",
        ),
      );
    }
  });

  it("fetch Client ID Metadata Documents unless TIEHALL_CLIENT_METADATA_FETCH is off", () => {
    expect(readAppSettings(APP).clientMetadataFetch).toBe(true);
    expect(readAppSettings({ ...APP, TIEHALL_CLIENT_METADATA_FETCH: "on" }).clientMetadataFetch).toBe(true);
    expect(readAppSettings({ ...APP, TIEHALL_CLIENT_METADATA_FETCH: "off" }).clientMetadataFetch).toBe(false);
    expect(() => readAppSettings({ ...APP, TIEHALL_CLIENT_METADATA_FETCH: "no" })).toThrow(
      new SettingsError("TIEHALL_CLIENT_METADATA_FETCH must be on or off."),
    );
  });

  it("read TIEHALL_SOURCE_URL, the source a modified server offers its users", () => {
    expect(readAppSettings(APP).sourceUrl).toBeUndefined();
    expect(readAppSettings({ ...APP, TIEHALL_SOURCE_URL: "https://git.acme.example/tiehall-fork" }).sourceUrl).toBe(
      "https://git.acme.example/tiehall-fork",
    );
    expect(() => readAppSettings({ ...APP, TIEHALL_SOURCE_URL: "git@git.acme.example:tiehall" })).toThrow(
      new SettingsError("TIEHALL_SOURCE_URL must be an https:// or http:// URL."),
    );
  });

  it("leave email off without SMTP settings, and read them all when the host is set", () => {
    expect(readAppSettings(APP).smtp).toBeUndefined();
    const smtp = {
      TIEHALL_SMTP_HOST: "smtp.example.com",
      TIEHALL_SMTP_USER: "tiehall",
      TIEHALL_SMTP_PASSWORD: "smtp-password",
      TIEHALL_SMTP_FROM: "Tiehall <tiehall@example.com>",
    };
    expect(readAppSettings({ ...APP, ...smtp }).smtp).toEqual({
      host: "smtp.example.com",
      port: 587,
      tls: "starttls",
      user: "tiehall",
      password: "smtp-password",
      from: "Tiehall <tiehall@example.com>",
    });
    expect(readAppSettings({ ...APP, ...smtp, TIEHALL_SMTP_TLS: "tls" }).smtp?.port).toBe(465);
    expect(readAppSettings({ ...APP, ...smtp, TIEHALL_SMTP_TLS: "tls", TIEHALL_SMTP_PORT: "2465" }).smtp?.port).toBe(2465);
    expect(
      readAppSettings({ ...APP, TIEHALL_SMTP_HOST: "relay.internal", TIEHALL_SMTP_TLS: "none", TIEHALL_SMTP_FROM: "tiehall@acme.example" })
        .smtp,
    ).toEqual({ host: "relay.internal", port: 25, tls: "none", from: "tiehall@acme.example" });
  });

  it("refuse incomplete or unusable SMTP settings, without echoing them", () => {
    expect(() => readAppSettings({ ...APP, TIEHALL_SMTP_FROM: "tiehall@example.com" })).toThrow(
      new SettingsError("TIEHALL_SMTP_HOST is not set, but other SMTP settings are. Set it to send email, or leave them all unset."),
    );
    expect(() => readAppSettings({ ...APP, TIEHALL_SMTP_HOST: "smtp.example.com" })).toThrow(
      new SettingsError("TIEHALL_SMTP_FROM is not set. Email needs the address it is sent from."),
    );
    const complete = { ...APP, TIEHALL_SMTP_HOST: "smtp.example.com", TIEHALL_SMTP_FROM: "tiehall@example.com" };
    expect(() => readAppSettings({ ...complete, TIEHALL_SMTP_TLS: "ssl" })).toThrow(
      new SettingsError("TIEHALL_SMTP_TLS must be starttls, tls or none."),
    );
    expect(() => readAppSettings({ ...complete, TIEHALL_SMTP_USER: "tiehall" })).toThrow(
      new SettingsError("Set both TIEHALL_SMTP_USER and TIEHALL_SMTP_PASSWORD, or neither."),
    );
    expect(() => readAppSettings({ ...complete, TIEHALL_SMTP_PORT: "0" })).toThrow(
      new SettingsError("TIEHALL_SMTP_PORT must be a whole number from 1 to 65535."),
    );
    expect(() => readAppSettings({ ...complete, TIEHALL_SMTP_FROM: "not an address" })).toThrow(
      new SettingsError("TIEHALL_SMTP_FROM must be an email address, such as tiehall@example.com or Tiehall <tiehall@example.com>."),
    );
  });
});

describe("the migrate role's settings", () => {
  it("connect to the bundled Postgres as the owner and name the app role, unless the two URLs name another database", () => {
    expect(readMigrateSettings(MIGRATE)).toEqual({
      owner: { connectionString: BUNDLED_OWNER_DATABASE_URL, password: "owner-password" },
      appRole: { name: "tiehall_app", password: "app-password" },
    });
    expect(
      readMigrateSettings({
        TIEHALL_DATABASE_OWNER_URL: "postgres://owner:owner%2Dpass@db.example.com:5432/tiehall",
        TIEHALL_DATABASE_APP_URL: "postgres://tiehall%2Dapp:p%40ss@db.example.com:5432/tiehall",
      }),
    ).toEqual({
      owner: { connectionString: "postgres://owner:owner%2Dpass@db.example.com:5432/tiehall", password: "owner-pass" },
      appRole: { name: "tiehall-app", password: "p@ss" },
    });
  });

  it("use a password given in a database URL, and the password setting only for a URL that gives none", () => {
    // An install on an external Postgres keeps the bundled one's password in .env, and gives each URL its own.
    const owner = "postgres://tiehall:owner-url-pass@db.example.com:5432/tiehall";
    const app = "postgres://tiehall_app:app-url-pass@db.example.com:5432/tiehall";
    expect(readMigrateSettings({ ...MIGRATE, TIEHALL_DATABASE_OWNER_URL: owner, TIEHALL_DATABASE_APP_URL: app })).toEqual({
      owner: { connectionString: owner, password: "owner-url-pass" },
      appRole: { name: "tiehall_app", password: "app-url-pass" },
    });
    expect(readAppSettings({ ...APP, TIEHALL_DATABASE_APP_URL: app }).database).toEqual({ connectionString: app, password: "app-url-pass" });
  });

  it("need no install URL and no keys", () => {
    expect(() => readMigrateSettings(MIGRATE)).not.toThrow();
  });

  it("require the owner's password and the app role's password", () => {
    expect(() => readMigrateSettings({ TIEHALL_DATABASE_APP_PASSWORD: "x" })).toThrow(
      new SettingsError(
        "The database owner has no password. Set TIEHALL_DATABASE_OWNER_PASSWORD or TIEHALL_DATABASE_OWNER_PASSWORD_FILE, or give it in TIEHALL_DATABASE_OWNER_URL.",
      ),
    );
    expect(() => readMigrateSettings({ TIEHALL_DATABASE_OWNER_PASSWORD: "x" })).toThrow(
      new SettingsError(
        "The app role has no password. Set TIEHALL_DATABASE_APP_PASSWORD or TIEHALL_DATABASE_APP_PASSWORD_FILE, or give it in TIEHALL_DATABASE_APP_URL.",
      ),
    );
  });

  it("refuse database URLs that are not postgres URLs, or an app URL without a user, without echoing them", () => {
    expect(() => readMigrateSettings({ ...MIGRATE, TIEHALL_DATABASE_OWNER_URL: "mysql://root:hunter2@db/app" })).toThrow(
      new SettingsError("TIEHALL_DATABASE_OWNER_URL must be a postgres:// or postgresql:// URL."),
    );
    expect(() => readMigrateSettings({ ...MIGRATE, TIEHALL_DATABASE_APP_URL: "postgres://db.example.com/tiehall" })).toThrow(
      new SettingsError("TIEHALL_DATABASE_APP_URL must name the app role as its user."),
    );
  });
});

describe("secrets in files", () => {
  it("read every secret setting from the file its _FILE form names, equal to the same value set inline", () => {
    const inline = {
      ...APP,
      TIEHALL_SMTP_HOST: "smtp.example.com",
      TIEHALL_SMTP_FROM: "tiehall@example.com",
      TIEHALL_SMTP_USER: "tiehall",
      TIEHALL_SMTP_PASSWORD: "smtp-password",
    };
    const fromFiles = {
      TIEHALL_URL: APP.TIEHALL_URL,
      TIEHALL_SMTP_HOST: "smtp.example.com",
      TIEHALL_SMTP_FROM: "tiehall@example.com",
      TIEHALL_SMTP_USER: "tiehall",
      TIEHALL_DATABASE_APP_PASSWORD_FILE: file("app_password", "app-password\n"),
      TIEHALL_SECRET_KEY_FILE: file("secret_key", `${SECRET_KEY}\n`),
      TIEHALL_AUTH_SECRET_FILE: file("auth_secret", `${AUTH_SECRET}\n`),
      TIEHALL_SMTP_PASSWORD_FILE: file("smtp_password", "smtp-password"),
    };
    expect(readAppSettings(fromFiles)).toEqual(readAppSettings(inline));

    const migrateFromFiles = {
      TIEHALL_DATABASE_OWNER_PASSWORD_FILE: file("owner_password", "owner-password\n"),
      TIEHALL_DATABASE_APP_PASSWORD_FILE: file("app_password", "app-password\n"),
    };
    expect(readMigrateSettings(migrateFromFiles)).toEqual(readMigrateSettings(MIGRATE));
  });

  it("treat an empty setting or _FILE form as unset, as Compose passes one that .env leaves out", () => {
    expect(readAppSettings({ ...APP, TIEHALL_SECRET_KEY_FILE: "", TIEHALL_TRUSTED_PROXIES: "", TIEHALL_SMTP_HOST: "" })).toEqual(
      readAppSettings(APP),
    );
  });

  it("refuse a setting given both inline and through _FILE", () => {
    expect(() => readAppSettings({ ...APP, TIEHALL_SECRET_KEY_FILE: file("key", SECRET_KEY) })).toThrow(
      new SettingsError("Set TIEHALL_SECRET_KEY or TIEHALL_SECRET_KEY_FILE, not both."),
    );
  });

  it("refuse a _FILE form whose file cannot be read, without printing any secret", () => {
    const missing = join(secrets, "missing");
    const { TIEHALL_AUTH_SECRET: _, ...withoutAuthSecret } = APP;
    expect(() => readAppSettings({ ...withoutAuthSecret, TIEHALL_AUTH_SECRET_FILE: missing })).toThrow(
      new SettingsError(`TIEHALL_AUTH_SECRET_FILE names ${missing}, which cannot be read (ENOENT).`),
    );
  });
});
