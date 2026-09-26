import { describe, it } from "vitest";

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
// These cases wait for the sign-in service (task 7.6) and its after-hooks
// (7.14), the consent screen's approval (15.10) and the "Connected agents and
// tokens" page (15.17); each becomes a plain test when its task lands. Until
// then they are to-do, so the suite stays green and the contract is written
// down (task 20.3).

describe("a write the sign-in service owns", () => {
  it.todo("a sign-in appends its security event right after the sign-in service stores the session, naming the user, with the IP address and user agent kept apart");

  it.todo(
    "a client approval on the consent screen, with the confirmation step, appends its security event right after the sign-in service stores the grant, naming the user and the client",
  );

  it.todo(
    "a grant revocation on the Connected agents and tokens page appends its security event right after the sign-in service removes the grant, naming the user and the grant",
  );
});
