import { githubApp, integrationSecrets, orgs, type Database } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { createGitHubClient, GITHUB_API_URL } from "./github-client.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { readSecret } from "./integration-secrets.ts";
import { createLogger, type Logger } from "./log.ts";
import { createGitHubFetch } from "./outbound.ts";
import type { SecretBox } from "./secret-box.ts";

// The install's own GitHub App, as every outbound call to GitHub's API reaches
// it (tracker-mirrors: GitHub writes appear as the App's bot; agent-access:
// Outbound calls use Tiehall's own credentials; design.md, Technical
// decisions: T16). Tiehall calls GitHub's API only as the App the setup screen
// stored, with a JSON web token signed by the App's stored private key, or as
// one of its installations, with an installation token that the App's token
// requests; never with a user's token or a token a client presented to
// Tiehall, which nothing here can even take. The client is built from the
// stored credentials when it is first asked for, and built again when they
// change, such as after an uploaded key or a new App; until then it keeps the
// installation tokens it holds in memory. Its fetch reaches GitHub's own hosts
// only, unless a test points it at the GitHub stub.

export interface InstallGitHubOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** TIEHALL_SECRET_KEY's box, which opens the App's stored private key. */
  secrets: () => SecretBox;
  /** GitHub's REST API, which a test points at the GitHub stub; https://api.github.com otherwise. */
  apiUrl?: string;
  /** The fetch the calls go through; one that reaches GitHub's own hosts only, unless a test gives another. */
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface InstallGitHub {
  /** The install's App as stored now, with a client that calls GitHub as it; undefined while none is stored. */
  app(): Promise<GitHubAppAccess | undefined>;
}

export function createInstallGitHub(options: InstallGitHubOptions): InstallGitHub {
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const fetchImpl = options.fetch ?? (createGitHubFetch(fetch) as typeof fetch);
  let built: { key: string; access: GitHubAppAccess } | undefined;
  return {
    async app() {
      const stored = await options.database.transaction(async (tx) => {
        const [row] = await tx
          .select({
            orgId: orgs.id,
            appId: githubApp.appId,
            clientId: githubApp.clientId,
            keyId: integrationSecrets.keyId,
            updatedAt: integrationSecrets.updatedAt,
          })
          .from(orgs)
          .innerJoin(githubApp, eq(githubApp.orgId, orgs.id))
          .innerJoin(integrationSecrets, and(eq(integrationSecrets.orgId, orgs.id), eq(integrationSecrets.name, "github_app.private_key")))
          .limit(1);
        if (row === undefined) return undefined;
        const key = `${row.appId}:${row.clientId}:${row.keyId}:${row.updatedAt.toISOString()}`;
        if (built?.key === key) return { key, access: built.access };
        const privateKey = await readSecret({ tx, orgId: row.orgId }, options.secrets(), "github_app.private_key");
        if (privateKey === undefined) return undefined;
        const client = createGitHubClient({ clientId: row.clientId, privateKey }, { apiUrl: options.apiUrl ?? GITHUB_API_URL, fetch: fetchImpl, logger });
        return { key, access: { appId: row.appId, client } };
      });
      if (stored === undefined) return undefined;
      built = stored;
      return stored.access;
    },
  };
}
