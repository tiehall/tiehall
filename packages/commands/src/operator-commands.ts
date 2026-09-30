import { memberRoleChanged, operatorCommandRun, Refusal, setupReopened, type Role } from "@tiehall/core";
import { members, orgs, users, type Database } from "@tiehall/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { generateSetupCode, storeSetupCode } from "./setup-code.ts";
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
//
// `setup reopen` reopens the setup screen's GitHub App step and prints a new
// setup code, so the operator can create the App again, for example after its
// credentials leaked or it was deleted (design.md, Self-hosting decisions: S3;
// Readings to confirm: R4). Setup stays complete: the install keeps serving
// its members, web sessions and tokens with the App in use until the setup
// screen stores a new App's credentials (setup-route.ts), and the step closes
// only when a person who is already an admin signs in from the setup screen
// (setup-completion.ts). The code is stored as a start's is (setup-code.ts);
// running the command again while the step is open replaces the code and keeps
// the step, and the time it opened. Before setup completes, the setup screen
// is open already, and the command runs nothing.

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

/** What `setup reopen` did: the new setup code, which opens the reopened step, and whether a step was open already. */
export interface ReopenSetupResult {
  code: string;
  alreadyOpen: boolean;
}

/**
 * Runs `setup reopen`: opens the setup screen's GitHub App step, or keeps it
 * open, stores a new setup code in place of any other, and records the run as
 * a security event. Throws SetupRequiredError before setup completes.
 */
export async function reopenSetup(database: Database, options: { random?: (size: number) => Buffer } = {}): Promise<ReopenSetupResult> {
  const code = generateSetupCode(options.random);
  return write({ database, jobs: NO_JOBS }, { actorKind: "operator", command: "setup reopen" }, async (writer) => {
    // Held until the transaction ends, as the setup screen's writes and the step's close hold it.
    const [org] = await writer.tx.select({ reopenedAt: orgs.setupReopenedAt }).from(orgs).where(eq(orgs.id, writer.orgId)).for("update");
    const alreadyOpen = org?.reopenedAt !== null && org?.reopenedAt !== undefined;
    if (!alreadyOpen) await writer.tx.update(orgs).set({ setupReopenedAt: sql`now()` }).where(eq(orgs.id, writer.orgId));
    await storeSetupCode(writer.tx, writer.orgId, code);
    await writer.record(setupReopened, { alreadyOpen });
    return { code, alreadyOpen };
  });
}
