import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubInstallation } from "@tiehall/testing/github";
import { connectInstallations, reconcileGitHub, WORKER_JOBS, withOrg, type InstallGitHub, type WebSessionCaller } from "../src/index.ts";
import { storeStubApp } from "./support/github-app.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// The 15-minute GitHub reconciliation finds what a lost delivery would have
// said (tracker-mirrors: Admins connect GitHub installations with the
// confirmation step; tracker-mirrors: Covered repositories follow each
// connected installation; github-app-reachability: design.md, Design rules:
// Finding installations). It runs in either GitHub mode: each run lists the
// App's installations with the App's own token and reads the repositories of
// each connected one, so in webhook mode an installation, or a change of its
// repositories, whose delivery GitHub dropped counts within 15 minutes; and a
// connected installation GitHub suspended or deleted with no delivery stops
// covering its repositories. Polling mode's 60-second poll does the same
// within 2 minutes (github-polling.test.ts).

let install: TestInstall;
let stub: GitHubStub;
let app: StubApp;
let github: InstallGitHub;
let acme: StubInstallation;
let pia: WebSessionCaller;

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addOrg({ login: "acme-labs", members: { omar: "admin" } });
  for (const name of ["acme/web", "acme/api", "acme/tools", "acme-labs/docs"]) stub.addRepo(name);
  // An App with a webhook, in webhook mode, whose deliveries GitHub drops in these tests.
  app = stub.createApp({ owner: "acme", public: true, hook: { url: "https://tiehall.example.com/webhooks/github" } });
  ({ github } = await storeStubApp(install, stub, app));
  acme = await stub.install(app, { account: "acme", repositories: ["acme/web", "acme/api"] }, { delivery: "drop" });
  await reconcile();
  await withOrg(install.db, async (context) => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = 'acme'");
    await connectInstallations(context, rows.map(({ id }) => id));
  });
  await reconcile();
  pia = sessionOf(await addUser(install.owner, { login: "pia", role: "admin" }));
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await install?.close();
});

/** One run of the reconciliation, as the worker runs it every 15 minutes. */
async function reconcile(): Promise<void> {
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github, execute: install.execute, jobs: { send: async () => undefined } },
  );
}

/** The installations the admin page lists, as an admin reads them. */
async function listed(): Promise<{ account: string; connected: boolean; suspended: boolean; deleted: boolean; repositories: string[] }[]> {
  const result = await install.web(pia).read<{ installations: { account: string; connected: boolean; suspended: boolean; deleted: boolean; repositories: string[] }[] }>(
    "github.list_installations",
    {},
  );
  if (!result.ok) throw new Error(`github.list_installations answered ${result.problem.status}`);
  return result.output.installations.map(({ account, connected, suspended, deleted, repositories }) => ({ account, connected, suspended, deleted, repositories }));
}

describe("the GitHub reconciliation", () => {
  it("runs every 15 minutes, as one of the worker's jobs", () => {
    expect(reconcileGitHub.schedule).toBe("*/15 * * * *");
    expect(WORKER_JOBS).toContain(reconcileGitHub);
  });

  it("lists an installation whose delivery GitHub dropped, as not connected, on its next run", async () => {
    await stub.install(app, { account: "acme-labs", repositories: ["acme-labs/docs"] }, { delivery: "drop" });
    expect((await listed()).map(({ account }) => account)).toEqual(["acme"]);
    await reconcile();
    expect(await listed()).toEqual([
      { account: "acme", connected: true, suspended: false, deleted: false, repositories: ["acme/api", "acme/web"] },
      { account: "acme-labs", connected: false, suspended: false, deleted: false, repositories: [] },
    ]);
  });

  it("counts a repository added to or removed from a connected installation, whose delivery GitHub dropped, on its next run", async () => {
    await stub.addRepositories(acme, ["acme/tools"], { delivery: "drop" });
    await stub.removeRepositories(acme, ["acme/web"], { delivery: "drop" });
    expect((await listed())[0]?.repositories).toEqual(["acme/api", "acme/web"]);
    await reconcile();
    expect((await listed())[0]?.repositories).toEqual(["acme/api", "acme/tools"]);
  });

  it("stops counting the repositories of a connected installation GitHub suspended or deleted with no delivery", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await reconcile();
    expect((await listed())[0]).toMatchObject({ connected: true, suspended: true, repositories: [] });
    await stub.unsuspend(acme, { delivery: "none" });
    await reconcile();
    expect((await listed())[0]).toMatchObject({ suspended: false, repositories: ["acme/api", "acme/web"] });
    await stub.uninstall(acme, { delivery: "none" });
    await reconcile();
    expect((await listed())[0]).toMatchObject({ account: "acme", deleted: true, repositories: [] });
  });
});
