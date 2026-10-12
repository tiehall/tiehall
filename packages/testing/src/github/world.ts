import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ParsedManifest, Permission } from "./manifest.ts";
import { ACCOUNT_PERMISSIONS, ORGANIZATION_PERMISSIONS } from "./manifest.ts";
import {
  DEFAULT_INSTALLATION_TOKEN_LENGTH,
  makeClientId,
  makeCode,
  makeInstallationToken,
  makeRefreshToken,
  makeSecret,
  makeUserToken,
} from "./tokens.ts";

// The state of the GitHub the stub plays: accounts, repositories, Apps,
// installations, the credentials GitHub issued, pull requests and issues. The
// HTTP side (server.ts) and the test helpers (index.ts) both change it through
// the methods here, so a change a test makes and one a client makes through
// the API are the same change.

export interface StubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: "public" | "private" | null;
}

export interface StubUser {
  readonly type: "User";
  readonly id: number;
  readonly nodeId: string;
  login: string;
  name: string | null;
  emails: StubEmail[];
  readonly createdAt: string;
}

export interface StubMembership {
  role: "admin" | "member";
  state: "active" | "pending";
  /** The member made the membership public, so GitHub shows it to anyone; private unless set. */
  public?: boolean;
}

/**
 * How the stub answers a requester that may not see an organization's
 * members: "forbidden", with 403, unless a test asks for "documented", GitHub's
 * own answers (a 302 to the public membership check, and the public members
 * only).
 */
export type MemberAnswers = "forbidden" | "documented";

export interface StubOrg {
  readonly type: "Organization";
  readonly id: number;
  readonly nodeId: string;
  login: string;
  name: string | null;
  /** By user id. */
  readonly members: Map<number, StubMembership>;
  /** GitHub serves every requester this organization's public members only, as it may once an owner removed the Members permission. */
  membersPublicOnly: boolean;
  readonly createdAt: string;
}

export type StubAccount = StubUser | StubOrg;

export interface StubRepo {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: StubAccount;
  name: string;
  private: boolean;
  readonly createdAt: string;
  /** The next number of an issue or a pull request: GitHub numbers both from one counter per repository. */
  nextNumber: number;
}

export interface StubApp {
  readonly id: number;
  readonly nodeId: string;
  slug: string;
  name: string;
  description: string;
  readonly owner: StubAccount;
  readonly clientId: string;
  /** The newest client secret; GitHub keeps older ones valid until they are deleted. */
  clientSecret: string;
  readonly clientSecrets: string[];
  /** The newest private key, as GitHub gives it: PKCS#1 PEM. */
  pem: string;
  readonly publicKeys: KeyObject[];
  permissions: Record<string, Permission>;
  events: string[];
  hook: { id: number; url: string; active: boolean } | null;
  /** The webhook secret, or null for an App without a webhook (spike 1.6). */
  webhookSecret: string | null;
  public: boolean;
  url: string;
  redirectUrl: string | null;
  callbackUrls: string[];
  setupUrl: string | null;
  readonly createdAt: string;
  updatedAt: string;
  /** The id of the App's bot user, which everything the App writes appears as. */
  readonly botId: number;
}

export interface StubInstallation {
  readonly id: number;
  readonly appId: number;
  readonly account: StubAccount;
  selection: "all" | "selected";
  readonly repositoryIds: Set<number>;
  suspendedAt: string | null;
  suspendedBy: StubUser | null;
  deleted: boolean;
  readonly createdAt: string;
  updatedAt: string;
  /**
   * The App's permissions this installation holds: no account permission, and organization ones only on an
   * organization. A test changes them as an owner does who declines or removes one.
   */
  permissions: Record<string, Permission>;
  readonly events: string[];
  /** The full names of the repositories it covers now. */
  repositoryNames(): string[];
}

export interface StubComment {
  readonly id: number;
  readonly nodeId: string;
  body: string;
  readonly author: Author;
  readonly createdAt: string;
  updatedAt: string;
}

/** Who wrote something: a user, or an App's bot. */
export type Author = { kind: "user"; user: StubUser } | { kind: "bot"; app: StubApp };

