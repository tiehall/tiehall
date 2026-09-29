import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The email address comes from GitHub (sign-in: The email address comes from
// GitHub; design.md, Self-hosting decisions: S5 and S10). The address Tiehall
// keeps for a user is the primary verified email of their GitHub account,
// read each time the person signs in; not the address the profile shows in
// public, and not an address GitHub has not verified. It serves only to send
// email when SMTP is set up; it decides nothing about who may sign in, whom an
// invite is for, or which user a person is.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let anaUserId: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  anaUserId = await addUser(install.owner, { login: "ana-k", githubAccountId: ana.id });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

async function emailOf(userId: string): Promise<string | null> {
  return (await install.owner.query<{ email: string | null }>("SELECT email FROM users WHERE id = $1", [userId])).rows[0]?.email ?? null;
}

describe("the email address Tiehall keeps", () => {
  it("is the GitHub account's primary verified email, read at sign-in", async () => {
    expect(await emailOf(anaUserId)).toBeNull();
    expect((await harness.signIn("ana-k")).response.status).toBe(302);
    expect(await emailOf(anaUserId)).toBe("ana@acme.example");
  });

  it("follows a changed primary email at the next sign-in", async () => {
    stub.setEmails("ana-k", [
      { email: "ana@acme.example", primary: false, verified: true, visibility: "private" },
      { email: "ana@new.example", primary: true, verified: true, visibility: "private" },
    ]);
    expect((await harness.signIn("ana-k")).response.status).toBe(302);
    expect(await emailOf(anaUserId)).toBe("ana@new.example");
  });

  it("is not the address the profile shows in public, when that is not the primary one", async () => {
    stub.setEmails("ana-k", [
      { email: "ana.talks@example.org", primary: false, verified: true, visibility: "public" },
      { email: "ana@acme.example", primary: true, verified: true, visibility: "private" },
    ]);
    expect((await harness.signIn("ana-k")).response.status).toBe(302);
    expect(await emailOf(anaUserId)).toBe("ana@acme.example");
  });

  it("is none when GitHub has not verified the primary email, and the sign-in still succeeds", async () => {
    stub.setEmails("ana-k", [
      { email: "ana@unverified.example", primary: true, verified: false, visibility: "private" },
      { email: "ana@acme.example", primary: false, verified: true, visibility: "private" },
    ]);
    const { response, jar } = await harness.signIn("ana-k");
    expect(response.status).toBe(302);
    expect(await harness.sessionOf(jar)).toMatchObject({ userId: anaUserId });
    expect(await emailOf(anaUserId)).toBeNull();
  });
});

describe("GitHub failing the read of the account's email addresses at a sign-in", () => {
  // A failed read reports nothing of the account's addresses: the sign-in succeeds and keeps the address it has.
  it("keeps the address Tiehall has, whether GitHub answers with an error or with a body that lists no addresses", async () => {
    stub.setEmails("ana-k", [{ email: "ana@acme.example", primary: true, verified: true, visibility: "private" }]);
    expect((await harness.signIn("ana-k")).response.status).toBe(302);
    expect(await emailOf(anaUserId)).toBe("ana@acme.example");
    const answers = [
      () => new Response('{"message":"Server Error"}', { status: 502, headers: { "content-type": "application/json" } }),
      () => new Response("<html><body>Blocked by policy.</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ];
    for (const answer of answers) {
      const failing = await startSignIn(install, stub, {
        sameAppAs: harness,
        fetch: async (input, init) => (new URL(input instanceof Request ? input.url : String(input)).pathname === "/user/emails" ? answer() : fetch(input, init)),
      });
      const { response, jar } = await failing.signIn("ana-k");
      expect(response.status).toBe(302);
      expect(await failing.sessionOf(jar)).toMatchObject({ userId: anaUserId });
      expect(await emailOf(anaUserId)).toBe("ana@acme.example");
    }
  });
});

describe("an email address in the company's domain", () => {
  it("admits nobody who is not otherwise admitted", async () => {
    stub.addUser({ login: "kim-at-acme", email: "kim@acme.example" });
    const { response, jar } = await harness.signIn("kim-at-acme");
    expect(response.status).toBe(403);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect((await install.owner.query("SELECT count(*) FROM users WHERE email = 'kim@acme.example'")).rows[0].count).toBe("0");
  });
});
