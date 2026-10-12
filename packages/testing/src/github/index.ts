import { createPublicKey } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Urls } from "./json.ts";
import type { ParsedManifest, Permission } from "./manifest.ts";
import { checkAppName } from "./manifest.ts";
import { createHandlers, tokenKind, type RecordedRequest, type StubHost, type StubRequest, type StubResponse, type TokenKind } from "./server.ts";
import { Deliveries, type DeliveryOptions, type StubDelivery } from "./webhooks.ts";
import { GitHubWorld, type MemberAnswers, type StubAccount, type StubApp, type StubEmail, type StubInstallation, type StubIssue, type StubOrg, type StubPullRequest, type StubRepo, type StubUser } from "./world.ts";

// The GitHub stub every GitHub test runs against (add-tiehall-oss-v1:
// design.md, Technical decisions: T17; github-app-reachability: design.md,
// Technical decisions: T4). No test calls GitHub for real. The stub serves
// github.com and api.github.com on two local ports, answers as GitHub did when
// the spikes of tasks 1.5 and 1.6 ran against it (its contract tests replay
// those records), and lets a test change GitHub's side: accounts and
// organizations, repositories, Apps, installations, pull requests, issues,
// and the webhook deliveries each change causes.
//
// What it plays:
// - the manifest flow: the new-App pages, GitHub's refusals of a manifest,
//   the confirmation, and the code conversion (webhook_secret null for an App
//   without a webhook);
// - user authorization: the authorize page, the token endpoint with expiring
//   user tokens and refresh tokens, /user and /user/emails;
// - the App JWT check, installations and their repositories with GitHub's
//   Link paging, installation tokens (520 characters by default, any length
//   on request), organization membership lookups, pull requests, and issues
//   written as the App's bot;
// - signed webhook deliveries it sends, drops or redelivers, and the App's
//   delivery log, which answers 404 for an App without a webhook.

export { signAppJwt, verifyAppJwt, type AppJwtOptions } from "./jwt.ts";
export { DEFAULT_INSTALLATION_TOKEN_LENGTH, makeInstallationToken } from "./tokens.ts";
export { FAILED_DELIVERY, signBody, type DeliveryMode, type DeliveryOptions, type StubDelivery } from "./webhooks.ts";
export type { RecordedRequest, StubHost, TokenKind } from "./server.ts";
export type { Permission } from "./manifest.ts";
export type { MemberAnswers, StubAccount, StubApp, StubEmail, StubInstallation, StubIssue, StubOrg, StubPullRequest, StubRepo, StubUser } from "./world.ts";

/** The permissions of Tiehall's own App, the default of an App a test creates. */
const TIEHALL_PERMISSIONS: Readonly<Record<string, Permission>> = {
  metadata: "read",
  pull_requests: "read",
  issues: "write",
  members: "read",
  emails: "read",
};

export interface GitHubStubOptions {
  /** Serves both faces over HTTPS with this key and certificate, for a browser that must not leave HTTPS. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** The length of the installation tokens it issues: 520 by default. */
  installationTokenLength?: number;
  /**
   * Where it sends a delivery for a hook URL, or undefined when GitHub cannot
   * reach it. By default a hook URL on loopback is used as it is, and any
   * other fails, so the stub never reaches the network outside the test.
   */
  routeHook?: (url: URL) => string | undefined;
  /** Hook URLs the new-App page refuses as unreachable, besides those on localhost. */
  unreachableHookUrls?: readonly string[];
  /** The clock, in milliseconds since the epoch. */
  now?: () => number;
  /**
   * The address both faces listen on: 127.0.0.1 unless given, such as
   * 0.0.0.0 for an install whose containers reach the stub through the
   * host's gateway. The URLs the stub names stay on 127.0.0.1.
   */
  listenHost?: string;
}

export interface CreateAppInput {
  /** The login of the user or organization that owns the App. */
  owner: string;
  name?: string;
  permissions?: Record<string, Permission>;
  /** The subscribed events: pull_request, issues and organization by default when the App has a hook, none otherwise. */
  events?: string[];
  /** The webhook, or null (the default) for none. */
  hook?: { url: string; active?: boolean } | null;
  public?: boolean;
  url?: string;
  redirectUrl?: string | null;
  callbackUrls?: string[];
  setupUrl?: string | null;
}

