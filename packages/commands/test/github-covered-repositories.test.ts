import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubInstallation } from "@tiehall/testing/github";
import {
  connectInstallations,
  coveringInstallation,
  processGitHubDelivery,
  readInstallations,
  withOrg,
  type InstallGitHub,
} from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { storeDelivery, storeStubApp } from "./support/github-app.ts";

// Covered repositories follow each connected installation (tracker-mirrors:
// Covered repositories follow each connected installation; github-app-
// reachability: design.md, Design rules: Finding installations). In webhook
// mode, an `installation_repositories` delivery makes Tiehall read the
// repositories of that installation again at once, with its own token, so a
// repository removed from it stops counting as covered and one added starts
// counting; an `installation` delivery that reports a suspension or a
// deletion makes it list the App's installations again, and a suspended or
// deleted installation covers nothing. Later tasks ask which installation, if
// any, covers a repository, such as close on merge for a merged pull request.

let install: TestInstall;
let stub: GitHubStub;
let app: StubApp;
let github: InstallGitHub;
let acme: StubInstallation;
/** GitHub's ids of the stub's repositories, by full name. */
let repositories: Map<string, number>;

beforeAll(async () => {
  install = await startTestInstall();
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addOrg({ login: "acme-labs", members: { omar: "admin" } });
  repositories = new Map(["acme/web", "acme/api", "acme/tools", "acme-labs/docs", "acme-labs/site"].map((name) => [name, stub.addRepo(name).id]));
  // GitHub cannot reach the install here: each delivery is logged, with what GitHub sent, and stored by the test.
  app = stub.createApp({ owner: "acme", public: true, hook: { url: "https://tiehall.example.com/webhooks/github" } });
  ({ github } = await storeStubApp(install, stub, app));
  acme = await stub.install(app, { account: "acme", repositories: ["acme/web", "acme/api"] }, { delivery: "none" });
  await stub.install(app, { account: "acme-labs", repositories: ["acme-labs/docs"] }, { delivery: "none" });
  // acme is connected, and its repositories were read; acme-labs is not connected.
  await readInstallations({ database: install.db, app: (await github.app())! });
  await withOrg(install.db, async (context) => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = 'acme'");
    await connectInstallations(context, rows.map(({ id }) => id));
  });
  await readInstallations({ database: install.db, app: (await github.app())! });
});

afterEach(async () => {
  await stub.close();
  await install.owner.query(
    `DELETE FROM github_deliveries; DELETE FROM github_covered_repositories; DELETE FROM github_connected_installations;
     DELETE FROM github_installations; DELETE FROM integration_secrets; DELETE FROM github_app`,
  );
});

/** Processes the latest delivery of this event the stub logged, as the worker does once the route stored it. */
async function processLatest(event: string): Promise<void> {
  const delivery = stub.deliveries(app).filter((logged) => logged.event === event).at(-1);
  const deliveryId = await storeDelivery(install, delivery!);
  await processGitHubDelivery.handle(
    { id: randomUUID(), queue: processGitHubDelivery.type.queue, data: { deliveryId }, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github, execute: install.execute },
  );
}

/** Whether a repository counts as covered: whether a connected installation covers it, by its GitHub id. */
async function isCovered(fullName: string): Promise<boolean> {
  return (await withOrg(install.db, (context) => coveringInstallation(context, repositories.get(fullName)!))) !== undefined;
}

describe("an installation_repositories delivery", () => {
  it("stops counting a repository removed from a connected installation as covered", async () => {
    expect(await isCovered("acme/web")).toBe(true);

    await stub.removeRepositories(acme, ["acme/web"]);
    await processLatest("installation_repositories");

    expect(await isCovered("acme/web")).toBe(false);
    expect(await isCovered("acme/api")).toBe(true);
  });

  it("starts counting a repository added to a connected installation", async () => {
    expect(await isCovered("acme/tools")).toBe(false);

    await stub.addRepositories(acme, ["acme/tools"]);
    await processLatest("installation_repositories");

    expect(await isCovered("acme/tools")).toBe(true);
    expect(await isCovered("acme/web")).toBe(true);
  });

  it("covers nothing for an installation that is not connected", async () => {
    const labs = stub.installations(app).find(({ account }) => account.login === "acme-labs")!;
    await stub.addRepositories(labs, ["acme-labs/site"]);
    await processLatest("installation_repositories");

    expect(await isCovered("acme-labs/site")).toBe(false);
    expect(await isCovered("acme-labs/docs")).toBe(false);
    const { rows } = await install.owner.query<{ full_name: string }>("SELECT full_name FROM github_covered_repositories ORDER BY 1");
    expect(rows.map(({ full_name }) => full_name)).toEqual(["acme/api", "acme/web"]);
  });
});

describe("an installation delivery", () => {
  it("stops covering the repositories of a connected installation that is suspended, and covers them again once it is unsuspended", async () => {
    await stub.suspend(acme);
    await processLatest("installation");
    expect(await isCovered("acme/web")).toBe(false);

    await stub.unsuspend(acme);
    await processLatest("installation");
    expect(await isCovered("acme/web")).toBe(true);
  });

  it("stops covering the repositories of a connected installation that is deleted", async () => {
    await stub.uninstall(acme);
    await processLatest("installation");
    expect(await isCovered("acme/web")).toBe(false);
    expect(await isCovered("acme/api")).toBe(false);
  });
});

describe("the installation that covers a repository", () => {
  it("is the connected installation that holds it, by the repository's GitHub id, and none for any other repository", async () => {
    const covering = await withOrg(install.db, (context) => coveringInstallation(context, repositories.get("acme/web")!));
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = 'acme'");
    expect(covering).toEqual({ installation: rows[0]?.id, installationId: acme.id });
    expect(await withOrg(install.db, (context) => coveringInstallation(context, 987_654_321))).toBeUndefined();
  });
});
