import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  connectInstallations,
  coveredRepositories,
  createGitHubClient,
  knownInstallations,
  listAppInstallations,
  listInstallationRepositories,
  readInstallations,
  withOrg,
} from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";

// Finding the App's installations and the repositories they cover by listing
// them (github-app-reachability: design.md, Design rules: Finding
// installations, and Technical decisions: T5; tracker-mirrors: Admins connect
// GitHub installations with the confirmation step; tracker-mirrors: Covered
// repositories follow each connected installation). Tiehall lists the App's
// installations with an App token whose issuer is the App's client id, 100 at
// a time, following GitHub's Link header, and keeps them in the table of known
// installations; it reads the repositories of each connected installation that
// is neither suspended nor deleted with that installation's own token, and
// those count as covered. It needs no delivery for any of it, so an App
// without a webhook knows its installations too.

let install: TestInstall;
let stub: GitHubStub;
let app: StubApp;

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
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
  stub.addRepo("acme/tools");
  app = stub.createApp({ owner: "acme" });
});

afterEach(async () => {
  await stub.close();
  await install.owner.query("DELETE FROM github_covered_repositories; DELETE FROM github_connected_installations; DELETE FROM github_installations");
});

const client = () => createGitHubClient({ clientId: app.clientId, privateKey: app.pem }, { apiUrl: stub.apiUrl });

/** Lists the App's installations, records them, and reads the repositories of the connected ones, as every sync does. */
function sync() {
  return readInstallations({ database: install.db, app: { appId: app.id, client: client() } });
}

describe("listing the App's installations", () => {
  it("lists 101 installations 100 at a time, across two pages by the Link header, with the App's token", async () => {
    stub.updateApp(app, { public: true });
    for (let index = 0; index < 101; index++) {
      const login = `org-${String(index).padStart(3, "0")}`;
      stub.addOrg({ login, members: { omar: "admin" } });
      await stub.install(app, { account: login }, { delivery: "none" });
    }

    const listed = await listAppInstallations(client());

    expect(listed).toHaveLength(101);
    expect(new Set(listed.map(({ installationId }) => installationId)).size).toBe(101);
    const calls = stub.received.filter((call) => call.host === "api" && call.path === "/app/installations");
    expect(calls.map((call) => new URLSearchParams(call.query).get("page") ?? "1")).toEqual(["1", "2"]);
    for (const call of calls) {
      expect(new URLSearchParams(call.query).get("per_page")).toBe("100");
      expect(call.token?.kind).toBe("app-jwt");
    }
    expect(stub.deliveries(app)).toEqual([]);
  });

  it("gives each installation's account, repository selection and suspension", async () => {
    stub.addUser({ login: "lee" });
    stub.updateApp(app, { public: true });
    const acme = await stub.install(app, { account: "acme", repositories: ["acme/web"] }, { delivery: "none" });
    const lee = await stub.install(app, { account: "lee" }, { delivery: "none" });
    await stub.suspend(lee, { delivery: "none" });

    const listed = await listAppInstallations(client());

    expect(listed.map(({ suspendedAt, ...rest }) => ({ ...rest, suspended: suspendedAt !== null }))).toEqual([
      { installationId: acme.id, account: { id: acme.account.id, login: "acme", type: "Organization" }, repositorySelection: "selected", suspended: false },
      { installationId: lee.id, account: { id: lee.account.id, login: "lee", type: "User" }, repositorySelection: "all", suspended: true },
    ]);
  });

  it("reads an installation's repositories with that installation's token, 100 at a time", async () => {
    for (let index = 0; index < 102; index++) stub.addRepo(`acme/repo-${String(index).padStart(3, "0")}`);
    const acme = await stub.install(app, { account: "acme" }, { delivery: "none" });

    const repositories = await listInstallationRepositories(client(), acme.id);

    expect(repositories).toHaveLength(105);
    expect(repositories.map(({ fullName }) => fullName)).toContain("acme/web");
    const calls = stub.received.filter((call) => call.host === "api" && call.path === "/installation/repositories");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(new URLSearchParams(call.query).get("per_page")).toBe("100");
      expect(call.token?.kind).toBe("installation");
    }
  });
});

describe("the known installations and the covered repositories", () => {
  it("records every listed installation as not connected, and reads no repository of one that is not connected", async () => {
    const acme = await stub.install(app, { account: "acme", repositories: ["acme/web", "acme/api"] }, { delivery: "none" });

    await sync();

    const known = await withOrg(install.db, (context) => knownInstallations(context));
    expect(known).toEqual([
      expect.objectContaining({ installationId: acme.id, account: expect.objectContaining({ login: "acme" }), connected: false, suspended: false, deleted: false }),
    ]);
    expect(await withOrg(install.db, (context) => coveredRepositories(context))).toEqual([]);
    expect(stub.received.filter((call) => call.path === "/installation/repositories")).toEqual([]);
  });

  it("counts the repositories of a connected installation as covered, and follows its selection at the next sync", async () => {
    const acme = await stub.install(app, { account: "acme", repositories: ["acme/web", "acme/api"] }, { delivery: "none" });
    await sync();
    const [known] = await withOrg(install.db, (context) => knownInstallations(context));
    await withOrg(install.db, (context) => connectInstallations(context, [known!.id]));
    await sync();
    expect((await withOrg(install.db, (context) => coveredRepositories(context))).map(({ fullName }) => fullName).sort()).toEqual(["acme/api", "acme/web"]);

    await stub.removeRepositories(acme, ["acme/web"], { delivery: "none" });
    await stub.addRepositories(acme, ["acme/tools"], { delivery: "none" });
    await sync();

    expect((await withOrg(install.db, (context) => coveredRepositories(context))).map(({ fullName }) => fullName).sort()).toEqual(["acme/api", "acme/tools"]);
  });

  it("stops counting the repositories of a connected installation that the listing shows suspended or no longer holds", async () => {
    stub.addUser({ login: "lee" });
    stub.addRepo("lee/notes");
    stub.updateApp(app, { public: true });
    const acme = await stub.install(app, { account: "acme", repositories: ["acme/web"] }, { delivery: "none" });
    const lee = await stub.install(app, { account: "lee" }, { delivery: "none" });
    await sync();
    const known = await withOrg(install.db, (context) => knownInstallations(context));
    await withOrg(install.db, (context) => connectInstallations(context, known.map(({ id }) => id)));
    await sync();
    expect((await withOrg(install.db, (context) => coveredRepositories(context))).map(({ fullName }) => fullName).sort()).toEqual(["acme/web", "lee/notes"]);

    await stub.suspend(acme, { delivery: "none" });
    await stub.uninstall(lee, { delivery: "none" });
    await sync();

    expect(await withOrg(install.db, (context) => coveredRepositories(context))).toEqual([]);
    const after = await withOrg(install.db, (context) => knownInstallations(context));
    expect(after.map(({ account, suspended, deleted, connected }) => ({ login: account.login, suspended, deleted, connected }))).toEqual([
      { login: "acme", suspended: true, deleted: false, connected: true },
      { login: "lee", suspended: false, deleted: true, connected: true },
    ]);

    // Unsuspended, the installation covers its repositories again at the next sync.
    await stub.unsuspend(acme, { delivery: "none" });
    await sync();
    expect((await withOrg(install.db, (context) => coveredRepositories(context))).map(({ fullName }) => fullName)).toEqual(["acme/web"]);
  });
});
