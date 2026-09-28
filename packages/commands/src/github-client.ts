import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { createLogger, type Logger } from "./log.ts";

// The GitHub client (design.md, Technical decisions: T16; tracker-mirrors:
// GitHub writes appear as the App's bot; sign-in: Tiehall keeps no GitHub user
// token). Tiehall calls GitHub with the install's own GitHub App only: as the
// App, with a JSON web token whose issuer is the App's client id, or as one of
// the App's installations, with an installation token. It takes no other
// credential, so no call can carry a user's GitHub token or a token a client
// presented to Tiehall.
//
// Installation tokens (github-app-reachability: design.md, Design rules:
// Installation tokens; Technical decisions: T5): each is requested with the
// App's JWT, kept in memory until shortly before it expires, and sent on
// exactly as GitHub issued it. Nothing here assumes its length or its shape,
// because GitHub is moving these tokens to a format of about 520 characters,
// and nothing stores one: no column of the schema holds an installation token.
//
// This is the part of the client that task 1.9 of github-app-reachability
// needs; task 10.5 of add-tiehall-oss-v1 moves every outbound GitHub call onto
// it.

/** The App's credentials from the manifest conversion, as the setup screen stores them. */
export interface GitHubAppCredentials {
  /** The App's client id, the issuer of its JSON web tokens. */
  clientId: string;
  /** The App's private key, as PEM. */
  privateKey: string;
}

export interface GitHubClientOptions {
  /** GitHub's REST API; https://api.github.com unless a test points it at the GitHub stub. */
  apiUrl?: string;
  logger?: Logger;
}

export interface GitHubClient {
  /** Calls GitHub as the App itself, such as `GET /app/installations`. */
  app(): Octokit;
  /** Calls GitHub as one installation of the App, with its installation token. */
  installation(installationId: number): Octokit;
}

export const GITHUB_API_URL = "https://api.github.com";

export function createGitHubClient(credentials: GitHubAppCredentials, options: GitHubClientOptions = {}): GitHubClient {
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const base = {
    baseUrl: options.apiUrl ?? GITHUB_API_URL,
    userAgent: "tiehall",
    // Octokit's own notices, such as a retry after a 401, go through Tiehall's logger and its redaction.
    log: {
      debug: () => {},
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
    },
  };
  const auth = { appId: credentials.clientId, privateKey: credentials.privateKey, log: base.log };
  const app = new Octokit({ ...base, authStrategy: createAppAuth, auth });
  // One Octokit per installation, so each keeps its installation token in its own memory cache.
  const installations = new Map<number, Octokit>();
  return {
    app: () => app,
    installation(installationId) {
      let octokit = installations.get(installationId);
      if (octokit === undefined) {
        octokit = new Octokit({ ...base, authStrategy: createAppAuth, auth: { ...auth, installationId } });
        installations.set(installationId, octokit);
      }
      return octokit;
    },
  };
}
