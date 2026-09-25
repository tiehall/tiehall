import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config.ts";

// Configuration comes only from environment variables and *_FILE secrets
// (design.md decision 1; operations: Production runs the self-host Compose file and image).

describe("readConfig", () => {
  let secrets: string;
  const url = "postgres://tiehall@postgres:5432/tiehall";

  beforeAll(() => {
    secrets = mkdtempSync(join(tmpdir(), "tiehall-config-"));
    writeFileSync(join(secrets, "database_password"), "s3cret-from-file\n");
  });

  afterAll(() => {
    rmSync(secrets, { recursive: true, force: true });
  });

  it("reads a setting from its environment variable", () => {
    expect(readConfig({ DATABASE_URL: url, DATABASE_PASSWORD: "from-env" })).toEqual({
      databaseUrl: url,
      databasePassword: "from-env",
      port: 3000,
    });
  });

  it("reads a secret from the file named by its _FILE variable, without the trailing newline", () => {
    const config = readConfig({ DATABASE_URL: url, DATABASE_PASSWORD_FILE: join(secrets, "database_password") });
    expect(config.databasePassword).toBe("s3cret-from-file");
  });

  it("reads any setting through _FILE, the database URL included", () => {
    writeFileSync(join(secrets, "database_url"), `${url}\n`);
    expect(readConfig({ DATABASE_URL_FILE: join(secrets, "database_url") }).databaseUrl).toBe(url);
  });

  it("leaves the password out when neither variable is set", () => {
    expect(readConfig({ DATABASE_URL: url })).toEqual({ databaseUrl: url, port: 3000 });
  });

  it("refuses a setting given both directly and through _FILE", () => {
    expect(() =>
      readConfig({ DATABASE_URL: url, DATABASE_PASSWORD: "a", DATABASE_PASSWORD_FILE: join(secrets, "database_password") }),
    ).toThrow(new ConfigError("Set DATABASE_PASSWORD or DATABASE_PASSWORD_FILE, not both."));
  });

  it("refuses a _FILE variable whose file cannot be read, without printing any secret", () => {
    const missing = join(secrets, "missing");
    expect(() => readConfig({ DATABASE_URL: url, DATABASE_PASSWORD_FILE: missing })).toThrow(
      new ConfigError(`DATABASE_PASSWORD_FILE names ${missing}, which cannot be read (ENOENT).`),
    );
  });

  it("requires the database URL", () => {
    expect(() => readConfig({})).toThrow(new ConfigError("DATABASE_URL is not set. Set DATABASE_URL or DATABASE_URL_FILE."));
  });

  it("refuses a database URL that is not a postgres URL, without echoing it", () => {
    expect(() => readConfig({ DATABASE_URL: "mysql://user:hunter2@db/app" })).toThrow(
      new ConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL."),
    );
  });

  it("reads the web port, and refuses one that is not a TCP port", () => {
    expect(readConfig({ DATABASE_URL: url, PORT: "8080" }).port).toBe(8080);
    expect(() => readConfig({ DATABASE_URL: url, PORT: "http" })).toThrow(
      new ConfigError("PORT must be a whole number from 1 to 65535."),
    );
    expect(() => readConfig({ DATABASE_URL: url, PORT: "70000" })).toThrow(ConfigError);
  });
});
