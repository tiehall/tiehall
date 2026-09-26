import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { orgs, setupCodes, setupSessions, type Database } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "./log.ts";

// The setup code (self-host-install: The setup code guards the setup screen;
// design.md, Self-hosting decisions: S3). An install that is reachable from
// the internet could otherwise be claimed by the first stranger to open it, so
// only a browser that enters the setup code gets a setup session, and every
// step of the setup screen needs that session. Whoever can read the
// container's log already controls the host.
// - At each start while setup is incomplete, the web role makes the install's
//   one org if it does not exist yet, prints a new code to its log, where
//   `docker compose logs app` shows it, and stores only the code's SHA-256,
//   which replaces the previous one: the code of an earlier start stops
//   working. The code is 28 characters of Crockford's base32, 140 random bits,
//   printed in groups of 4; a person may type it in lower case, without the
//   dashes, and with O for 0 and I or L for 1.
// - Entering the current code opens a setup session: a random 32-byte token in
//   a cookie of that browser, stored as its SHA-256. A wrong code, the code of
//   an earlier start and any code once setup is complete open none.
// - Once setup is complete, a start prints no code, and no code or session
//   opens anything.
// The setup code is the one secret the log shows, by design.

/** Crockford's base32 alphabet: digits and upper-case letters without I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The characters of a setup code, 5 random bits each. */
export const SETUP_CODE_LENGTH = 28;
/** The randomness a setup code carries: at least 128 bits, as the setup screen requires. */
export const SETUP_CODE_BITS = SETUP_CODE_LENGTH * 5;
const NORMALIZED = new RegExp(`^[${ALPHABET}]{${SETUP_CODE_LENGTH}}$`);

/** A new setup code, such as 7K2M-QX9D-...: 28 characters of the alphabet in groups of 4. */
export function generateSetupCode(random: (size: number) => Buffer = randomBytes): string {
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  const characters = [...random(SETUP_CODE_LENGTH)].map((byte) => ALPHABET[byte & 31] ?? "");
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += 4) groups.push(characters.slice(index, index + 4).join(""));
  return groups.join("-");
}

/** A code as a person may type it, in the form its hash is taken of; undefined when it cannot be a setup code. */
export function normalizeSetupCode(text: string): string | undefined {
  const compact = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return NORMALIZED.test(compact) ? compact : undefined;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

export interface StartSetupOptions {
  /** The app's database, written as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin, which the log line names. */
  url: string;
  logger: Logger;
  random?: (size: number) => Buffer;
}

/**
 * The web role's setup step at start. While setup is incomplete, it stores a
 * new code's hash, replacing the previous one, prints the code to the log and
 * returns it; once setup is complete it prints nothing and returns undefined.
 */
export async function startSetup(options: StartSetupOptions): Promise<{ code: string } | undefined> {
  const code = generateSetupCode(options.random);
  const codeHash = sha256(normalizeSetupCode(code) ?? "");
  const stored = await options.database.transaction(async (tx) => {
    // The install's one org: made unnamed at the first start, named on the setup screen.
    await tx.insert(orgs).values({}).onConflictDoNothing();
    const [org] = await tx.select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt }).from(orgs).limit(1);
    if (org === undefined || org.setupCompletedAt !== null) return false;
    await tx
      .insert(setupCodes)
      .values({ orgId: org.id, codeHash })
      .onConflictDoUpdate({ target: setupCodes.orgId, set: { codeHash, createdAt: sql`now()` } });
    return true;
  });
  if (!stored) return undefined;
  options.logger.info(`setup: setup is not complete. Open ${options.url}/setup and enter the setup code ${code}`);
  return { code };
}

/**
 * Opens a setup session for a browser that entered this code, and returns the
 * session's token for its cookie; undefined, opening none, unless the code is
 * the one the latest start printed and setup is incomplete.
 */
export async function openSetupSession(database: Database, code: string): Promise<string | undefined> {
  const normalized = normalizeSetupCode(code);
  if (normalized === undefined) return undefined;
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select({ orgId: setupCodes.orgId, codeHash: setupCodes.codeHash, setupCompletedAt: orgs.setupCompletedAt })
      .from(setupCodes)
      .innerJoin(orgs, eq(orgs.id, setupCodes.orgId))
      .limit(1);
    if (current === undefined || current.setupCompletedAt !== null) return undefined;
    if (!timingSafeEqual(current.codeHash, sha256(normalized))) return undefined;
    const token = randomBytes(32).toString("base64url");
    await tx.insert(setupSessions).values({ orgId: current.orgId, tokenHash: sha256(token) });
    return token;
  });
}

/** Whether a cookie's token is a setup session of this install while setup is incomplete. */
export async function isSetupSession(database: Database, token: string | undefined): Promise<boolean> {
  if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [session] = await database
    .select({ id: setupSessions.id })
    .from(setupSessions)
    .innerJoin(orgs, and(eq(orgs.id, setupSessions.orgId), sql`${orgs.setupCompletedAt} IS NULL`))
    .where(eq(setupSessions.tokenHash, sha256(token)))
    .limit(1);
  return session !== undefined;
}
