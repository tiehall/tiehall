import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubInstallation, type StubUser } from "@tiehall/testing/github";
import { createGitHubClient, userOfGitHubAccount, withOrg, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// One Tiehall user per GitHub account (sign-in: One Tiehall user per GitHub
// account; design.md, Technical decisions: T7; design.md, Self-hosting
// decisions: S5). Tiehall knows a person by their GitHub account's numeric id,
// never by the login or an email address: a renamed login signs in as the same
// user, with the same membership, role and teams, and Tiehall shows the new
// login; a new account that takes the old login, or a reused email address,
// reaches nobody else's user. No route links a second GitHub account or any
// other identity to a user, and the author of a pull request is mapped to a
// user by the account's id too.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ana: StubUser;
let anaUserId: string;
let installation: StubInstallation;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  stub.addOrg({ login: "acme", members: { "ana-k": "admin" } });
  stub.addRepo("acme/web");
  anaUserId = await addUser(install.owner, { login: "ana-k", role: "admin", githubAccountId: ana.id });
  await joinTeams(install.owner, anaUserId, await addTeam(install.owner, "FE"));
  harness = await startSignIn(install, stub);
  installation = await stub.install(harness.app, { account: "acme", repositories: ["acme/web"] });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

async function membersList(caller: WebSessionCaller) {
  const result = await install.web(caller).read<{ members: { id: string; login: string; role: string; teams: string[] }[] }>("members.list", {});
  if (!result.ok) throw new Error(JSON.stringify(result.problem));
  return result.output.members;
}

describe("a renamed GitHub login", () => {
  it("signs in as the same user, with the same membership, role and teams, and Tiehall shows the new login", async () => {
    stub.renameUser("ana-k", "ana-kaya");
    const { response, jar } = await harness.signIn("ana-kaya");
    expect(response.status).toBe(302);
    const session = await harness.sessionOf(jar);
    expect(session?.userId).toBe(anaUserId);
    expect(await membersList(session!)).toContainEqual({ id: anaUserId, login: "ana-kaya", kind: "human", bot: false, role: "admin", teams: ["FE"] });
    expect((await install.owner.query("SELECT github_login FROM users WHERE id = $1", [anaUserId])).rows).toEqual([{ github_login: "ana-kaya" }]);
  });

  it("taken by a new account is someone else, who reaches nothing of the old holder's", async () => {
    // Ana is ana-kaya now; another person creates an account with the old login ana-k.
    stub.addUser({ login: "ana-k", email: "someone@else.example" });
    const sessions = Number((await install.owner.query("SELECT count(*) FROM web_sessions WHERE user_id = $1", [anaUserId])).rows[0].count);
    const { response, jar } = await harness.signIn("ana-k");
    // They are admitted or refused as a new person; with no way in, refused.
    expect(response.status).toBe(403);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect(Number((await install.owner.query("SELECT count(*) FROM web_sessions WHERE user_id = $1", [anaUserId])).rows[0].count)).toBe(sessions);
    expect((await install.owner.query("SELECT github_login FROM users WHERE id = $1", [anaUserId])).rows).toEqual([{ github_login: "ana-kaya" }]);
    expect((await install.owner.query("SELECT count(*) FROM users WHERE github_login = 'ana-k'")).rows[0].count).toBe("0");
  });
});

describe("a reused work address", () => {
  it("does not hand over the user of the account that had it", async () => {
    const dana = stub.addUser({ login: "dana-old", email: "dana@acme.example" });
    const danaUserId = await addUser(install.owner, { login: "dana-old", role: null, githubAccountId: dana.id });
    await install.owner.query("UPDATE users SET email = 'dana@acme.example' WHERE id = $1", [danaUserId]);
    // A new hire's different account now has that primary verified address.
    stub.addUser({ login: "new-hire", email: "dana@acme.example" });
    const { response, jar } = await harness.signIn("new-hire");
    expect(response.status).toBe(403);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect((await install.owner.query("SELECT count(*) FROM web_sessions WHERE user_id = $1", [danaUserId])).rows[0].count).toBe("0");
    expect((await install.owner.query("SELECT github_login FROM users WHERE id = $1", [danaUserId])).rows).toEqual([{ github_login: "dana-old" }]);
  });
});

describe("a second identity", () => {
  it.each(["/api/auth/link-social", "/api/auth/unlink-account", "/api/auth/list-accounts"])("cannot be linked through %s, which answers 404", async (path) => {
    const { jar } = await harness.signIn("ana-kaya");
    const response = await harness.service.handler(
      new Request(`${URL_OF_INSTALL}${path}`, {
        method: path.endsWith("list-accounts") ? "GET" : "POST",
        headers: { cookie: jar.header(), origin: URL_OF_INSTALL, "content-type": "application/json" },
        ...(path.endsWith("list-accounts") ? {} : { body: JSON.stringify({ provider: "github", providerId: "github", callbackURL: "/" }) }),
      }),
    );
    expect(response.status).toBe(404);
    expect((await install.owner.query("SELECT count(*) FROM sign_in_accounts WHERE user_id = $1", [anaUserId])).rows[0].count).toBe("1");
  });

  it("cannot be stored beside the user's GitHub account", async () => {
    await expect(
      install.owner.query(
        "INSERT INTO sign_in_accounts (org_id, id, user_id, provider_id, account_id) SELECT id, $1, $2, 'github', '424242' FROM orgs",
        [randomUUID(), anaUserId],
      ),
    ).rejects.toThrow(/sign_in_accounts_user_id/);
    await expect(
      install.owner.query(
        "INSERT INTO sign_in_accounts (org_id, id, user_id, provider_id, account_id) SELECT id, $1, $2, 'google', '424242' FROM orgs",
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/sign_in_accounts_github_only|violates foreign key/);
  });
});

describe("the author of a pull request", () => {
  it("is mapped to the user of their GitHub account by its id, after a rename too, and a new holder of the old login to nobody", async () => {
    await stub.openPullRequest("acme/web", { title: "Dark mode toggle", head: "fe-142-dark-mode", author: "ana-kaya" });
    await stub.openPullRequest("acme/web", { title: "Something else", head: "something-else", author: "ana-k" });
    const client = createGitHubClient({ clientId: harness.app.clientId, privateKey: harness.app.pem }, { apiUrl: stub.apiUrl });
    const octokit = client.installation(installation.id);
    const authors = await Promise.all(
      [1, 2].map(async (number) => (await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: "acme", repo: "web", pull_number: number })).data.user),
    );
    const mapped = await withOrg(install.db, (context) => Promise.all(authors.map((author) => userOfGitHubAccount(context, author!))));
    expect(mapped).toEqual([anaUserId, undefined]);
  });
});