export type ManifestOutcome =
  | { status: "refused"; messages: string[] }
  | { status: "created"; app: StubApp; code: string; location: URL };

export interface GitHubStub {
  /** Where the stub serves github.com. */
  readonly webUrl: string;
  /** Where the stub serves api.github.com. */
  readonly apiUrl: string;
  /** Every request it received, in order, with its answer's status. */
  readonly received: readonly RecordedRequest[];
  /** fetch() that sends https://github.com and https://api.github.com to the stub, and refuses any other host. */
  readonly fetch: typeof fetch;
  /** The stub's address for a github.com or api.github.com URL. */
  rewrite(url: string | URL): string;
  /** Waits for every delivery in flight, then stops both servers. */
  close(): Promise<void>;
  /** Waits until every delivery started so far is logged. */
  settled(): Promise<void>;

  addUser(input: { login: string; id?: number; name?: string | null; email?: string; emails?: StubEmail[] }): StubUser;
  addOrg(input: { login: string; id?: number; name?: string | null; members?: Record<string, "admin" | "member"> }): StubOrg;
  addMember(org: string, login: string, role?: "admin" | "member", options?: DeliveryOptions): Promise<StubDelivery[]>;
  removeMember(org: string, login: string, options?: DeliveryOptions): Promise<StubDelivery[]>;
  renameUser(login: string, newLogin: string): StubUser;
  /** Renames an organization, as its owner does on GitHub; another organization may then take the old login. */
  renameOrg(login: string, newLogin: string): StubOrg;
  /** A member makes their membership public, or private again, as on GitHub's people page. */
  setMembershipPublic(org: string, login: string, isPublic: boolean): void;
  /** GitHub serves every requester the organization's public members only, as it may once an owner removed the Members permission. */
  setMembersPublicOnly(org: string, publicOnly: boolean): void;
  /**
   * How the stub answers a requester that may not see an organization's members: "forbidden", with 403, by default,
   * or "documented", as GitHub documents it: a 302 to the public membership check, and the public members only.
   */
  setMemberAnswers(answers: MemberAnswers): void;
  /** Changes the permissions an installation holds, as an owner who declines or removes one; tokens issued from then on carry them. */
  setInstallationPermissions(installation: StubInstallation, permissions: Record<string, Permission>): void;
  setEmails(login: string, emails: StubEmail[]): void;
  addRepo(fullName: string, options?: { private?: boolean; id?: number }): StubRepo;
  /** The account a browser acts as on the stub's github.com unless its cookie names another; none signs the browser out. */
  signIn(login: string | undefined): void;

  createApp(input: CreateAppInput): StubApp;
  /** The manifest flow without a browser: posts the manifest to the new-App page and confirms it, as the signed-in user or `as`. */
  createAppFromManifest(input: { manifest: Record<string, unknown> | string; org?: string; state?: string; as?: string; name?: string }): Promise<ManifestOutcome>;
  apps(): StubApp[];
  /** An App by id, slug, name or client id. */
  app(ref: number | string): StubApp;
  /** Changes an App's settings, as its settings page on GitHub does. */
  updateApp(app: StubApp, changes: { hook?: { url: string; active?: boolean } | null; webhookSecret?: string | null; events?: string[]; public?: boolean }): void;
  addClientSecret(app: StubApp): string;
  addPrivateKey(app: StubApp): string;
  /** Deletes one of the App's private keys, as its settings page does: a JWT it signs is refused from then on. */
  deletePrivateKey(app: StubApp, pem: string): void;

  /** The live installations, of one App or of every App. */
  installations(app?: StubApp): StubInstallation[];
  installation(id: number): StubInstallation;
  install(app: StubApp, input: { account: string; repositories?: "all" | string[]; by?: string }, options?: DeliveryOptions): Promise<StubInstallation>;
  suspend(installation: StubInstallation, options?: DeliveryOptions): Promise<void>;
  unsuspend(installation: StubInstallation, options?: DeliveryOptions): Promise<void>;
  uninstall(installation: StubInstallation, options?: DeliveryOptions): Promise<void>;
  addRepositories(installation: StubInstallation, fullNames: string[], options?: DeliveryOptions): Promise<void>;
  removeRepositories(installation: StubInstallation, fullNames: string[], options?: DeliveryOptions): Promise<void>;
  setInstallationTokenLength(length: number): void;
  /** The installation tokens the stub issued, oldest first: of one installation, or of every one. */
  issuedInstallationTokens(installation?: StubInstallation): string[];
  /** Makes the new-App page refuse this hook URL as unreachable, with GitHub's refusal page. */
  refuseHookUrl(url: string): void;
  /** False plays an install GitHub cannot reach: every delivery fails until it is true again. */
  setHookReachable(reachable: boolean): void;
  setHookRoute(route: (url: URL) => string | undefined): void;

