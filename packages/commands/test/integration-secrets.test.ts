import { hkdfSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, dumpDatabase, restoreDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  INTEGRATION_SECRETS,
  migrate,
  openDatabase,
  openSecretBox,
  readSecret,
  SecretKeyError,
  storeSecret,
  withOrg,
  type Database,
} from "../src/index.ts";

// Stored integration secrets are encrypted (self-host-install: Stored
// integration secrets are encrypted; design.md, Technical decisions: T4 and
// Self-hosting decisions: S2, S11). Tiehall encrypts each one with AES-256-GCM
// under a key derived from TIEHALL_SECRET_KEY and stores the id of that key
// beside the ciphertext. The key lives only in the install's settings, never in
// the database, so a dump restored without it cannot use the secrets.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const SECRET_KEY = randomBytes(32).toString("base64url");
const OTHER_KEY = randomBytes(32).toString("base64url");
// Canaries that stand for the secrets, shaped so that the secret scan does not take them for real ones.
const JIRA_TOKEN = `jira-api-token-canary-${randomBytes(16).toString("hex")}`;
const PRIVATE_KEY = `app-private-key-canary\n${randomBytes(24).toString("base64")}\nsecond line`;

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

/** Connects as the app role, as the app does. */
function appDatabase(url: string): Database {
  const app = new URL(url);
  app.username = appRole.name;
  app.password = "";
  return openDatabase({ connectionString: app.toString(), password: appRole.password });
}

