import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { z } from "zod";
import { createLogger, LOGGABLE, type Logger } from "./log.ts";

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
// One call takes no credential at all: the conversion of the code that
// GitHub's manifest flow returns into the new App's credentials
// (self-host-install: The GitHub App is created with GitHub's manifest flow).
//
// This is the part of the client that tasks 1.9 of github-app-reachability
// and 7.4 of add-tiehall-oss-v1 need; task 10.5 of add-tiehall-oss-v1 moves
// every outbound GitHub call onto it.

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
  /** The fetch the calls go through; the platform's unless a test gives another. */
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface GitHubClient {
  /** Calls GitHub as the App itself, such as `GET /app/installations`. */
  app(): Octokit;
  /** Calls GitHub as one installation of the App, with its installation token. */
  installation(installationId: number): Octokit;
}

export const GITHUB_API_URL = "https://api.github.com";

/** What every Octokit of the client shares: GitHub's API, Tiehall's user agent, the fetch and the logger. */
function octokitBase(options: GitHubClientOptions) {
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  return {
    baseUrl: options.apiUrl ?? GITHUB_API_URL,
    userAgent: "tiehall",
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    // Octokit's own notices, such as a retry after a 401, go through Tiehall's logger and its redaction.
    log: {
      debug: () => {},
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
    },
  };
}

export function createGitHubClient(credentials: GitHubAppCredentials, options: GitHubClientOptions = {}): GitHubClient {
  const base = octokitBase(options);
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

/**
 * A new App's credentials, as GitHub's manifest conversion returns them. GitHub
 * gives no webhook secret for an App created without a webhook
 * (github-app-reachability: design.md, Design rules: An App without a webhook).
 */
export interface ConvertedApp {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  /** The App's private key, as PEM. */
  privateKey: string;
  webhookSecret: string | null;
  owner: { login: string; type: "Organization" | "User" };
}

const CONVERSION = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pem: z.string().min(1),
  webhook_secret: z.string().min(1).nullable(),
  owner: z.object({ login: z.string().min(1), type: z.enum(["Organization", "User"]) }),
});

/** GitHub did not convert a manifest's code; its message names the status and nothing of the code. */
export class ManifestConversionError extends Error {
  override name = "ManifestConversionError";
  readonly [LOGGABLE] = true;
  /** GitHub's HTTP status, or undefined when GitHub could not be reached or answered in another shape. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** A manifest code as GitHub issues it: letters, digits, `_` and `-`. */
const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Exchanges the code GitHub's manifest flow returned for the new App's
 * credentials, at POST /app-manifests/{code}/conversions. GitHub converts a
 * code once, within an hour of issuing it. It throws ManifestConversionError
 * when GitHub does not convert it.
 */
export async function convertManifestCode(code: string, options: GitHubClientOptions = {}): Promise<ConvertedApp> {
  if (!MANIFEST_CODE.test(code)) throw new ManifestConversionError("GitHub's return carries no code in the form GitHub issues.");
  const octokit = new Octokit(octokitBase(options));
  let data: unknown;
  try {
    ({ data } = await octokit.request("POST /app-manifests/{code}/conversions", { code }));
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
    throw new ManifestConversionError(
      status === undefined ? "GitHub could not be reached to convert the code." : `GitHub answered ${status} to the conversion of the code.`,
      status,
    );
  }
  const parsed = CONVERSION.safeParse(data);
  if (!parsed.success) throw new ManifestConversionError("GitHub's conversion of the code lacks the App's credentials.");
  const app = parsed.data;
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    privateKey: app.pem,
    webhookSecret: app.webhook_secret,
    owner: { login: app.owner.login, type: app.owner.type },
  };
}
