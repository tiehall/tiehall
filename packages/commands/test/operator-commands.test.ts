import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, SetupRequiredError } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// The operator command `admin grant <github-login>` (self-host-install:
// Operator commands on the host; activity-log: Which actions are security
// events; design.md, Self-hosting decisions: S3). The operator runs it on the
// host through the image's admin role, which connects as the app role, so it
// needs no web UI and no confirmation step: whoever runs it already controls
// the host. It makes the member whose GitHub account has that login an admin;
// a login that belongs to no member changes nothing, and the command says so.
// Each run is a security event that names the command and what it changed,
// and no user: a grant is the role change's own event, with the command as
// its cause, and a run that changed nothing is the command's run.

let install: TestInstall;
let ada: string;
let dana: string;
let lee: string;
let ana: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = await addUser(install.owner, { role: "admin", login: "ada" });
  dana = await addUser(install.owner, { role: "member", login: "dana-gh" });
  // Lee was removed: a user of the install who is no member.
  lee = await addUser(install.owner, { role: null, login: "octo-lee" });
  // Ana's account is one their company's enterprise manages on GitHub, whose login ends in the enterprise's shortcode after an underscore.
  ana = await addUser(install.owner, { role: "member", login: "ana_acme" });
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  // Ada is the only admin at the start of each test.
  await install.owner.query("UPDATE members SET role = CASE WHEN user_id = $1 THEN 'admin' ELSE 'member' END", [ada]);
});

async function roleOf(userId: string): Promise<string | undefined> {
  return (await install.owner.query<{ role: string }>("SELECT role FROM members WHERE user_id = $1", [userId])).rows[0]?.role;
}

interface EventRow {
  type: string;
  class: string;
  actor_kind: string;
  actor_user_id: string | null;
  operator_command: string | null;
  client: string | null;
  surface: string | null;
  team_id: string | null;
  data: unknown;
}

async function eventsAfter(number: number): Promise<EventRow[]> {
  const { rows } = await install.owner.query<EventRow>(
    `SELECT type, class, actor_kind, actor_user_id, operator_command, client, surface, team_id, data
       FROM events WHERE number > $1 ORDER BY number`,
    [number],
  );
  return rows;
}

async function lastEvent(): Promise<number> {
  return Number((await install.owner.query<{ last: string | null }>("SELECT max(number) AS last FROM events")).rows[0]?.last ?? 0);
}

/** What an event caused by the admin grant command carries besides its type and data: the command, and no user. */
const BY_ADMIN_GRANT = {
  class: "security",
  actor_kind: "operator",
  actor_user_id: null,
  operator_command: "admin grant",
  client: null,
  surface: null,
  team_id: null,
};

describe("admin grant", () => {
  it("makes the member whose login is given an admin, recorded as a security event member.role_changed that names the command and no user", async () => {
    const before = await lastEvent();
    const result = await grantAdmin(install.db, "dana-gh");
    expect(result).toEqual({ outcome: "granted", userId: dana, login: "dana-gh" });
    expect(await roleOf(dana)).toBe("admin");
    expect(await eventsAfter(before)).toEqual([
      { type: "member.role_changed", ...BY_ADMIN_GRANT, data: { userId: dana, role: "admin", previousRole: "member" } },
    ]);
  });

  it("finds the member whatever the case of the login, as GitHub does", async () => {
    const result = await grantAdmin(install.db, "Dana-GH");
    expect(result).toEqual({ outcome: "granted", userId: dana, login: "dana-gh" });
    expect(await roleOf(dana)).toBe("admin");
  });

  it("makes a member whose account an enterprise manages an admin, by the login with the enterprise's shortcode", async () => {
    const result = await grantAdmin(install.db, "ana_acme");
    expect(result).toEqual({ outcome: "granted", userId: ana, login: "ana_acme" });
    expect(await roleOf(ana)).toBe("admin");
  });

  it("refuses a text that cannot be a GitHub login, and changes and records nothing", async () => {
    const before = await lastEvent();
    for (const login of ["-dana", "_acme", "dana gh", "dana/gh", "a".repeat(101), ""]) {
      await expect(grantAdmin(install.db, login), login).rejects.toThrow("is not a GitHub login.");
    }
    expect(await eventsAfter(before)).toEqual([]);
  });

  it("changes nothing for a login that belongs to no member and says so, recording the run as a security event operator.command_run that names the command and no user", async () => {
    const before = await lastEvent();
    const roles = (await install.owner.query("SELECT user_id, role FROM members ORDER BY user_id")).rows;
    for (const login of ["no-such-member", "octo-lee"]) {
      expect(await grantAdmin(install.db, login)).toEqual({ outcome: "no_member" });
    }
    expect((await install.owner.query("SELECT user_id, role FROM members ORDER BY user_id")).rows).toEqual(roles);
    expect(await roleOf(lee)).toBeUndefined();
    expect(await eventsAfter(before)).toEqual([
      { type: "operator.command_run", ...BY_ADMIN_GRANT, data: { outcome: "no_member" } },
      { type: "operator.command_run", ...BY_ADMIN_GRANT, data: { outcome: "no_member" } },
    ]);
  });

  it("changes nothing for a member who is an admin already, and records the run naming them", async () => {
    const before = await lastEvent();
    expect(await grantAdmin(install.db, "ada")).toEqual({ outcome: "already_admin", userId: ada, login: "ada" });
    expect(await roleOf(ada)).toBe("admin");
    expect(await eventsAfter(before)).toEqual([
      { type: "operator.command_run", ...BY_ADMIN_GRANT, data: { outcome: "already_admin", userId: ada } },
    ]);
  });

  it("recovers admin access when every admin has lost theirs: Dana becomes an admin beside Ada", async () => {
    await grantAdmin(install.db, "dana-gh");
    const admins = (await install.owner.query<{ user_id: string }>("SELECT user_id FROM members WHERE role = 'admin' ORDER BY user_id")).rows;
    expect(admins.map(({ user_id }) => user_id).sort()).toEqual([ada, dana].sort());
  });

  it("grants once when it runs twice at once, and records one role change and one run that changed nothing", async () => {
    const before = await lastEvent();
    const results = await Promise.all([grantAdmin(install.db, "dana-gh"), grantAdmin(install.db, "dana-gh")]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["already_admin", "granted"]);
    expect((await eventsAfter(before)).map(({ type }) => type).sort()).toEqual(["member.role_changed", "operator.command_run"]);
  });
});

describe("admin grant before setup completes", () => {
  let fresh: TestInstall;

  beforeAll(async () => {
    fresh = await startTestInstall();
    await addUser(fresh.owner, { role: "member", login: "dana-gh", userId: randomUUID() });
    await fresh.owner.query("UPDATE orgs SET setup_completed_at = NULL");
  });

  afterAll(async () => {
    await fresh.close();
  });

  it("changes nothing and records nothing, because the install has no admin to recover before its first", async () => {
    await expect(grantAdmin(fresh.db, "dana-gh")).rejects.toBeInstanceOf(SetupRequiredError);
    expect((await fresh.owner.query("SELECT role FROM members")).rows).toEqual([{ role: "member" }]);
    expect((await fresh.owner.query("SELECT count(*)::int AS count FROM events")).rows).toEqual([{ count: 0 }]);
  });
});
