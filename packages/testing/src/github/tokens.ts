import { randomBytes, randomInt, randomUUID } from "node:crypto";

// The credentials the GitHub stub issues. Every one is made at run time, so no
// file of the repository holds anything shaped like a GitHub token.

const LETTERS_AND_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** GitHub's new installation tokens carry `_`, `-` and `.` after the prefix too (github-app-reachability, T4). */
const INSTALLATION_TOKEN_CHARACTERS = `${LETTERS_AND_DIGITS}_-.`;

/**
 * The installation-token length the stub issues unless a test asks for another:
 * GitHub announced a new format of about 520 characters (spike 1.6), where the
 * spike itself still received tokens of 383.
 */
export const DEFAULT_INSTALLATION_TOKEN_LENGTH = 520;

function randomString(alphabet: string, length: number): string {
  let result = "";
  for (let index = 0; index < length; index += 1) result += alphabet[randomInt(alphabet.length)];
  return result;
}

/**
 * An installation token: `ghs_` followed by letters, digits, `_`, `-` and `.`,
 * `length` characters in all. A token of 8 characters or more carries each of
 * `_`, `-` and `.` at least once, so code that assumes letters and digits
 * after the prefix fails on every token the stub issues.
 */
export function makeInstallationToken(length = DEFAULT_INSTALLATION_TOKEN_LENGTH): string {
  if (!Number.isInteger(length) || length < 5) throw new RangeError(`an installation token has at least 5 characters, not ${length}`);
  const body = [...randomString(INSTALLATION_TOKEN_CHARACTERS, length - 4)];
  if (body.length >= 4) {
    const places = new Set<number>();
    while (places.size < 3) places.add(randomInt(1, body.length));
    for (const [index, place] of [...places].entries()) body[place] = "_-."[index]!;
  }
  return `ghs_${body.join("")}`;
}

/** A user access token of a GitHub App: `ghu_` and 36 letters and digits, 40 characters as the spike saw. */
export function makeUserToken(): string {
  return `ghu_${randomString(LETTERS_AND_DIGITS, 36)}`;
}

/** A refresh token of a GitHub App's user authorization: `ghr_` and 76 letters and digits, 80 characters as the spike saw. */
export function makeRefreshToken(): string {
  return `ghr_${randomString(LETTERS_AND_DIGITS, 76)}`;
}

/** A code of the manifest flow or of a user authorization: 20 hexadecimal digits. */
export function makeCode(): string {
  return randomBytes(10).toString("hex");
}

/** A client secret or a generated webhook secret: 40 hexadecimal digits. */
export function makeSecret(): string {
  return randomBytes(20).toString("hex");
}

/** A client id of a GitHub App: `Iv23li` and 14 letters and digits, 20 characters. */
export function makeClientId(): string {
  return `Iv23li${randomString(LETTERS_AND_DIGITS, 14)}`;
}

/** The id GitHub gives a webhook delivery, in the X-GitHub-Delivery header. */
export function makeGuid(): string {
  return randomUUID();
}
