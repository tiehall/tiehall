import { describe, it } from "vitest";

// New members join as members (sign-in: New members join as members;
// design.md, Self-hosting decisions: S5 and S6). A person admitted through
// membership of a GitHub organization joins the install with the role
// `member` and in no team, whatever their role in the organization: roles are
// set in Tiehall and never taken from GitHub. A person who holds a valid
// invite joins through it, with the invite's role, even when membership of a
// GitHub organization would also admit them, so leaving the organization later
// does not end their access.
//
// Nobody new can be admitted yet: the sign-in service admits only people who
// are already members of the install until task 7.10 adds admission through a
// connected installation's organization and invites (task 9.5) exist. So these
// cases wait for them, as to-do, and become plain tests when those tasks land
// (task 7.13).

describe("a new member", () => {
  it.todo("who owns the GitHub organization of a connected installation joins with the role member and in no team, when they hold no invite");

  it.todo(
    "who holds a valid invite with the role admin and is also a member of the connected installation's organization joins through the invite, with the role admin",
  );

  it.todo("who joined through an invite keeps their access after leaving the GitHub organization");
});