export interface StubIssue {
  readonly kind: "issue";
  readonly id: number;
  readonly nodeId: string;
  readonly repo: StubRepo;
  readonly number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "duplicate" | "reopened" | null;
  labels: string[];
  assigneeIds: number[];
  readonly author: Author;
  readonly comments: StubComment[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Who closed it last: a user, or an App's bot; null for an issue never closed. */
  closedBy: Author | null;
}

export interface StubPullRequest {
  readonly kind: "pull_request";
  readonly id: number;
  readonly nodeId: string;
  readonly repo: StubRepo;
  readonly number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  readonly author: StubUser;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface InstallationTokenGrant {
  readonly token: string;
  readonly installationId: number;
  expiresAt: number;
}

export interface UserTokenGrant {
  readonly token: string;
  readonly appId: number;
  readonly userId: number;
  expiresAt: number;
  revoked: boolean;
  /** For a refresh token, the access token issued with it, which refreshing ends. */
  paired: string | null;
}

export interface AuthorizationCode {
  readonly code: string;
  readonly appId: number;
  readonly userId: number;
  readonly redirectUri: string;
  readonly codeChallenge: string | null;
  expiresAt: number;
  used: boolean;
}

export interface ManifestCode {
  readonly code: string;
  readonly appId: number;
  expiresAt: number;
  used: boolean;
}

/** A manifest GitHub accepted and shows on its confirmation page, before the App exists. */
export interface PendingRegistration {
  readonly id: string;
  readonly manifest: ParsedManifest;
  readonly owner: StubAccount;
  readonly state: string | null;
}

/** GitHub's lifetimes (spikes 1.5 and 1.6, and GitHub's documentation). */
export const LIFETIMES = {
  installationTokenMs: 60 * 60 * 1000,
  userTokenSeconds: 28_800,
  refreshTokenSeconds: 15_897_600,
  authorizationCodeMs: 10 * 60 * 1000,
  manifestCodeMs: 60 * 60 * 1000,
} as const;

export class GitHubWorld {
  private readonly accounts = new Map<number, StubAccount>();
  readonly repos = new Map<number, StubRepo>();
  readonly apps = new Map<number, StubApp>();
  readonly installations = new Map<number, StubInstallation>();
  readonly installationTokens = new Map<string, InstallationTokenGrant>();
  readonly userTokens = new Map<string, UserTokenGrant>();
  readonly refreshTokens = new Map<string, UserTokenGrant>();
  readonly authorizationCodes = new Map<string, AuthorizationCode>();
  readonly manifestCodes = new Map<string, ManifestCode>();
  readonly pending = new Map<string, PendingRegistration>();
  /** The users who authorized each App, as "appId:userId". */
  readonly authorizations = new Set<string>();
  /** Issues and pull requests, by repository id and number. */
  readonly items = new Map<string, StubIssue | StubPullRequest>();
  /** The issues someone deleted, by repository id and number, which GitHub answers with 410. */
  readonly deletedIssues = new Set<string>();
  installationTokenLength = DEFAULT_INSTALLATION_TOKEN_LENGTH;
  memberAnswers: MemberAnswers = "forbidden";
  private clockOffset = 0;
  private nextId = 1_000;
  private nextNodeId = 1;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  now(): number {
    return this.clock() + this.clockOffset;
  }

  /** GitHub's timestamps: ISO 8601 to the second. */
  timestamp(at = this.now()): string {
    return new Date(Math.floor(at / 1000) * 1000).toISOString().replace(".000Z", "Z");
  }

  advanceClock(ms: number): void {
    this.clockOffset += ms;
  }

  id(): number {
    this.nextId += 1;
    return this.nextId;
  }

  nodeId(prefix: string): string {
    this.nextNodeId += 1;
    return `${prefix}_kgDO${String(this.nextNodeId).padStart(8, "0")}`;
  }

  // Accounts.

  addUser(input: { login: string; id?: number; name?: string | null; email?: string; emails?: StubEmail[] }): StubUser {
    this.assertLoginFree(input.login);
    const emails = input.emails ?? (input.email === undefined ? [] : [{ email: input.email, primary: true, verified: true, visibility: "private" as const }]);
    const user: StubUser = {
      type: "User",
      id: input.id ?? this.id(),
      nodeId: this.nodeId("U"),
      login: input.login,
      name: input.name ?? null,
      emails,
      createdAt: this.timestamp(),
    };
    this.addAccount(user);
    return user;
  }

  addOrg(input: { login: string; id?: number; name?: string | null }): StubOrg {
    this.assertLoginFree(input.login);
    const org: StubOrg = {
      type: "Organization",
      id: input.id ?? this.id(),
      nodeId: this.nodeId("O"),
      login: input.login,
      name: input.name ?? null,
      members: new Map(),
      membersPublicOnly: false,
      createdAt: this.timestamp(),
    };
    this.addAccount(org);
    return org;
  }

