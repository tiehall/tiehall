import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Encryption of stored integration secrets (self-host-install: Stored
// integration secrets are encrypted; design.md, Technical decisions: T4 and
// Self-hosting decisions: S2). The key comes from TIEHALL_SECRET_KEY, which
// lives only in the install's settings and never in the database, so a copy or
// a dump of the database cannot use the secrets it holds. Each secret is
// sealed with AES-256-GCM under a fresh 96-bit nonce, and its context (which
// secret of which org) is bound in as associated data, so a ciphertext moved
// onto another secret fails to decrypt. The key id, stored beside each
// ciphertext, lets a later release rotate keys without re-encrypting in place.
//
// Derivation, with HKDF-SHA256 from TIEHALL_SECRET_KEY and the salt "tiehall":
// the AES-256 key with the info "integration secrets: AES-256-GCM key", and the
// key id, 8 bytes in hex, with the info "integration secrets: key id". Neither
// shows anything of the other or of the setting.

/** 32 random bytes in base64url, as `init` writes it; anything shorter cannot hold a 256-bit key. */
export const SECRET_KEY_MIN_LENGTH = 43;

const SALT = "tiehall";
const KEY_INFO = "integration secrets: AES-256-GCM key";
const KEY_ID_INFO = "integration secrets: key id";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A key that cannot be used, or a secret that cannot be decrypted; its message names no secret. */
export class SecretKeyError extends Error {
  override name = "SecretKeyError";
}

/** A sealed secret, as it is stored. */
export interface Sealed {
  keyId: string;
  nonce: Buffer;
  /** The ciphertext followed by its authentication tag. */
  ciphertext: Buffer;
}

export interface SecretBox {
  /** The id of the key, stored beside each ciphertext. */
  readonly keyId: string;
  seal(plaintext: string, context: string): Sealed;
  /** Decrypts a sealed secret of this key; it throws SecretKeyError when the ciphertext or its context do not match. */
  open(sealed: Sealed, context: string): string;
}

/** Why a TIEHALL_SECRET_KEY cannot be used, or undefined when it can. */
export function secretKeyProblem(secretKey: string): string | undefined {
  return secretKey.length < SECRET_KEY_MIN_LENGTH
    ? `TIEHALL_SECRET_KEY must hold at least ${SECRET_KEY_MIN_LENGTH} characters, as 32 random bytes in base64url do.`
    : undefined;
}

export function openSecretBox(secretKey: string): SecretBox {
  const problem = secretKeyProblem(secretKey);
  if (problem !== undefined) throw new SecretKeyError(problem);
  const key = Buffer.from(hkdfSync("sha256", secretKey, SALT, KEY_INFO, 32));
  const keyId = Buffer.from(hkdfSync("sha256", secretKey, SALT, KEY_ID_INFO, 8)).toString("hex");
  return {
    keyId,
    seal(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return { keyId, nonce, ciphertext };
    },
    open(sealed, context) {
      if (sealed.ciphertext.length < TAG_BYTES || sealed.nonce.length !== NONCE_BYTES) {
        throw new SecretKeyError(`The sealed ${context} is malformed.`);
      }
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
      try {
        return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretKeyError(`The sealed ${context} cannot be decrypted.`);
      }
    },
  };
}
