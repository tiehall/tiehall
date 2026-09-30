import { memberRoleChanged, operatorCommandRun, Refusal, type Role } from "@tiehall/core";
import { members, users, type Database } from "@tiehall/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { write } from "./write.ts";

// The operator commands the image's admin role runs on the host
// (self-host-install: Operator commands on the host; activity-log: Which
// actions are security events; design.md, Self-hosting decisions: S3). They
// work without the web UI and without the confirmation step, because whoever
// can run them already controls the host, and they connect as the app role,
// through the one write path, so each change and its security event commit
// together or not at all. Every run is recorded as a security event that names
// the command, as its provenance, and what it changed, and no user: a change is
// recorded as that change's own event, and a run that changed nothing as the
// command's run (operator.command_run).
//
// `admin grant <github-login>` makes the member whose GitHub account has that
// login an admin, as a way back in when no admin can sign in any more. GitHub
// logins do not depend on case, so neither does the match. A login that
// belongs to no member of the install, such as a removed member's, changes
// nothing, and the command says so. The admins' rows and the member's are
// locked as an admin's role change locks them (member-changes.ts), so a grant
// run twice at once changes the role once. Before setup completes the install
// has no admin to recover, and the command runs nothing (withOrg).

/** A GitHub login: 1 to 39 letters, digits and single hyphens, neither first nor last. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Whether a text can be a GitHub login, as GitHub gives them out. */
export function isGitHubLogin(text: string): boolean {
  return GITHUB_LOGIN.test(text);
}

/** What `admin grant` did: made the member an admin, found them an admin already, or found no member with the login. */
export type GrantAdminResult =
  | { outcome: "granted" | "already_admin"; userId: string; login: string }
  | { outcome: "no_member" };

/** Writes that start no job, as no operator command does. */
const NO_JOBS = {
  send: () => Promise.reject(new Error("An operator command starts no job.")),
};

/**
 * Runs `admin grant <login>`: makes the member whose GitHub login it is an
 * admin, with the role change's security event, or records that the run
 * changed nothing. Throws SetupRequiredError before setup completes, and a
 * Refusal for a text that cannot be a GitHub login.
 */
export async function grantAdmin(database: Database, login: string): Promise<GrantAdminResult> {
  if (!isGitHubLogin(login)) throw new Refusal("invalid-input", `${JSON.stringify(login)} is not a GitHub login.`);
  return write({ database, jobs: NO_JOBS }, { actorKind: "operator", command: "admin grant" }, async (writer) => {
    // The admins' rows first, then the member's, in the order an admin's role change takes them.
    await writer.tx
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.orgId, writer.orgId), eq(members.role, "admin")))
      .orderBy(asc(members.userId))
      .for("update");
    const found = await writer.tx
      .select({ userId: members.userId, role: members.role, login: users.githubLogin })
      .from(members)
      .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
      .where(and(eq(members.orgId, writer.orgId), sql`lower(${users.githubLogin}) = lower(${login})`))
      .orderBy(asc(members.userId))
      .for("update", { of: members });
    // Logins are unique on GitHub; two members can share one only when a rename has not reached Tiehall yet.
    const member = found.length === 1 ? found[0] : undefined;
    if (member === undefined) {
      await writer.record(operatorCommandRun, { outcome: "no_member" });
      return { outcome: "no_member" };
    }
    if (member.role === "admin") {
      await writer.record(operatorCommandRun, { outcome: "already_admin", userId: member.userId });
      return { outcome: "already_admin", userId: member.userId, login: member.login };
    }
    await writer.tx
      .update(members)
      .set({ role: "admin" })
      .where(and(eq(members.orgId, writer.orgId), eq(members.userId, member.userId)));
    await writer.record(memberRoleChanged, { userId: member.userId, role: "admin", previousRole: member.role as Role });
    return { outcome: "granted", userId: member.userId, login: member.login };
  });
}
