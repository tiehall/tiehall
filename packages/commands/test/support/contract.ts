import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GitHubStub, StubApp } from "@tiehall/testing/github";
import { applyChangeSets, connectInstallations, knownInstallations, readInstallations, withOrg, type InstallGitHub } from "../../src/index.ts";
import { storeStubApp } from "./github-app.ts";
import type { TestInstall } from "./install.ts";

// The classified changes of the recorded oasdiff outputs (task 23.1) for the
// contract tests: the changelog the pinned oasdiff wrote for a fixture pair of
// actions/contract/test/fixtures/oasdiff, as a contract report and an attached
// diff carry it: each change's engine id, its level, and the operation it
// touches, or the section of the document for a change that touches none, as
// `tiehall contract report` and `tiehall contract diff` read the changelog.

/** The fixture pairs: ERR, WARN and INFO changes; WARN and INFO; INFO alone; none. */
export type OasdiffPair = "breaking" | "warning" | "informational" | "unchanged";

/** A change as reports and contract sections carry it. */
export interface ClassifiedChange {
  id: string;
  level: "ERR" | "WARN" | "INFO";
  operation: string;
}

const LEVELS: Readonly<Record<number, ClassifiedChange["level"]>> = { 3: "ERR", 2: "WARN", 1: "INFO" };

/** The recorded changelog of a fixture pair, as oasdiff wrote it. */
export function recordedChangelog(pair: OasdiffPair): string {
  return readFileSync(new URL(`../../../../actions/contract/test/fixtures/oasdiff/${pair}/changelog.json`, import.meta.url), "utf8");
}

/** The classified changes of a fixture pair's recorded changelog. */
export function changesOf(pair: OasdiffPair): ClassifiedChange[] {
  const changelog = JSON.parse(recordedChangelog(pair)) as { id: string; level: number; operation?: string; path?: string; section?: string }[];
  return changelog.map(({ id, level, operation, path, section }) => ({
    id,
    level: LEVELS[level] ?? "INFO",
    operation: operation !== undefined && path !== undefined ? `${operation} ${path}` : (path ?? (section !== undefined ? `the ${section} section` : "the document")),
  }));
}

/** The workflow the contract Action runs in, in the provider's repository. */
export const CONTRACT_WORKFLOW = "acme/payments/.github/workflows/contract.yml@refs/heads/main";

/** acme/payments, the provider's repository, by GitHub's id. */
export const PAYMENTS_REPOSITORY = { fullName: "acme/payments", id: 7001 } as const;

/** A report of a provider pull request in acme/payments for an API, with these changes, as the contract Action's CLI sends it. */
export function reportOf(api: string, changes: readonly ClassifiedChange[], options: { pullRequest?: number; head?: string } = {}): Record<string, unknown> {
  return {
    api,
    pullRequest: { number: options.pullRequest ?? 310 },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { ref: "new-payment-fields", sha: options.head ?? "b".repeat(40) },
    engine: { name: "oasdiff", version: "1.32.1" },
    changes,
  };
}

/**
 * Runs, as the worker does at this time, every sent job that applies a change
 * set's update and whose time has come, and the jobs those send whose time has
 * come too; the install's execute() must tell the same time.
 */
export async function runDueUpdates(install: Pick<TestInstall, "db" | "execute" | "sentJobs">, now: Date): Promise<void> {
  for (;;) {
    const due = install.sentJobs.filter(({ queue, startAfter }) => queue === applyChangeSets.type.queue && (startAfter === undefined || startAfter <= now));
    if (due.length === 0) return;
    for (const job of due) install.sentJobs.splice(install.sentJobs.indexOf(job), 1);
    for (const job of due) {
      await applyChangeSets.handle(
        { id: randomUUID(), queue: job.queue, data: job.data as { changeSetId: string }, signal: new AbortController().signal },
        { database: install.db, now: () => now, execute: install.execute },
      );
    }
  }
}

/** The provider's repository on the GitHub stub, as the install's App sees it. */
export interface StubProvider {
  app: StubApp;
  /** The install's App, as the worker reaches it, calling the stub. */
  github: InstallGitHub;
  /** acme/payments, by GitHub's id. */
  repositoryId: number;
  /** acme, by GitHub's id: the repository's owner. */
  ownerId: number;
  /** The GitHub account's id of one of these people of acme, by login. */
  account(login: string): number;
}

/**
 * acme/payments on the GitHub stub, with these people in the acme
 * organization, covered by a connected installation of an App the stub made,
 * which the install stores and calls GitHub as, as the setup screen and the
 * admin's connection leave it. With a hook, the App has a webhook at the
 * install, which GitHub cannot reach here: the stub logs each delivery, with
 * what GitHub sent, for the test to store; without one, it sends none. The
 * installation covers the other repositories given too.
 */
export async function providerOnStub(
  install: TestInstall,
  stub: GitHubStub,
  logins: readonly string[],
  options: { hook?: boolean; repositories?: readonly string[]; publicRepositories?: readonly string[] } = {},
): Promise<StubProvider> {
  const accounts: Record<string, number> = {};
  for (const login of logins) accounts[login] = stub.addUser({ login }).id;
  // The organization's owner, who installs the App.
  stub.addUser({ login: "acme-owner" });
  const org = stub.addOrg({ login: "acme", members: { "acme-owner": "admin", ...Object.fromEntries(logins.map((login) => [login, "member" as const])) } });
  const repository = stub.addRepo("acme/payments");
  // Other repositories of acme the installation covers, such as a consumer's: private, unless the test makes them public.
  for (const fullName of options.repositories ?? []) stub.addRepo(fullName, { private: !(options.publicRepositories ?? []).includes(fullName) });
  const app = stub.createApp({ owner: "acme", ...(options.hook === true ? { hook: { url: "https://tiehall.example.com/webhooks/github" } } : {}) });
  const { github } = await storeStubApp(install, stub, app);
  install.useGitHub(github);
  await stub.install(app, { account: "acme", repositories: ["acme/payments", ...(options.repositories ?? [])] });
  const access = await github.app();
  if (access === undefined) throw new Error("The install stored no App.");
  await readInstallations({ database: install.db, app: access });
  await withOrg(install.db, async (context) => {
    const known = await knownInstallations(context);
    await connectInstallations(
      context,
      known.filter(({ account: { login } }) => login === "acme").map(({ id }) => id),
    );
  });
  // The connected installation's repositories, read as a sync does once it is connected.
  await readInstallations({ database: install.db, app: access });
  const account = (login: string) => {
    const id = accounts[login];
    if (id === undefined) throw new Error(`The stub has no account ${login} of acme.`);
    return id;
  };
  return { app, github, repositoryId: repository.id, ownerId: org.id, account };
}
