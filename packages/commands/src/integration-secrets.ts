import { and, eq, sql } from "drizzle-orm";
import { integrationSecrets } from "@tiehall/db";
import { SecretKeyError, type SecretBox } from "./secret-box.ts";
import type { OrgContext } from "./with-org.ts";

// The integration secrets Tiehall stores in its database, each encrypted with
// the install's secret key and stored beside the id of that key
// (self-host-install: Stored integration secrets are encrypted). The commands
// that connect an integration store them inside their write; the jobs that
// call GitHub or Jira read them back.

export const INTEGRATION_SECRETS = [
  "github_app.client_secret",
  "github_app.webhook_secret",
  "github_app.private_key",
  "jira.api_token",
] as const;
export type IntegrationSecret = (typeof INTEGRATION_SECRETS)[number];

/** Encrypts a secret and stores it, replacing the one stored under its name. */
export async function storeSecret(context: OrgContext, box: SecretBox, name: IntegrationSecret, value: string): Promise<void> {
  const sealed = box.seal(value, contextOf(context, name));
  await context.tx
    .insert(integrationSecrets)
    .values({ orgId: context.orgId, name, ...sealed })
    .onConflictDoUpdate({
      target: [integrationSecrets.orgId, integrationSecrets.name],
      set: { ...sealed, updatedAt: sql`now()` },
    });
}

/**
 * Reads a stored secret and decrypts it, or undefined when none is stored
 * under its name. It throws SecretKeyError, naming the secret and the key ids
 * but no secret, when the secret was stored under another key or cannot be
 * decrypted.
 */
export async function readSecret(context: OrgContext, box: SecretBox, name: IntegrationSecret): Promise<string | undefined> {
  const [stored] = await context.tx
    .select({ keyId: integrationSecrets.keyId, nonce: integrationSecrets.nonce, ciphertext: integrationSecrets.ciphertext })
    .from(integrationSecrets)
    .where(and(eq(integrationSecrets.orgId, context.orgId), eq(integrationSecrets.name, name)));
  if (stored === undefined) return undefined;
  if (stored.keyId !== box.keyId) {
    throw new SecretKeyError(
      `The stored ${name} was encrypted under key ${stored.keyId}, and TIEHALL_SECRET_KEY is key ${box.keyId}. ` +
        "Set the TIEHALL_SECRET_KEY it was stored under, or store the secret again.",
    );
  }
  try {
    return box.open(stored, contextOf(context, name));
  } catch (error) {
    if (!(error instanceof SecretKeyError)) throw error;
    throw new SecretKeyError(
      `The stored ${name} cannot be decrypted with TIEHALL_SECRET_KEY: it was changed, or it belongs to another secret.`,
    );
  }
}

/** Binds a ciphertext to its org and name. */
function contextOf(context: OrgContext, name: IntegrationSecret): string {
  return `${context.orgId}/${name}`;
}
