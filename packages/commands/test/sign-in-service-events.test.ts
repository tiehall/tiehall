import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Writes the sign-in service owns are still recorded (activity-log: Writes
// the sign-in service owns are still recorded; activity-log: Which actions are
// security events; design.md, Technical decisions: T8; design.md,
// Self-hosting decisions: S14). Where the sign-in service itself stores a
// change, such as a new session at sign-in or an agent client's grant on the
// consent screen, an after-hook appends the matching security event right
// after the sign-in service's write, with the caller's IP address and user
// agent in the side table. Because the two are not one transaction, the
// nightly comparison (trust-state-reconciliation.test.ts) catches an event
// lost between them.
//
// The consent screen's approval (15.10) and the "Connected agents and tokens"
// page (15.17) are not built yet, so their cases wait as to-do; each becomes a
// plain test when its task lands (task 20.3).

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let alice: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const account = stub.addUser({ login: "alice", email: "alice@acme.example" });
  alice = await addUser(install.owner, { login: "alice", githubAccountId: account.id });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

describe("a write the sign-in service owns", () => {
  it("a sign-in appends its security event right after the sign-in service stores the session, naming the user, with the IP address and user agent kept apart", async () => {
    const { rows: before } = await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events");
    const { response, jar } = await harness.signIn("alice", { headers: { "x-forwarded-for": "198.51.100.23", "user-agent": "Mozilla/5.0 (alice)" } });
    expect(response.status).toBe(302);
    const session = await harness.sessionOf(jar);
    const { rows } = await install.owner.query(
      `SELECT e.type, e.class, e.data, e.actor_user_id, e.occurred_at >= s.created_at AS after_the_session, host(o.ip_address) AS ip, o.user_agent
         FROM events e
         JOIN web_sessions s ON s.id = $2
         LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
        WHERE e.number > $1`,
      [before[0].n, session?.sessionId],
    );
    expect(rows).toEqual([
      {
        type: "sign_in.completed",
        class: "security",
        data: { userId: alice },
        actor_user_id: alice,
        after_the_session: true,
        ip: "198.51.100.23",
        user_agent: "Mozilla/5.0 (alice)",
      },
    ]);
  });

  it.todo(
    "a client approval on the consent screen, with the confirmation step, appends its security event right after the sign-in service stores the grant, naming the user and the client",
  );

  it.todo(
    "a grant revocation on the Connected agents and tokens page appends its security event right after the sign-in service removes the grant, naming the user and the grant",
  );
});