  /** The App's delivery log, oldest first. */
  deliveries(app: StubApp): StubDelivery[];
  /** Sends any event to the App's webhook, as GitHub would. */
  deliver(app: StubApp, event: string, payload: Record<string, unknown>, options?: DeliveryOptions): Promise<StubDelivery | undefined>;
  redeliver(delivery: StubDelivery): Promise<StubDelivery | undefined>;

  openPullRequest(
    repo: string,
    input: { title: string; body?: string | null; head: string; base?: string; author: string; draft?: boolean },
    options?: DeliveryOptions,
  ): Promise<StubPullRequest>;
  editPullRequest(repo: string, number: number, changes: { title?: string; body?: string | null; head?: string }, options?: DeliveryOptions): Promise<StubPullRequest>;
  mergePullRequest(repo: string, number: number, input: { by: string }, options?: DeliveryOptions): Promise<StubPullRequest>;
  closePullRequest(repo: string, number: number, input: { by: string }, options?: DeliveryOptions): Promise<StubPullRequest>;
  reopenPullRequest(repo: string, number: number, input: { by: string }, options?: DeliveryOptions): Promise<StubPullRequest>;
  pullRequest(repo: string, number: number): StubPullRequest;
  issue(repo: string, number: number): StubIssue;
  closeIssue(repo: string, number: number, input: { by: string; reason?: "completed" | "not_planned" | "duplicate" }, options?: DeliveryOptions): Promise<StubIssue>;
  reopenIssue(repo: string, number: number, input: { by: string }, options?: DeliveryOptions): Promise<StubIssue>;
  /** Deletes the issue, as an admin of its repository may: GitHub answers every later call about it with 410, and delivers its `deleted` event. */
  deleteIssue(repo: string, number: number, input: { by: string }, options?: DeliveryOptions): Promise<StubIssue>;
  assignIssue(repo: string, number: number, input: { by: string; assignees: string[] }, options?: DeliveryOptions): Promise<StubIssue>;

