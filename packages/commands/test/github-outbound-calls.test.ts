import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import {
  createInstallGitHub,
  processDelivery,
  readInstallations,
  syncGitHubInstallations,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Every outbound GitHub call uses Tiehall's own credentials (agent-access:
// Outbound calls use Tiehall's own credentials; tracker-mirrors: GitHub writes
// appear as the App's bot; design.md, Technical decisions: T16). Tiehall calls
// GitHub's API through Octokit, in the GitHub client module alone, as the
// install's App: on the App's own endpoints, such as listing its installations
// and requesting an installation token, with the App's JSON web token, and on
// every other endpoint with an installation token. The one call made with a
// user's token is the sign-in's own, which reads who signed in with the token
// of that sign-in and nothing else (sign-in: Tiehall keeps no GitHub user
// token). A token a client presented to Tiehall never reaches GitHub, nor does
// a web session's cookie.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let github: InstallGitHub;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  const ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  stub.addOrg({ login: "acme", members: { "ana-k": "admin" } });
  stub.addOrg({ login: "acme-labs", members: { "ana-k": "admin" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme-labs/tools");
  await addUser(install.owner, { login: "ana-k", githubAccountId: ana.id, role: "admin" });
  harness = await startSignIn(install, stub);
  github = createInstallGitHub({ database: install.db, secrets: () => harness.box, apiUrl: stub.apiUrl, fetch, logger: install.logger });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

describe("the calls Tiehall makes to GitHub's API", () => {
  it("carry the App's token on the App's own endpoints and an installation token on every other, never a user's token or one presented to Tiehall", async () => {
    // The sign-in reads who signed in with its own user token; everything after it is the App's.
    const signedIn = await harness.signIn("ana-k");
    expect(signedIn.response.status).toBe(302);
    const signInCalls = stub.received.filter(({ host }) => host === "api");
    expect(signInCalls.map(({ method, path, token }) => `${method} ${path} ${token?.kind}`)).toEqual(["GET /user user", "GET /user/emails user"]);
    const session = (await harness.sessionOf(signedIn.jar))!;
    const from = stub.received.length;

    stub.updateApp(harness.app, { public: true });
    const acme = await stub.install(harness.app, { account: "acme" }, { delivery: "none" });
    await stub.install(harness.app, { account: "acme-labs" }, { delivery: "none" });

    // Listing the installations, an admin's connection and the job that reads its repositories.
    await readInstallations({ database: install.db, app: (await github.app())! });
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = 'acme'");
    const cookie = signedIn.jar.header();
    const connected = await install.confirm(session as WebSessionCaller, "github.connect_installation", { installation: rows[0]!.id }, { cookie });
    expect(connected.status).toBe(200);
    for (const { queue, data } of install.sentJobs.splice(0)) {
      await syncGitHubInstallations.handle(
        { id: randomUUID(), queue, data: data as { repositoriesOf?: number[] }, signal: new AbortController().signal },
        { database: install.db, now: () => new Date(), github, execute: install.execute },
      );
    }

    // Deliveries, as the worker processes them: about an installation's repositories, and a pull request.
    for (const [event, payload] of [
      ["installation_repositories", { action: "added", installation: { id: acme.id }, sender: { id: acme.account.id } }],
      ["pull_request", { action: "opened", number: 1, installation: { id: acme.id }, sender: { id: acme.account.id } }],
    ] as const) {
      const deliveryId = randomUUID();
      await install.owner.query("INSERT INTO github_deliveries (org_id, delivery_id, event, payload, enqueued_at) SELECT id, $1, $2, $3, now() FROM orgs", [
        deliveryId,
        event,
        JSON.stringify(payload),
      ]);
      await processDelivery({ database: install.db, github, execute: install.execute }, deliveryId);
    }

    // An agent presents its token to Tiehall.
    const presented = `th_pat_${randomUUID().replaceAll("-", "")}`;
    const api = install.api({ kind: "personal_access_token", userId: session.userId, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" });
    await api(new Request(`${URL_OF_INSTALL}/api/v1/requests`, { headers: { authorization: `Bearer ${presented}` } }));

    const after = stub.received.slice(from).filter(({ host }) => host === "api");
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) {
      expect({ path: call.path, kind: call.token?.kind }).toEqual({ path: call.path, kind: call.path.startsWith("/app/") || call.path === "/app" ? "app-jwt" : "installation" });
    }
    for (const call of stub.received.slice(from)) {
      const headers = JSON.stringify(call.headers);
      expect(headers).not.toContain(presented);
      for (const value of cookie.split("; ").map((pair) => pair.split("=").slice(1).join("="))) expect(headers).not.toContain(value);
    }
    expect(stub.received.slice(from).some(({ token }) => token?.kind === "user")).toBe(false);
  });
});

describe("the modules that call GitHub", () => {
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(source).filter((name) => name.endsWith(".ts"));
  const text = (name: string) => readFileSync(join(source, name), "utf8");

  it("build Octokit in the GitHub client module alone", () => {
    expect(files.filter((name) => /from "@octokit\//.test(text(name)))).toEqual(["github-client.ts"]);
  });

  it("call GitHub's API nowhere but in the GitHub client module", () => {
    // A URL on GitHub's API built anywhere else would be a call past Octokit and the App's credentials.
    const apiUrls = /\$\{\s*(?:apiUrl|GITHUB_API_URL|options\.apiUrl)[^}]*\}\s*\//;
    expect(files.filter((name) => apiUrls.test(text(name)))).toEqual([]);
  });
});