  private addAccount(account: StubAccount): void {
    if (this.accounts.has(account.id)) throw new Error(`the stub already has an account with id ${account.id}`);
    this.accounts.set(account.id, account);
  }

  private assertLoginFree(login: string): void {
    if (this.findAccount(login) !== undefined) throw new Error(`the stub already has an account named ${login}`);
  }

  findAccount(login: string): StubAccount | undefined {
    const wanted = login.toLowerCase();
    for (const account of this.accounts.values()) if (account.login.toLowerCase() === wanted) return account;
    return undefined;
  }

  accountById(id: number): StubAccount | undefined {
    return this.accounts.get(id);
  }

  account(login: string): StubAccount {
    const account = this.findAccount(login);
    if (account === undefined) throw new Error(`the stub has no account named ${login}`);
    return account;
  }

  user(login: string): StubUser {
    const account = this.account(login);
    if (account.type !== "User") throw new Error(`${login} is an organization, not a user`);
    return account;
  }

  org(login: string): StubOrg {
    const account = this.account(login);
    if (account.type !== "Organization") throw new Error(`${login} is a user, not an organization`);
    return account;
  }

  /** Whether a user administers an account: it is theirs, or they are an active admin of the organization. */
  administers(user: StubUser, account: StubAccount): boolean {
    if (account.type === "User") return account.id === user.id;
    const membership = account.members.get(user.id);
    return membership?.state === "active" && membership.role === "admin";
  }

  /** The organizations a user is an active member of. */
  orgsOf(user: StubUser): StubOrg[] {
    return [...this.accounts.values()].filter((account): account is StubOrg => account.type === "Organization" && this.isActiveMember(account, user));
  }

  isActiveMember(org: StubOrg, user: StubUser): boolean {
    return org.members.get(user.id)?.state === "active";
  }

  // Repositories.

  addRepo(fullName: string, options: { private?: boolean; id?: number } = {}): StubRepo {
    const [ownerLogin, name, ...rest] = fullName.split("/");
    if (ownerLogin === undefined || name === undefined || rest.length > 0) throw new Error(`not a repository name: ${fullName}`);
    const owner = this.account(ownerLogin);
    if (this.findRepo(fullName) !== undefined) throw new Error(`the stub already has ${fullName}`);
    const repo: StubRepo = {
      id: options.id ?? this.id(),
      nodeId: this.nodeId("R"),
      owner,
      name,
      private: options.private ?? true,
      createdAt: this.timestamp(),
      nextNumber: 1,
    };
    this.repos.set(repo.id, repo);
    return repo;
  }

  findRepo(fullName: string): StubRepo | undefined {
    const wanted = fullName.toLowerCase();
    for (const repo of this.repos.values()) if (fullNameOf(repo).toLowerCase() === wanted) return repo;
    return undefined;
  }

  repo(fullName: string): StubRepo {
    const repo = this.findRepo(fullName);
    if (repo === undefined) throw new Error(`the stub has no repository ${fullName}`);
    return repo;
  }

  reposOf(account: StubAccount): StubRepo[] {
    return [...this.repos.values()].filter((repo) => repo.owner.id === account.id).sort((a, b) => a.id - b.id);
  }

  // Apps.

  createApp(manifest: ParsedManifest, owner: StubAccount): StubApp {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const created = this.timestamp();
    const clientSecret = makeSecret();
    const app: StubApp = {
      id: this.id(),
      nodeId: this.nodeId("A"),
      slug: slugOf(manifest.name),
      name: manifest.name,
      description: manifest.description,
      owner,
      clientId: makeClientId(),
      clientSecret,
      clientSecrets: [clientSecret],
      pem,
      publicKeys: [publicKey],
      permissions: { ...manifest.permissions },
      events: [...manifest.events],
      hook: manifest.hook === null ? null : { id: this.id(), ...manifest.hook },
      webhookSecret: manifest.hook === null ? null : makeSecret(),
      public: manifest.public,
      url: manifest.url,
      redirectUrl: manifest.redirectUrl,
      callbackUrls: [...manifest.callbackUrls],
      setupUrl: manifest.setupUrl,
      createdAt: created,
      updatedAt: created,
      botId: this.id(),
    };
    this.apps.set(app.id, app);
    return app;
  }

  appByName(name: string): StubApp | undefined {
    const wanted = name.toLowerCase();
    for (const app of this.apps.values()) if (app.name.toLowerCase() === wanted || app.slug === slugOf(name)) return app;
    return undefined;
  }

  appBySlug(slug: string): StubApp | undefined {
    for (const app of this.apps.values()) if (app.slug === slug) return app;
    return undefined;
  }

