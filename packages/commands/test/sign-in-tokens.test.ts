import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubInstallation } from "@tiehall/testing/github";
import { dumpDatabase } from "@tiehall/testing/postgres";
import { createGitHubClient } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Tiehall keeps no GitHub user token (sign-in: Tiehall keeps no GitHub user
// token; design.md, Technical decisions: T7). The GitHub App issues expiring
// user tokens, an access token and a refresh token, each with an expiry, and
// the sign-in service would keep them with the account it links. It uses the
// access token only to learn who signed in and their primary verified email
// address; a hook before each write of the linked account, on the first
// sign-in and on every later one, sets every token field and both expiries to
// null, and the database refuses a stored token besides. Every call Tiehall
// makes to GitHub after that goes through the GitHub client, which calls as
// the App or as one of its installations, and takes no other credential.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let installation: StubInstallation;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  const ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  stub.addOrg({ login: "acme", members: { "ana-k": "admin" } });
  stub.addRepo("acme/web");
  await addUser(install.owner, { login: "ana-k", githubAccountId: ana.id });
  harness = await startSignIn(install, stub);
  installation = await stub.install(harness.app, { account: "acme", repositories: ["acme/web"] });
  await stub.openPullRequest("acme/web", { title: "Dark mode toggle", head: "fe-142-dark-mode", author: "ana-k" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

/** The user tokens the stub saw on calls: the access tokens of each sign-in. */
function userTokensSeen(): string[] {
  return [...new Set(stub.received.filter(({ token }) => token?.kind === "user").map(({ token }) => token!.value))];
}

describe("after a sign-in, and after a repeat sign-in", () => {
  it("no GitHub user token, refresh token or expiry is stored anywhere in the database", async () => {
    const first = await harness.signIn("ana-k");
    expect(first.response.status).toBe(302);
    const again = await harness.signIn("ana-k");
    expect(again.response.status).toBe(302);
    expect(await harness.sessionOf(again.jar)).toMatchObject({ kind: "web_session" });

    const { rows } = await install.owner.query(
      "SELECT access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at FROM sign_in_accounts",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toEqual({ access_token: null, refresh_token: null, id_token: null, access_token_expires_at: null, refresh_token_expires_at: null });
    }
    const seen = userTokensSeen();
    expect(seen).toHaveLength(2);
    const dump = dumpDatabase(install.databaseUrl, "plain").toString("utf8");
    for (const token of seen) expect(dump).not.toContain(token);
    // Nor any other token of the forms GitHub issues to users: `ghu_` for access and `ghr_` for refresh.
    expect(dump).not.toMatch(/gh[ur]_[A-Za-z0-9]{20,}/);
  });

  it("the database refuses to store one, whoever writes it", async () => {
    await expect(install.owner.query("UPDATE sign_in_accounts SET access_token = 'ghu_0123456789abcdefghijklmnopqrstuvwxyz'")).rejects.toThrow(
      /sign_in_accounts_no_user_token/,
    );
    await expect(install.owner.query("UPDATE sign_in_accounts SET refresh_token_expires_at = now()")).rejects.toThrow(/sign_in_accounts_no_user_token/);
  });
});

describe("the calls Tiehall makes to GitHub after a sign-in", () => {
  it("carry an installation token of the install's App, never a user's token", async () => {
    await harness.signIn("ana-k");
    const from = stub.received.length;
    // A pull request in a covered repository, read as a later task links one: through the GitHub client.
    const client = createGitHubClient({ clientId: harness.app.clientId, privateKey: harness.app.pem }, { apiUrl: stub.apiUrl });
    const pull = await client.installation(installation.id).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: "acme", repo: "web", pull_number: 1 });
    expect(pull.data.user?.login).toBe("ana-k");

    const after = stub.received.slice(from);
    expect(after.map(({ method, path, token }) => `${method} ${path} ${token?.kind}`)).toEqual([
      // The installation token is requested as the App, with its JSON web token.
      `POST /app/installations/${installation.id}/access_tokens app-jwt`,
      "GET /repos/acme/web/pulls/1 installation",
    ]);
    expect(after.some(({ token }) => token?.kind === "user")).toBe(false);
  });

  it("go through a client that takes the App's credentials and an installation, and no other credential", () => {
    const client = createGitHubClient({ clientId: harness.app.clientId, privateKey: harness.app.pem }, { apiUrl: stub.apiUrl });
    expect(Object.keys(client).sort()).toEqual(["app", "installation"]);
  });
});
