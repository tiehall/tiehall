import type { GitHubStub, StubApp } from "@tiehall/testing/github";
import {
  createInstallGitHub,
  createLogger,
  createSignInService,
  readInstallations,
  storeGitHubApp,
  type InstallGitHub,
  type SecretBox,
  type SignInService,
  type WebSessionCaller,
} from "../../src/index.ts";
import { URL_OF_INSTALL, type TestInstall } from "./install.ts";

// Signing in with GitHub against the GitHub stub, without a browser, for the
// tests of the sign-in service. The install stores an App the stub created,
// as the setup screen stores the App the manifest flow creates; a person then
// signs in as a browser does: the sign-in page's form starts the sign-in,
// GitHub's authorize page, played by the stub, sends them back with a code,
// and the sign-in service's callback turns it into a web session.

/** A browser's cookies, by name, as the answers it got set them. */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  /** Takes the cookies an answer sets, and drops those it expires. */
  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === "";
      if (expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  /** The Cookie header this browser sends. */
  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  names(): string[] {
    return [...this.#cookies.keys()];
  }

  /** A copy, such as a second tab of the same browser. */
  copy(): CookieJar {
    const jar = new CookieJar();
    for (const [name, value] of this.#cookies) jar.#cookies.set(name, value);
    return jar;
  }
}

export interface SignInAttempt {
  /** The sign-in service's answer to GitHub's return. */
  response: Response;
  /** The browser's cookies after it. */
  jar: CookieJar;
}

export interface SignInHarness {
  service: SignInService;
  /** The App the install stores, created on the stub. */
  app: StubApp;
  box: SecretBox;
  /**
   * Signs in as the stub's user with this login, from a browser with these
   * cookies or a fresh one, sending these headers with each request, such as
   * its X-Forwarded-For and User-Agent.
   */
  signIn(login: string, options?: { jar?: CookieJar; headers?: Record<string, string> }): Promise<SignInAttempt>;
  /** The web session a browser with these cookies is signed in with, or undefined. */
  sessionOf(jar: CookieJar): Promise<WebSessionCaller | undefined>;
  /** Stores another client secret for the App, as a rotated one would be stored, in place of the one stored. */
  storeClientSecret(secret: string): Promise<void>;
  /** The install's App, as the worker and the web role reach it, calling the stub. */
  github: InstallGitHub;
  /**
   * Lists the App's installations as a sync does, and connects the ones on
   * these GitHub accounts, as an admin's connection does; returns Tiehall's
   * ids of those, by account login.
   */
  connect(...accounts: string[]): Promise<Record<string, string>>;
}

/** Creates the App on the stub, stores its credentials in the install, and builds the sign-in service against the stub. */
export async function startSignIn(
  install: TestInstall,
  stub: GitHubStub,
  options: { owner?: string; fetch?: typeof fetch; sameAppAs?: SignInHarness; hook?: { url: string } } = {},
): Promise<SignInHarness> {
  // Another sign-in service for the App a harness stored, such as one whose fetch fails some calls, or a new App.
  const app =
    options.sameAppAs?.app ??
    stub.createApp({
      owner: options.owner ?? "acme",
      callbackUrls: [`${URL_OF_INSTALL}/api/auth/callback/github`],
      // An App with a webhook, whose deliveries the stub logs with what GitHub sent, for a test to store.
      ...(options.hook === undefined ? {} : { hook: options.hook }),
    });
  const box = options.sameAppAs?.box ?? install.box;
  const store = (clientSecret: string) =>
    install.db.transaction(async (tx) => {
      const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM orgs");
      await storeGitHubApp({ tx, orgId: rows[0]?.id ?? "" }, box, {
        id: app.id,
        slug: app.slug,
        name: app.name,
        clientId: app.clientId,
        clientSecret,
        privateKey: app.pem,
        webhookSecret: app.webhookSecret,
        owner: { login: app.owner.login, type: app.owner.type },
      });
    });
  if (options.sameAppAs === undefined) await store(app.clientSecret);
  const service = createSignInService({
    database: install.db,
    url: URL_OF_INSTALL,
    secret: () => install.authSecret,
    secrets: () => box,
    // The stub serves on local ports, which the service reaches with the plain fetch; at an install it reaches GitHub only.
    github: { webUrl: stub.webUrl, apiUrl: stub.apiUrl, fetch: options.fetch ?? fetch },
    logger: process.env["DEBUG_SIGN_IN"] === undefined ? install.logger : createLogger(),
  });

  async function signIn(login: string, { jar = new CookieJar(), headers = {} }: { jar?: CookieJar; headers?: Record<string, string> } = {}): Promise<SignInAttempt> {
    const started = await service.page(
      new Request(`${URL_OF_INSTALL}/sign-in`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, cookie: jar.header() },
        body: new URLSearchParams({ return: "/" }).toString(),
      }),
    );
    if (started.status !== 303) throw new Error(`the sign-in page answered ${started.status}: ${await started.text()}`);
    jar.take(started);
    const authorize = new URL(started.headers.get("location") ?? "");
    const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
    const codeChallenge = authorize.searchParams.get("code_challenge") ?? undefined;
    const code = stub.authorize(app, login, { redirectUri, ...(codeChallenge === undefined ? {} : { codeChallenge }) });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const response = await service.handler(new Request(back, { headers: { ...headers, cookie: jar.header() } }));
    jar.take(response);
    return { response, jar };
  }

  const github = createInstallGitHub({ database: install.db, secrets: () => box, apiUrl: stub.apiUrl, fetch: options.fetch ?? fetch, logger: install.logger });

  async function connect(...accounts: string[]): Promise<Record<string, string>> {
    const access = await github.app();
    if (access === undefined) throw new Error("the install stores no App");
    await readInstallations({ database: install.db, app: access });
    const ids: Record<string, string> = {};
    for (const account of accounts) {
      const { rows } = await install.owner.query<{ id: string }>(
        `INSERT INTO github_connected_installations (org_id, installation_id)
           SELECT org_id, id FROM github_installations WHERE account_login = $1 AND deleted_at IS NULL
         ON CONFLICT DO NOTHING RETURNING installation_id AS id`,
        [account],
      );
      const known = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = $1", [account]);
      ids[account] = rows[0]?.id ?? known.rows[0]?.id ?? "";
    }
    return ids;
  }

  return {
    service,
    app,
    box,
    signIn,
    sessionOf: (jar) => service.session(new Headers({ cookie: jar.header() })),
    storeClientSecret: store,
    github,
    connect,
  };
}