  /** A user authorization without a browser: the code the callback would receive. */
  authorize(app: StubApp, login: string, input?: { redirectUri?: string; codeChallenge?: string }): string;
  /** User tokens as the token endpoint would issue them to the App for this user. */
  userTokens(app: StubApp, login: string): Promise<{ accessToken: string; refreshToken: string }>;
  /** What the stub issued a credential as. */
  tokenKind(token: string): TokenKind;
  expireInstallationTokens(): void;
  expireUserTokens(): void;
  /** Moves the stub's clock; an App JWT signed on the real clock can then look expired or early. */
  advanceClock(ms: number): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function loopbackOnly(url: URL): string | undefined {
  return LOOPBACK.has(url.hostname) ? url.href : undefined;
}

function normalizedUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

export async function startGitHubStub(options: GitHubStubOptions = {}): Promise<GitHubStub> {
  const world = new GitHubWorld(options.now);
  if (options.installationTokenLength !== undefined) world.installationTokenLength = options.installationTokenLength;
  const refused = new Set((options.unreachableHookUrls ?? []).map(normalizedUrl));
  let urls: Urls = { api: "", web: "" };
  let webUser: string | undefined;
  const deliveries = new Deliveries(world, () => urls, options.routeHook ?? loopbackOnly);
  const handlers = createHandlers({
    world,
    deliveries,
    urls: () => urls,
    webUser: () => {
      const account = webUser === undefined ? undefined : world.findAccount(webUser);
      return account?.type === "User" ? account : undefined;
    },
    unreachable: (url) => {
      if (url.hostname === "localhost") return "localhost";
      return refused.has(url.href) ? url.hostname : undefined;
    },
  });
  const received: RecordedRequest[] = [];
  const web = await listen("web", handlers.web, received, world, options.tls, options.listenHost);
  const api = await listen("api", handlers.api, received, world, options.tls, options.listenHost);
  urls = { web: web.url, api: api.url };

  const rewrite = (url: string | URL): string => {
    const parsed = new URL(url);
    const base = parsed.origin === "https://github.com" ? urls.web : parsed.origin === "https://api.github.com" ? urls.api : undefined;
    if (base === undefined) throw new Error(`the GitHub stub serves only https://github.com and https://api.github.com, not ${parsed.origin}`);
    return `${base}${parsed.pathname}${parsed.search}`;
  };

  const stubFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) return fetch(new Request(rewrite(input.url), input), init);
    return fetch(rewrite(input), init);
  }) as typeof fetch;

  const repo = (fullName: string): StubRepo => world.repo(fullName);
  const pr = (fullName: string, number: number): StubPullRequest => {
    const found = world.item(repo(fullName), number);
    if (found?.kind !== "pull_request") throw new Error(`${fullName} has no pull request #${number}`);
    return found;
  };
  const issue = (fullName: string, number: number): StubIssue => {
    const found = world.item(repo(fullName), number);
    if (found?.kind !== "issue") throw new Error(`${fullName} has no issue #${number}`);
    return found;
  };
  const mode = (options?: DeliveryOptions) => options?.delivery;
  let appCount = 0;

  /** Who GitHub names as the sender of a change to an account: the user, or the organization's first admin. */
  const senderFor = (account: StubAccount, by?: string): StubUser => {
    if (by !== undefined) return world.user(by);
    if (account.type === "User") return account;
    for (const [id, membership] of account.members) {
      const user = world.accountById(id);
      if (membership.role === "admin" && user?.type === "User") return user;
    }
    throw new Error(`name who acts for ${account.login} with \`by\`: it has no admin`);
  };

  const stub: GitHubStub = {
    webUrl: urls.web,
    apiUrl: urls.api,
    received,
    fetch: stubFetch,
    rewrite,
    async close() {
      await deliveries.settled();
      await Promise.all([web.close(), api.close()]);
    },
    settled: () => deliveries.settled(),

    addUser: (input) => world.addUser(input),
    addOrg(input) {
      const org = world.addOrg(input);
      for (const [login, role] of Object.entries(input.members ?? {})) org.members.set(world.user(login).id, { role, state: "active" });
      return org;
    },
    async addMember(orgLogin, login, role = "member", options) {
      const org = world.org(orgLogin);
      const user = world.user(login);
      org.members.set(user.id, { role, state: "active" });
      return deliveries.organization(org, "member_added", user, role, senderFor(org), mode(options));
    },
    async removeMember(orgLogin, login, options) {
      const org = world.org(orgLogin);
      const user = world.user(login);
      const membership = org.members.get(user.id);
      if (membership === undefined) throw new Error(`${login} is not a member of ${orgLogin}`);
      org.members.delete(user.id);
      return deliveries.organization(org, "member_removed", user, membership.role, senderFor(org), mode(options));
    },
    renameUser(login, newLogin) {
      if (world.findAccount(newLogin) !== undefined) throw new Error(`${newLogin} is taken`);
      const user = world.user(login);
      user.login = newLogin;
      return user;
    },
    renameOrg(login, newLogin) {
      if (world.findAccount(newLogin) !== undefined) throw new Error(`${newLogin} is taken`);
      const org = world.org(login);
      org.login = newLogin;
      return org;
    },
    setMembershipPublic(orgLogin, login, isPublic) {
      const membership = world.org(orgLogin).members.get(world.user(login).id);
      if (membership === undefined) throw new Error(`${login} is not a member of ${orgLogin}`);
      membership.public = isPublic;
    },
    setMembersPublicOnly(orgLogin, publicOnly) {
      world.org(orgLogin).membersPublicOnly = publicOnly;
    },
    setMemberAnswers(answers) {
      world.memberAnswers = answers;
    },
    setInstallationPermissions(installation, permissions) {
      installation.permissions = { ...permissions };
    },
    setEmails(login, emails) {
      world.user(login).emails = emails.map((email) => ({ ...email }));
    },
    addRepo: (fullName, repoOptions) => world.addRepo(fullName, repoOptions),
    signIn(login) {
      if (login !== undefined) world.user(login);
      webUser = login;
    },

    createApp(input) {
      appCount += 1;
      const name = input.name ?? `Tiehall test app ${appCount}`;
      const refusal = checkAppName(name, (candidate) => world.appByName(candidate) !== undefined);
      if (refusal !== undefined) throw new Error(refusal);
      const hook = input.hook === undefined || input.hook === null ? null : { url: input.hook.url, active: input.hook.active ?? true };
      const manifest: ParsedManifest = {
        name,
        url: input.url ?? "https://tiehall.example.com",
        description: "",
        hook,
        redirectUrl: input.redirectUrl === undefined ? "https://tiehall.example.com/setup/github/app" : input.redirectUrl,
        callbackUrls: input.callbackUrls ?? ["https://tiehall.example.com/api/auth/callback/github"],
        setupUrl: input.setupUrl ?? null,
        public: input.public ?? false,
        permissions: { ...(input.permissions ?? TIEHALL_PERMISSIONS) },
        events: input.events ?? (hook === null ? [] : ["pull_request", "issues", "organization"]),
      };
      const app = world.createApp(manifest, world.account(input.owner));
      void deliveries.ping(app);
      return app;
    },
    async createAppFromManifest(input) {
      const user = input.as === undefined ? (webUser === undefined ? undefined : world.user(webUser)) : world.user(input.as);
      const submitted = handlers.submitManifest({
        manifest: typeof input.manifest === "string" ? input.manifest : JSON.stringify(input.manifest),
        ...(input.org === undefined ? {} : { org: input.org }),
        ...(user === undefined ? {} : { user }),
        ...(input.state === undefined ? {} : { state: input.state }),
      });
      if (submitted.kind === "refused") return { status: "refused", messages: submitted.messages };
      if (submitted.kind !== "confirm") throw new Error(submitted.kind === "sign-in" ? "sign a user in to the stub first" : `${input.org} is not an organization its user owns`);
      const outcome = handlers.confirmRegistration(submitted.registration.id, input.name);
      if (outcome.kind === "retry") {
        world.pending.delete(submitted.registration.id);
        return { status: "refused", messages: [outcome.message] };
      }
      if (outcome.kind !== "created") throw new Error("the registration vanished");
      return { status: "created", app: outcome.app, code: outcome.code, location: outcome.location };
    },
    apps: () => [...world.apps.values()],
    app(ref) {
      const found =
        typeof ref === "number"
          ? world.apps.get(ref)
          : (world.appBySlug(ref) ?? world.appByName(ref) ?? world.appByClientId(ref) ?? (/^\d+$/.test(ref) ? world.apps.get(Number(ref)) : undefined));
      if (found === undefined) throw new Error(`the stub has no App ${ref}`);
      return found;
    },
    updateApp(app, changes) {
      if (changes.hook !== undefined) {
        app.hook = changes.hook === null ? null : { id: app.hook?.id ?? world.id(), url: changes.hook.url, active: changes.hook.active ?? true };
      }
      if (changes.webhookSecret !== undefined) app.webhookSecret = changes.webhookSecret;
      if (changes.events !== undefined) app.events = [...changes.events];
      if (changes.public !== undefined) app.public = changes.public;
      app.updatedAt = world.timestamp();
    },
    addClientSecret: (app) => world.addClientSecret(app),
    addPrivateKey: (app) => world.addPrivateKey(app),
    deletePrivateKey(app, pem) {
      const deleted = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
      const kept = app.publicKeys.filter((key) => key.export({ type: "spki", format: "pem" }).toString() !== deleted);
      if (kept.length === app.publicKeys.length) throw new Error(`${app.name} has no such private key`);
      app.publicKeys.splice(0, app.publicKeys.length, ...kept);
    },

    installations: (app) =>
      app === undefined ? [...world.installations.values()].filter((installation) => !installation.deleted) : world.installationsOf(app),
    installation(id) {
      const found = world.installations.get(id);
      if (found === undefined) throw new Error(`the stub has no installation ${id}`);
      return found;
    },
    async install(app, input, options) {
      const account = world.account(input.account);
      if (!app.public && account.id !== app.owner.id) throw new Error(`${app.name} is private, so it installs only on ${app.owner.login}`);
      const sender = senderFor(account, input.by);
      if (!world.administers(sender, account)) throw new Error(`${sender.login} cannot install Apps on ${account.login}`);
      const repositories = input.repositories ?? "all";
      const existed = world.liveInstallation(app, account) !== undefined;
      const installation = world.install(app, account, repositories === "all" ? "all" : repositories.map(repo));
      if (!existed) await deliveries.installation(installation, "created", sender, mode(options));
      return installation;
    },
    async suspend(installation, options) {
      const sender = senderFor(installation.account);
      installation.suspendedAt = world.timestamp();
      installation.suspendedBy = sender;
      await deliveries.installation(installation, "suspend", sender, mode(options));
    },
    async unsuspend(installation, options) {
      installation.suspendedAt = null;
      installation.suspendedBy = null;
      await deliveries.installation(installation, "unsuspend", senderFor(installation.account), mode(options));
    },
    async uninstall(installation, options) {
      await deliveries.installation(installation, "deleted", senderFor(installation.account), mode(options));
      installation.deleted = true;
    },
    async addRepositories(installation, fullNames, options) {
      const added = fullNames.map(repo).filter((candidate) => !installation.repositoryIds.has(candidate.id));
      if (installation.selection === "all") throw new Error("an installation on all repositories covers every repository already");
      for (const candidate of added) installation.repositoryIds.add(candidate.id);
      installation.updatedAt = world.timestamp();
      await deliveries.installationRepositories(installation, { added, removed: [] }, senderFor(installation.account), mode(options));
    },
    async removeRepositories(installation, fullNames, options) {
      const removed = fullNames.map(repo);
      if (installation.selection === "all") {
        installation.selection = "selected";
        for (const candidate of world.reposOf(installation.account)) installation.repositoryIds.add(candidate.id);
      }
      for (const candidate of removed) installation.repositoryIds.delete(candidate.id);
      installation.updatedAt = world.timestamp();
      await deliveries.installationRepositories(installation, { added: [], removed }, senderFor(installation.account), mode(options));
    },
    setInstallationTokenLength(length) {
      world.installationTokenLength = length;
    },
    issuedInstallationTokens: (installation) =>
      [...world.installationTokens.values()]
        .filter((grant) => installation === undefined || grant.installationId === installation.id)
        .map((grant) => grant.token),
    refuseHookUrl(url) {
      refused.add(normalizedUrl(url));
    },
    setHookReachable(reachable) {
      deliveries.hookReachable = reachable;
    },
    setHookRoute(route) {
      deliveries.route = route;
    },

    deliveries: (app) => deliveries.of(app),
    deliver: (app, event, payload, options) => deliveries.send(app, event, payload, mode(options)),
    redeliver(delivery) {
      return deliveries.redeliver(world.apps.get(delivery.appId)!, delivery);
    },

    async openPullRequest(fullName, input, options) {
      const opened = world.addPullRequest(repo(fullName), {
        title: input.title,
        body: input.body ?? null,
        head: input.head,
        ...(input.base === undefined ? {} : { base: input.base }),
        author: world.user(input.author),
        draft: input.draft ?? false,
      });
      await deliveries.pullRequest("opened", opened, opened.author, mode(options));
      return opened;
    },
    async editPullRequest(fullName, number, changes, options) {
      const found = pr(fullName, number);
      if (changes.title !== undefined) found.title = changes.title;
      if (changes.body !== undefined) found.body = changes.body;
      if (changes.head !== undefined) found.head = { ...found.head, ref: changes.head };
      found.updatedAt = world.timestamp();
      await deliveries.pullRequest("edited", found, found.author, mode(options));
      return found;
    },
    async mergePullRequest(fullName, number, input, options) {
      const found = pr(fullName, number);
      const now = world.timestamp();
      Object.assign(found, { state: "closed", merged: true, mergedAt: now, closedAt: now, updatedAt: now, mergeCommitSha: world.newCode().padEnd(40, "0") });
      await deliveries.pullRequest("closed", found, world.user(input.by), mode(options));
      return found;
    },
    async closePullRequest(fullName, number, input, options) {
      const found = pr(fullName, number);
      const now = world.timestamp();
      Object.assign(found, { state: "closed", closedAt: now, updatedAt: now });
      await deliveries.pullRequest("closed", found, world.user(input.by), mode(options));
      return found;
    },
    async reopenPullRequest(fullName, number, input, options) {
      const found = pr(fullName, number);
      Object.assign(found, { state: "open", closedAt: null, updatedAt: world.timestamp() });
      await deliveries.pullRequest("reopened", found, world.user(input.by), mode(options));
      return found;
    },
    pullRequest: pr,
    issue,
    async closeIssue(fullName, number, input, options) {
      const found = issue(fullName, number);
      const now = world.timestamp();
      Object.assign(found, { state: "closed", stateReason: input.reason ?? "completed", closedAt: now, closedBy: { kind: "user", user: world.user(input.by) }, updatedAt: now });
      await deliveries.issue("closed", found, world.user(input.by), mode(options));
      return found;
    },
    async deleteIssue(fullName, number, input, options) {
      const found = issue(fullName, number);
      world.deleteIssue(found);
      await deliveries.issue("deleted", found, world.user(input.by), mode(options));
      return found;
    },
    async reopenIssue(fullName, number, input, options) {
      const found = issue(fullName, number);
      Object.assign(found, { state: "open", stateReason: "reopened", closedAt: null, updatedAt: world.timestamp() });
      await deliveries.issue("reopened", found, world.user(input.by), mode(options));
      return found;
    },
    async assignIssue(fullName, number, input, options) {
      const found = issue(fullName, number);
      found.assigneeIds = input.assignees.map((login) => world.user(login).id);
      found.updatedAt = world.timestamp();
      await deliveries.issue("assigned", found, world.user(input.by), mode(options));
      return found;
    },

    authorize(app, login, input = {}) {
      return handlers.authorize(app, world.user(login), input.redirectUri ?? app.callbackUrls[0] ?? app.url, input.codeChallenge ?? null);
    },
    async userTokens(app, login) {
      const { access, refresh } = world.issueUserTokens(app, world.user(login).id);
      world.authorizations.add(`${app.id}:${access.userId}`);
      return { accessToken: access.token, refreshToken: refresh.token };
    },
    tokenKind: (token) => tokenKind(world, token),
    expireInstallationTokens() {
      for (const grant of world.installationTokens.values()) grant.expiresAt = world.now() - 1;
    },
    expireUserTokens() {
      for (const grant of world.userTokens.values()) grant.expiresAt = world.now() - 1;
    },
    advanceClock: (ms) => world.advanceClock(ms),
  };
  return stub;
}

