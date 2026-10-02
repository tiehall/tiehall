import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type RecordedRequest } from "@tiehall/testing/github";
import {
  createGitHubIssues,
  createInstallGitHub,
  processDelivery,
  readInstallations,
  syncGitHubInstallations,
  syncMirror,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi } from "./support/requests.ts";
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
// token). The App's client secret goes only into the sign-in's exchange of its
// code for that token, on GitHub's web host (github-layer-hardening: D50 (1)).
// A token a client presented to Tiehall never reaches GitHub, nor does a web
// session's cookie. The writes of the GitHub Issues mirror carry an
// installation token too, as the App's bot (tracker-mirrors: GitHub writes
// appear as the App's bot).

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

    // The GitHub Issues mirror: FE's intake repository is acme/web, where its request's mirror issue is made and updated.
    const fe = await addTeam(install.owner, "FE");
    await joinTeams(install.owner, session.userId, fe);
    await install.execute("mirrors.map_repository", session as WebSessionCaller, { teamId: fe, repository: "acme/web" });
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, session.userId, { targetTeam: "FE" });
    await install.execute("requests.claim", session as WebSessionCaller, { key: request.key });
    const access = (await github.app())!;
    const mirror = () =>
      syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app: access, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, request.id);
    await mirror();
    await install.execute("requests.set_status", session as WebSessionCaller, { key: request.key, state: "in_progress" });
    await mirror();
    const mirrorWrites = stub.received.slice(from).filter(({ path }) => path.startsWith("/repos/acme/web/issues"));
    expect(mirrorWrites.map(({ method }) => method)).toEqual(["POST", "POST", "POST", "DELETE"]);

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

  // The App's client id and client secret serve one call only: the exchange of a sign-in's code for that sign-in's
  // user token, on GitHub's web host. Every other call carries the App's JWT, an installation token or the
  // sign-in's own user token, and never the secret.
  it("carry the App's client secret only in the sign-in's exchange of its code for its user token", async () => {
    const from = stub.received.length;
    const signedIn = await harness.signIn("ana-k");
    expect(signedIn.response.status).toBe(302);

    // Then Tiehall lists the App's installations and reads a pull request through one of them.
    const acme = await stub.install(harness.app, { account: "acme" }, { delivery: "none" });
    const pull = await stub.openPullRequest("acme/web", { title: "Dark mode toggle", head: "fe-142-dark-mode", author: "ana-k" }, { delivery: "none" });
    const access = (await github.app())!;
    await readInstallations({ database: install.db, app: access });
    const read = await access.client.installation(acme.id).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: "acme", repo: "web", pull_number: pull.number });
    expect(read.status).toBe(200);

    const calls = stub.received.slice(from);
    expect(calls.map(({ host, method, path }) => `${host} ${method} ${path}`)).toEqual(
      expect.arrayContaining(["api GET /app/installations", `api GET /repos/acme/web/pulls/${pull.number}`]),
    );
    const secret = harness.app.clientSecret;
    expect(calls.filter((call) => carries(call, secret)).map(({ host, method, path, status }) => `${host} ${method} ${path} ${status}`)).toEqual([
      "web POST /login/oauth/access_token 200",
    ]);
  });
});

/**
 * Whether a request the stub recorded carries this value anywhere: in its path, query, headers or body, as sent
 * or URL-decoded, or inside the Basic credentials of a header.
 */
function carries(call: RecordedRequest, value: string): boolean {
  const decoded = (text: string): string => {
    try {
      return decodeURIComponent(text.replaceAll("+", " "));
    } catch {
      return text;
    }
  };
  const basic = Object.values(call.headers).flatMap((header) => {
    const credentials = /^basic\s+(\S+)$/i.exec(header)?.[1];
    return credentials === undefined ? [] : [Buffer.from(credentials, "base64").toString("utf8")];
  });
  return [call.path, call.query, call.body, JSON.stringify(call.headers), ...basic].some((text) => text.includes(value) || decoded(text).includes(value));
}

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
