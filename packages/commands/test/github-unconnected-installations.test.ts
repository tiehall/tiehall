import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubInstallation } from "@tiehall/testing/github";
import { readInstallations, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// An installation nobody connected is only listed (tracker-mirrors: Admins
// connect GitHub installations with the confirmation step: "Tiehall SHALL use
// an installation that is not connected only to list it"). The App is public
// and installed on acme-labs, which no admin connected: the invite's lookup of
// a GitHub username and the check of a rotated private key, which each ask
// GitHub through an installation, do not go through it. With no connected
// installation to ask through, each is refused with 409, as with no
// installation at all, and no installation token is requested for acme-labs.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let labs: StubInstallation;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "kim-labs", "jo-contracts"]) stub.addUser({ login });
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin" } });
  stub.addOrg({ login: "acme-labs", members: { "kim-labs": "admin" } });
  harness = await startSignIn(install, stub);
  // The App is made public and someone installs it on acme-labs; no admin connects that installation.
  stub.updateApp(harness.app, { public: true });
  labs = await stub.install(harness.app, { account: "acme-labs" });
  await readInstallations({ database: install.db, app: (await harness.github.app())! });
  install.useGitHub(harness.github);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

function tokensRequestedFor(installation: StubInstallation, from: number): number {
  return stub.received.slice(from).filter(({ method, path }) => method === "POST" && path === `/app/installations/${installation.id}/access_tokens`).length;
}

async function problemOf(answer: Response): Promise<{ status: number; type: string }> {
  const { type } = (await answer.json()) as { type: string };
  return { status: answer.status, type };
}

describe("an installation that no admin connected", () => {
  it("is listed, and connected to nothing", async () => {
    expect((await install.owner.query("SELECT account_login FROM github_installations")).rows).toEqual([{ account_login: "acme-labs" }]);
    expect(Number((await install.owner.query("SELECT count(*) AS n FROM github_connected_installations")).rows[0].n)).toBe(0);
  });

  it("is not used to look an invite's username up: the invite gets 409, and no token is requested for it", async () => {
    const from = stub.received.length;
    const answer = await install.confirm(ada, "invites.create", { login: "jo-contracts" });
    expect(await problemOf(answer)).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
    expect(Number((await install.owner.query("SELECT count(*) AS n FROM invites")).rows[0].n)).toBe(0);
    expect(tokensRequestedFor(labs, from)).toBe(0);
  });

  it("is not used to check a rotated private key: the upload gets 409, the key in use stays, and no token is requested for it", async () => {
    const pem = stub.addPrivateKey(harness.app);
    const from = stub.received.length;
    const answer = await install.confirm(ada, "github.upload_private_key", {}, {}, { privateKey: pem });
    expect(await problemOf(answer)).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
    expect(tokensRequestedFor(labs, from)).toBe(0);
    expect((await install.owner.query("SELECT type FROM events WHERE type = 'github.private_key_uploaded'")).rows).toEqual([]);
  });
});