interface Listening {
  url: string;
  close(): Promise<void>;
}

async function listen(
  host: StubHost,
  handle: (request: StubRequest) => Promise<StubResponse>,
  received: RecordedRequest[],
  world: GitHubWorld,
  tls: GitHubStubOptions["tls"],
  listenHost = "127.0.0.1",
): Promise<Listening> {
  const onRequest = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void answer(Buffer.concat(chunks));
    });

    async function answer(body: Buffer): Promise<void> {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const url = new URL(incoming.url ?? "/", "http://stub.invalid");
      const credential = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(headers["authorization"] ?? "")?.[1];
      const record: RecordedRequest = {
        host,
        method: incoming.method ?? "GET",
        path: url.pathname,
        query: url.search,
        headers,
        body: body.toString("utf8"),
        ...(credential === undefined ? {} : { token: { kind: tokenKind(world, credential), value: credential } }),
        status: 0,
      };
      received.push(record);
      let response: StubResponse;
      try {
        response = await handle({ host, method: record.method, url, headers, body });
      } catch (error) {
        response = { status: 500, headers: { "content-type": "text/plain" }, body: `GitHub stub failure: ${String(error)}` };
      }
      record.status = response.status;
      outgoing.writeHead(response.status, response.headers ?? {});
      outgoing.end(response.body);
    }
  };
  const server: Server = tls === undefined ? createHttpServer(onRequest) : createHttpsServer({ key: tls.key, cert: tls.cert }, onRequest);
  await new Promise<void>((resolve) => server.listen(0, listenHost, resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `${tls === undefined ? "http" : "https"}://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
