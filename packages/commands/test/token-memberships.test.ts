import { describe, expect, it } from "vitest";
import type { Member } from "../src/members.ts";
import { revokedByRemoval } from "../src/with-org.ts";

// Which membership an access token belongs to (agent-access: Every token call
// is checked against the install's current state; teams-and-roles: Removing a
// member). A removal ends the user's membership, and a token issued in it is
// refused as revoked once they are a member again. A token names the
// membership it was issued in by the number each new membership takes, so no
// clock decides; a membership kept before the numbers were, and a token
// issued before them, fall back to comparing the token's issue time with the
// membership's start, to the second.

const joinedAt = new Date("2026-10-01T09:00:00.500Z");
const numbered: Member = { userId: "00000000-0000-4000-8000-000000000001", role: "member", joinedAt, tokenGeneration: 42 };
const unnumbered: Member = { ...numbered, tokenGeneration: null };

describe("a token of a numbered membership", () => {
  it("is good in that membership alone, whatever the clocks say", () => {
    expect(revokedByRemoval(numbered, { membership: 42, issuedAt: new Date("2026-09-01T00:00:00Z") })).toBe(false);
    expect(revokedByRemoval(numbered, { membership: 41, issuedAt: new Date("2026-10-02T00:00:00Z") })).toBe(true);
  });

  it("is refused when it names no membership, as a token issued before the numbers were kept", () => {
    expect(revokedByRemoval(numbered, { issuedAt: new Date("2026-10-02T00:00:00Z") })).toBe(true);
  });
});

describe("a membership kept before the numbers were", () => {
  it("takes a token that names no membership when it was issued in the second the membership began or later", () => {
    expect(revokedByRemoval(unnumbered, { issuedAt: new Date("2026-10-01T09:00:00Z") })).toBe(false);
    expect(revokedByRemoval(unnumbered, { issuedAt: new Date("2026-10-01T08:59:59Z") })).toBe(true);
  });

  it("refuses a token that names a membership, which was another one", () => {
    expect(revokedByRemoval(unnumbered, { membership: 7, issuedAt: new Date("2026-10-02T00:00:00Z") })).toBe(true);
  });
});

it("checks nothing for a call made with no access token", () => {
  expect(revokedByRemoval(numbered, {})).toBe(false);
});
