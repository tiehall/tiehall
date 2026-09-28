import { and, eq, sql } from "drizzle-orm";
import { githubApp, integrationSecrets } from "@tiehall/db";
import type { ConvertedApp } from "./github-client.ts";
import { storeSecret } from "./integration-secrets.ts";
import type { SecretBox } from "./secret-box.ts";
import type { OrgContext } from "./with-org.ts";

// The install's GitHub App as Tiehall stores it (self-host-install: The GitHub
// App is created with GitHub's manifest flow; self-host-install: Stored
// integration secrets are encrypted; design.md, Self-hosting decisions: S4).
// What identifies the App (its id, slug, name, client id and owner) is one
// row; its client secret, private key and webhook secret are integration
// secrets, encrypted with the install's secret key. An App created without a
// webhook has no webhook secret, and none is stored for it
// (github-app-reachability: design.md, Design rules: An App without a
// webhook): the App "has a webhook" exactly when one is stored.

/** The install's GitHub App, without its secrets. */
export interface StoredGitHubApp {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  owner: { login: string; type: "Organization" | "User" };
  /** When its credentials were stored. */
  storedAt: Date;
}

/** The install's GitHub App, or undefined before the setup screen has stored one. */
export async function readGitHubApp({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<StoredGitHubApp | undefined> {
  const [row] = await tx.select().from(githubApp).where(eq(githubApp.orgId, orgId));
  if (row === undefined) return undefined;
  return {
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    clientId: row.clientId,
    owner: { login: row.ownerLogin, type: row.ownerType === "Organization" ? "Organization" : "User" },
    storedAt: row.storedAt,
  };
}

/**
 * Stores a new App's credentials, in the caller's transaction, in place of any
 * App stored before: its row, and its client secret, private key and webhook
 * secret, encrypted. An App without a webhook replaces the webhook secret of
 * the App before it with none.
 */
export async function storeGitHubApp(context: OrgContext, box: SecretBox, app: ConvertedApp): Promise<void> {
  const { tx, orgId } = context;
  const identity = {
    appId: app.id,
    slug: app.slug,
    name: app.name,
    clientId: app.clientId,
    ownerLogin: app.owner.login,
    ownerType: app.owner.type,
  };
  await tx
    .insert(githubApp)
    .values({ orgId, ...identity })
    .onConflictDoUpdate({ target: githubApp.orgId, set: { ...identity, storedAt: sql`now()` } });
  await storeSecret(context, box, "github_app.client_secret", app.clientSecret);
  await storeSecret(context, box, "github_app.private_key", app.privateKey);
  if (app.webhookSecret === null) {
    await tx
      .delete(integrationSecrets)
      .where(and(eq(integrationSecrets.orgId, orgId), eq(integrationSecrets.name, "github_app.webhook_secret")));
  } else {
    await storeSecret(context, box, "github_app.webhook_secret", app.webhookSecret);
  }
}