  appByClientId(clientId: string): StubApp | undefined {
    for (const app of this.apps.values()) if (app.clientId === clientId) return app;
    return undefined;
  }

  /** The App an App JWT's issuer names: its client id or its id. */
  appByIssuer(issuer: string): StubApp | undefined {
    return this.appByClientId(issuer) ?? (/^\d+$/.test(issuer) ? this.apps.get(Number(issuer)) : undefined);
  }

  addClientSecret(app: StubApp): string {
    const secret = makeSecret();
    app.clientSecrets.push(secret);
    app.clientSecret = secret;
    return secret;
  }

  /** Generates a new private key for the App, as its settings page does; the old keys stay valid. */
  addPrivateKey(app: StubApp): string {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app.pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    app.publicKeys.push(createPublicKey(privateKey));
    return app.pem;
  }

  issueManifestCode(app: StubApp): ManifestCode {
    const code: ManifestCode = { code: makeCode(), appId: app.id, expiresAt: this.now() + LIFETIMES.manifestCodeMs, used: false };
    this.manifestCodes.set(code.code, code);
    return code;
  }

  // Installations.

  install(app: StubApp, account: StubAccount, repositories: "all" | StubRepo[]): StubInstallation {
    const existing = this.liveInstallation(app, account);
    if (existing !== undefined) {
      this.setSelection(existing, repositories);
      return existing;
    }
    const created = this.timestamp();
    const repositoryIds = new Set<number>();
    const installation: StubInstallation = {
      id: this.id(),
      appId: app.id,
      account,
      selection: "all",
      repositoryIds,
      suspendedAt: null,
      suspendedBy: null,
      deleted: false,
      createdAt: created,
      updatedAt: created,
      permissions: installationPermissions(app, account),
      events: [...app.events],
      repositoryNames: () => this.coveredRepos(installation).map(fullNameOf),
    };
    this.setSelection(installation, repositories);
    this.installations.set(installation.id, installation);
    return installation;
  }

  private setSelection(installation: StubInstallation, repositories: "all" | StubRepo[]): void {
    installation.repositoryIds.clear();
    if (repositories === "all") {
      installation.selection = "all";
    } else {
      installation.selection = "selected";
      for (const repo of repositories) {
        if (repo.owner.id !== installation.account.id) throw new Error(`${fullNameOf(repo)} does not belong to ${installation.account.login}`);
        installation.repositoryIds.add(repo.id);
      }
    }
    installation.updatedAt = this.timestamp();
  }

  liveInstallation(app: StubApp, account: StubAccount): StubInstallation | undefined {
    for (const installation of this.installations.values()) {
      if (installation.appId === app.id && installation.account.id === account.id && !installation.deleted) return installation;
    }
    return undefined;
  }

  installationsOf(app: StubApp): StubInstallation[] {
    return [...this.installations.values()].filter((installation) => installation.appId === app.id && !installation.deleted).sort((a, b) => a.id - b.id);
  }

  /** The repositories an installation covers now, whatever its state. */
  coveredRepos(installation: StubInstallation): StubRepo[] {
    if (installation.selection === "all") return this.reposOf(installation.account);
    return [...installation.repositoryIds].map((id) => this.repos.get(id)).filter((repo): repo is StubRepo => repo !== undefined).sort((a, b) => a.id - b.id);
  }

  /** Whether the installation reaches the repository: it is neither deleted nor suspended, and covers it. */
  reaches(installation: StubInstallation, repo: StubRepo): boolean {
    if (installation.deleted || installation.suspendedAt !== null) return false;
    if (repo.owner.id !== installation.account.id) return false;
    return installation.selection === "all" || installation.repositoryIds.has(repo.id);
  }

  /** The live, unsuspended installations whose App would hear about this repository. */
  installationsReaching(repo: StubRepo): StubInstallation[] {
    return [...this.installations.values()].filter((installation) => this.reaches(installation, repo));
  }

  issueInstallationToken(installation: StubInstallation): InstallationTokenGrant {
    const grant: InstallationTokenGrant = {
      token: makeInstallationToken(this.installationTokenLength),
      installationId: installation.id,
      expiresAt: Math.floor((this.now() + LIFETIMES.installationTokenMs) / 1000) * 1000,
    };
    this.installationTokens.set(grant.token, grant);
    return grant;
  }

  // User authorization.

