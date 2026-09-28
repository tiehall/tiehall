import { randomBytes } from "node:crypto";
import type { GitHubStub, StubApp, StubDelivery } from "@tiehall/testing/github";
import { createInstallGitHub, openSecretBox, storeGitHubApp, type InstallGitHub, type SecretBox } from "../../src/index.ts";
import type { TestInstall } from "./install.ts";

// The install's GitHub App for the tests of what Tiehall does with GitHub: an
// App the GitHub stub created, stored in the install as the setup screen
// stores the App the manifest flow creates, and the client that calls GitHub
// as it, pointed at the stub.

export interface StoredStubApp {
  box: SecretBox;
  /** The install's App, as the worker and the web role reach it, calling the stub. */
  github: InstallGitHub;
}

/** Stores the stub's App in the install, with its credentials encrypted, and returns what calls GitHub as it. */
export async function storeStubApp(install: TestInstall, stub: GitHubStub, app: StubApp): Promise<StoredStubApp> {
  const box = openSecretBox(randomBytes(32).toString("base64url"));
  await install.db.transaction(async (tx) => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM orgs");
    await storeGitHubApp({ tx, orgId: rows[0]?.id ?? "" }, box, {
      id: app.id,
      slug: app.slug,
      name: app.name,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      privateKey: app.pem,
      webhookSecret: app.webhookSecret,
      owner: { login: app.owner.login, type: app.owner.type },
    });
  });
  // The stub serves on local ports, which the client reaches with the plain fetch; at an install it reaches GitHub only.
  return { box, github: createInstallGitHub({ database: install.db, secrets: () => box, apiUrl: stub.apiUrl, fetch, logger: install.logger }) };
}

/** Stores a delivery the stub made as /webhooks/github stores a verified one once setup is complete, ready to be processed. */
export async function storeDelivery(install: TestInstall, delivery: StubDelivery): Promise<string> {
  await install.owner.query(
    "INSERT INTO github_deliveries (org_id, delivery_id, event, payload, enqueued_at) SELECT id, $1, $2, $3, now() FROM orgs",
    [delivery.guid, delivery.event, JSON.stringify(delivery.request.payload)],
  );
  return delivery.guid;
}