/** Every encoding of a secret that could show it in a dump. */
function encodingsOf(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [secret, bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")];
}

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  db = appDatabase(database.url);
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  const box = openSecretBox(SECRET_KEY);
  await withOrg(db, async (context) => {
    await storeSecret(context, box, "jira.api_token", JIRA_TOKEN);
    await storeSecret(context, box, "github_app.private_key", PRIVATE_KEY);
  });
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

describe("a stored integration secret", () => {
  it("shows only its ciphertext and the id of its key when read from the database", async () => {
    const { rows } = await owner.query<Record<string, unknown>>(
      "SELECT name, key_id, nonce, ciphertext FROM integration_secrets ORDER BY name",
    );
    const keyId = openSecretBox(SECRET_KEY).keyId;
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(rows.map(({ name, key_id }) => ({ name, key_id }))).toEqual([
      { name: "github_app.private_key", key_id: keyId },
      { name: "jira.api_token", key_id: keyId },
    ]);
    const jira = rows.find(({ name }) => name === "jira.api_token");
    expect((jira?.["nonce"] as Buffer).length).toBe(12);
    // AES-GCM: as long as the plain text, plus its 16-byte tag.
    expect((jira?.["ciphertext"] as Buffer).length).toBe(Buffer.byteLength(JIRA_TOKEN) + 16);
    const text = JSON.stringify(rows) + rows.map((row) => (row["ciphertext"] as Buffer).toString("latin1")).join("");
    for (const secret of [JIRA_TOKEN, PRIVATE_KEY]) {
      for (const encoding of encodingsOf(secret)) expect(text).not.toContain(encoding);
    }
  });

  it("is read back with the same key", async () => {
    const box = openSecretBox(SECRET_KEY);
    expect(await withOrg(db, (context) => readSecret(context, box, "jira.api_token"))).toBe(JIRA_TOKEN);
    expect(await withOrg(db, (context) => readSecret(context, box, "github_app.private_key"))).toBe(PRIVATE_KEY);
    expect(await withOrg(db, (context) => readSecret(context, box, "github_app.webhook_secret"))).toBeUndefined();
  });

  it("is replaced, under a fresh nonce, when it is stored again", async () => {
    const box = openSecretBox(SECRET_KEY);
    const before = (await owner.query("SELECT nonce FROM integration_secrets WHERE name = 'jira.api_token'")).rows[0];
    await withOrg(db, (context) => storeSecret(context, box, "jira.api_token", JIRA_TOKEN));
    const after = (await owner.query("SELECT nonce FROM integration_secrets WHERE name = 'jira.api_token'")).rows;
    expect(after).toHaveLength(1);
    expect(after[0]).not.toEqual(before);
    expect(await withOrg(db, (context) => readSecret(context, box, "jira.api_token"))).toBe(JIRA_TOKEN);
  });

  it("cannot be moved onto another secret's name, or changed, without failing to decrypt", async () => {
    const box = openSecretBox(SECRET_KEY);
    await owner.query(
      `BEGIN;
       UPDATE integration_secrets SET name = 'swapped' WHERE name = 'jira.api_token';
       UPDATE integration_secrets SET name = 'jira.api_token' WHERE name = 'github_app.private_key';
       UPDATE integration_secrets SET name = 'github_app.private_key' WHERE name = 'swapped';
       COMMIT`,
    );
    try {
      await expect(withOrg(db, (context) => readSecret(context, box, "jira.api_token"))).rejects.toThrow(
        new SecretKeyError(
          "The stored jira.api_token cannot be decrypted with TIEHALL_SECRET_KEY: it was changed, or it belongs to another secret.",
        ),
      );
    } finally {
      await owner.query(
        `BEGIN;
         UPDATE integration_secrets SET name = 'swapped' WHERE name = 'jira.api_token';
         UPDATE integration_secrets SET name = 'jira.api_token' WHERE name = 'github_app.private_key';
         UPDATE integration_secrets SET name = 'github_app.private_key' WHERE name = 'swapped';
         COMMIT`,
      );
    }
    expect(await withOrg(db, (context) => readSecret(context, box, "jira.api_token"))).toBe(JIRA_TOKEN);
  });
});

describe("a dump of the install", () => {
  let restored: TestDatabase;
  let restoredDb: Database;

  beforeAll(async () => {
    // What backup.sh does: pg_dump in its custom format inside the Postgres container, then pg_restore.
    restored = await createTestDatabase();
    restoreDatabase(dumpDatabase(database.url), restored.url);
    restoredDb = appDatabase(restored.url);
  });

  afterAll(async () => {
    await restoredDb.$client.end();
    await restored.drop();
  });

  it("cannot decrypt the stored secrets when restored without the key", async () => {
    const otherBox = openSecretBox(OTHER_KEY);
    const keyId = openSecretBox(SECRET_KEY).keyId;
    await expect(withOrg(restoredDb, (context) => readSecret(context, otherBox, "jira.api_token"))).rejects.toThrow(
      new SecretKeyError(
        `The stored jira.api_token was encrypted under key ${keyId}, and TIEHALL_SECRET_KEY is key ${otherBox.keyId}. ` +
          "Set the TIEHALL_SECRET_KEY it was stored under, or store the secret again.",
      ),
    );
    // Even when the dump's key id is copied, the other key cannot decrypt it.
    const forged = { ...otherBox, keyId };
    await expect(withOrg(restoredDb, (context) => readSecret(context, forged, "jira.api_token"))).rejects.toThrow(
      SecretKeyError,
    );
  });

  it("decrypts them with the install's key, which the operator backs up apart from the dump", async () => {
    const box = openSecretBox(SECRET_KEY);
    expect(await withOrg(restoredDb, (context) => readSecret(context, box, "jira.api_token"))).toBe(JIRA_TOKEN);
  });

  it("never holds the key, in any encoding, nor the key derived from it", () => {
    const dump = dumpDatabase(database.url, "plain").toString("utf8");
    expect(dump).toContain("integration_secrets");
    // The encryption key, derived from TIEHALL_SECRET_KEY as secret-box.ts documents.
    const derived = Buffer.from(hkdfSync("sha256", SECRET_KEY, "tiehall", "integration secrets: AES-256-GCM key", 32));
    for (const encoding of [...encodingsOf(SECRET_KEY), derived.toString("hex"), derived.toString("base64")]) {
      expect(dump).not.toContain(encoding);
    }
    for (const secret of [JIRA_TOKEN, PRIVATE_KEY]) {
      for (const encoding of encodingsOf(secret)) expect(dump).not.toContain(encoding);
    }
  });
});

describe("the secret key", () => {
  it("has a stable id, from which nothing about it follows, and each key its own", () => {
    expect(openSecretBox(SECRET_KEY).keyId).toBe(openSecretBox(SECRET_KEY).keyId);
    expect(openSecretBox(OTHER_KEY).keyId).not.toBe(openSecretBox(SECRET_KEY).keyId);
    expect(SECRET_KEY).not.toContain(openSecretBox(SECRET_KEY).keyId);
  });

  it("is refused when it is too short to hold 256 bits, without echoing it", () => {
    expect(() => openSecretBox("short-key")).toThrow(
      new SecretKeyError("TIEHALL_SECRET_KEY must hold at least 43 characters, as 32 random bytes in base64url do."),
    );
  });

  it("names the integration secrets Tiehall stores", () => {
    expect(INTEGRATION_SECRETS).toEqual([
      "github_app.client_secret",
      "github_app.webhook_secret",
      "github_app.private_key",
      "jira.api_token",
    ]);
  });
});