  issueAuthorizationCode(app: StubApp, user: StubUser, redirectUri: string, codeChallenge: string | null): AuthorizationCode {
    const code: AuthorizationCode = {
      code: makeCode(),
      appId: app.id,
      userId: user.id,
      redirectUri,
      codeChallenge,
      expiresAt: this.now() + LIFETIMES.authorizationCodeMs,
      used: false,
    };
    this.authorizationCodes.set(code.code, code);
    this.authorizations.add(`${app.id}:${user.id}`);
    return code;
  }

  /** An expiring user token and its refresh token, as a GitHub App issues them by default (spike 1.5). */
  issueUserTokens(app: StubApp, userId: number): { access: UserTokenGrant; refresh: UserTokenGrant } {
    const now = this.now();
    const access: UserTokenGrant = {
      token: makeUserToken(),
      appId: app.id,
      userId,
      expiresAt: now + LIFETIMES.userTokenSeconds * 1000,
      revoked: false,
      paired: null,
    };
    const refresh: UserTokenGrant = {
      token: makeRefreshToken(),
      appId: app.id,
      userId,
      expiresAt: now + LIFETIMES.refreshTokenSeconds * 1000,
      revoked: false,
      paired: access.token,
    };
    this.userTokens.set(access.token, access);
    this.refreshTokens.set(refresh.token, refresh);
    return { access, refresh };
  }

  // Issues and pull requests.

  item(repo: StubRepo, number: number): StubIssue | StubPullRequest | undefined {
    return this.items.get(`${repo.id}#${number}`);
  }

  /** Deletes an issue, as an admin of its repository may: GitHub answers every later call about it with 410. */
  deleteIssue(issue: StubIssue): void {
    this.items.delete(`${issue.repo.id}#${issue.number}`);
    this.deletedIssues.add(`${issue.repo.id}#${issue.number}`);
  }

  /** Whether someone deleted the issue with this number in the repository. */
  wasDeleted(repo: StubRepo, number: number): boolean {
    return this.deletedIssues.has(`${repo.id}#${number}`);
  }

  itemsOf(repo: StubRepo): Array<StubIssue | StubPullRequest> {
    return [...this.items.values()].filter((item) => item.repo.id === repo.id);
  }

  addIssue(repo: StubRepo, input: { title: string; body?: string | null; labels?: string[]; author: Author }): StubIssue {
    const now = this.timestamp();
    const issue: StubIssue = {
      kind: "issue",
      id: this.id(),
      nodeId: this.nodeId("I"),
      repo,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? null,
      state: "open",
      stateReason: null,
      labels: [...new Set(input.labels ?? [])],
      assigneeIds: [],
      author: input.author,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closedBy: null,
    };
    this.items.set(`${repo.id}#${issue.number}`, issue);
    return issue;
  }

  addPullRequest(
    repo: StubRepo,
    input: { title: string; body?: string | null; head: string; base?: string; author: StubUser; draft?: boolean },
  ): StubPullRequest {
    const now = this.timestamp();
    const pr: StubPullRequest = {
      kind: "pull_request",
      id: this.id(),
      nodeId: this.nodeId("PR"),
      repo,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? null,
      state: "open",
      draft: input.draft ?? false,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: input.head, sha: sha() },
      base: { ref: input.base ?? "main", sha: sha() },
      author: input.author,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.items.set(`${repo.id}#${pr.number}`, pr);
    return pr;
  }

  addComment(issue: StubIssue | StubPullRequest, body: string, author: Author): StubComment {
    const now = this.timestamp();
    const comment: StubComment = { id: this.id(), nodeId: this.nodeId("IC"), body, author, createdAt: now, updatedAt: now };
    if (issue.kind === "issue") issue.comments.push(comment);
    issue.updatedAt = now;
    return comment;
  }

  /** A code of the manifest flow or the user authorization, for tests that need to expire one. */
  newCode(): string {
    return makeCode();
  }
}

/** The App's permissions an installation on this account holds. */
function installationPermissions(app: StubApp, account: StubAccount): Record<string, Permission> {
  const permissions: Record<string, Permission> = {};
  for (const [key, level] of Object.entries(app.permissions).sort(([a], [b]) => a.localeCompare(b))) {
    if (ACCOUNT_PERMISSIONS.has(key)) continue;
    if (ORGANIZATION_PERMISSIONS.has(key) && account.type !== "Organization") continue;
    permissions[key] = level;
  }
  return permissions;
}

export function fullNameOf(repo: StubRepo): string {
  return `${repo.owner.login}/${repo.name}`;
}

/** GitHub's slug of an App name: lower case, with runs of other characters as one hyphen. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sha(): string {
  return makeSecret();
}
