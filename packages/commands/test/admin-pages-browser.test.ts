import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startAppServer, type AppServer } from "./support/app-server.ts";

// The admin pages for members, invites and teams, in real browsers
// (teams-and-roles: What admins and members may do; teams-and-roles: Invites
// by GitHub username; teams-and-roles: Changing a member's role;
// teams-and-roles: Teams). The operator sets up the install at
// https://tiehall.example.com with the GitHub stub and becomes its first
// admin. On the invites page, they invite the GitHub username lee-dev, whose
// account belongs to no organization with a connected installation, and
// confirm the invite on its review page. Lee then signs in with GitHub in a
// browser of their own and joins as a member, in no team. The admin creates
// the team FE on the teams page and adds Lee to it, then makes Lee an admin on
// the members page, confirming the change on its review page; Lee's next page
// load is an admin's. Last, the admin changes the sign-in policy on its page,
// with a confirmation (sign-in: The sign-in policy).

let stub: GitHubStub;
let server: AppServer;
let browser: Browser;

// The hooks start and close an install and Chrome for each test, so they get timeouts that hold on a CI runner, where
// Vitest's 10-second default for hooks ran out.
beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addUser({ login: "lee-dev" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  // The operator's browser is signed in to GitHub as Omar; Lee's browser names Lee with the stub's cookie.
  stub.signIn("omar");
  server = await startAppServer(stub);
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: server.browserArgs });
}, 120_000);

afterEach(async () => {
  await browser?.close();
  await server?.close();
  await stub?.close();
}, 60_000);

/** The operator's way through the setup screen and GitHub's pages, which makes them the install's first admin. */
async function completeSetup(page: Page): Promise<void> {
  const { url } = server;
  const code = await server.start();
  await page.goto(`${url}/setup`);
  await page.getByLabel("Setup code").fill(code);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
  await page.getByLabel("The company's name").fill("Acme");
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
  await page.getByLabel("The GitHub organization that owns the App").fill("acme");
  await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
  await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/apps/new?*`), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);
  const [app] = stub.apps();
  await Promise.all([page.waitForURL(`${stub.webUrl}/apps/${app?.slug}/installations/new`), page.getByRole("link", { name: `Install ${app?.name} on GitHub` }).click()]);
  await page.getByLabel("Only select repositories").check();
  await page.getByLabel("acme/web").check();
  await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/installations/*`), page.getByRole("button", { name: "Install" }).click()]);
  await page.goto(`${url}/setup`);
  await Promise.all([page.waitForURL(`${stub.webUrl}/login/oauth/authorize?*`), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
  await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
}

/** Every member's GitHub login, role and team keys, as the database holds them. */
async function membersInDatabase(): Promise<{ login: string; role: string; teams: string[] }[]> {
  const { rows } = await server.owner.query<{ login: string; role: string; teams: string[] }>(
    `SELECT u.github_login AS login, m.role,
            coalesce(array_agg(t.key ORDER BY t.key) FILTER (WHERE t.key IS NOT NULL), '{}') AS teams
       FROM members m
       JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id
       LEFT JOIN team_members tm ON tm.org_id = m.org_id AND tm.user_id = m.user_id
       LEFT JOIN teams t ON t.org_id = tm.org_id AND t.id = tm.team_id
      GROUP BY u.github_login, m.role
      ORDER BY u.github_login`,
  );
  return rows;
}

/** The row of the members list that names a login, as the page shows it. */
function memberRow(page: Page, login: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: login, exact: true }) });
}

describe("the admin pages", { timeout: 180_000 }, () => {
  it("invite a GitHub username, who signs in and joins; the admin adds them to a team and makes them an admin with a confirmation", async () => {
    const { url } = server;
    const admin = await browser.newContext();
    const page = await admin.newPage();
    await completeSetup(page);
    expect(await membersInDatabase()).toEqual([{ login: "omar", role: "admin", teams: [] }]);

    // The invites page: the admin names the username and the role, and reviews the invite before it is created.
    await page.goto(`${url}/admin/invites`);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Invites");
    await expect(page.getByText("No invite is waiting to be accepted.").count()).resolves.toBe(1);
    await page.getByLabel("GitHub username").fill("lee-dev");
    await expect(page.getByLabel("Role").inputValue()).resolves.toBe("member");
    await Promise.all([page.waitForURL(/\/confirm\/invites\.create\?/), page.getByRole("button", { name: "Review the invite" }).click()]);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Invite a person");
    await expect(page.getByText("Invite the GitHub account lee-dev to the install, with the role member.").count()).resolves.toBe(1);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Confirmed");

    // The invite waits for Lee, with the role it gives.
    await page.goto(`${url}/admin/invites`);
    await expect(page.getByText(/^lee-dev, invited as member, valid until /).count()).resolves.toBe(1);
    await expect(page.getByRole("button", { name: "Revoke the invite for lee-dev" }).count()).resolves.toBe(1);

    // Lee signs in with GitHub in a browser of their own, and joins through the invite.
    const invitee = await browser.newContext();
    await invitee.addCookies([{ name: "stub_user", value: "lee-dev", url: stub.webUrl }]);
    const leePage = await invitee.newPage();
    await leePage.goto(`${url}/`);
    expect(leePage.url()).toBe(`${url}/sign-in`);
    const [app] = stub.apps();
    await Promise.all([leePage.waitForURL(`${stub.webUrl}/login/oauth/authorize?*`), leePage.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    await Promise.all([leePage.waitForURL(`${url}/`), leePage.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
    await expect(leePage.getByText("You are signed in.").count()).resolves.toBe(1);
    expect(await membersInDatabase()).toEqual([
      { login: "lee-dev", role: "member", teams: [] },
      { login: "omar", role: "admin", teams: [] },
    ]);
    // A member sees the members list, with no admin control, and no admin page.
    await leePage.goto(`${url}/members`);
    await expect(memberRow(leePage, "lee-dev").getByRole("cell", { name: "member", exact: true }).count()).resolves.toBe(1);
    await expect(leePage.getByRole("link", { name: /^Make / }).count()).resolves.toBe(0);
    expect((await leePage.goto(`${url}/admin/teams`))?.status()).toBe(403);

    // The accepted invite no longer waits.
    await page.goto(`${url}/admin/invites`);
    await expect(page.getByText("No invite is waiting to be accepted.").count()).resolves.toBe(1);

    // The teams page: the admin creates FE and adds Lee to it.
    await page.goto(`${url}/admin/teams`);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Teams");
    await page.getByLabel("Key", { exact: true }).fill("FE");
    await page.getByLabel("Name", { exact: true }).fill("Frontend");
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Create the team" }).click()]);
    await expect(page.getByRole("heading", { level: 2, name: "FE: Frontend" }).count()).resolves.toBe(1);
    await expect(page.getByText("Nobody belongs to FE.").count()).resolves.toBe(1);
    await page.getByLabel("Add a member to FE").selectOption({ label: "lee-dev" });
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Add to FE" }).click()]);
    await expect(page.getByRole("button", { name: "Remove lee-dev from FE" }).count()).resolves.toBe(1);

    // The members page: the admin makes Lee an admin, and confirms the change on its review page.
    await page.goto(`${url}/members`);
    await expect(memberRow(page, "lee-dev").getByRole("cell", { name: "FE", exact: true }).count()).resolves.toBe(1);
    await Promise.all([page.waitForURL(/\/confirm\/members\.change_role\?/), page.getByRole("link", { name: "Make lee-dev an admin" }).click()]);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Change a member's role");
    await expect(page.getByText("Change the role of the member lee-dev from member to admin.").count()).resolves.toBe(1);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Confirmed");
    await page.goto(`${url}/members`);
    await expect(memberRow(page, "lee-dev").getByRole("cell", { name: "admin", exact: true }).count()).resolves.toBe(1);
    expect(await membersInDatabase()).toEqual([
      { login: "lee-dev", role: "admin", teams: ["FE"] },
      { login: "omar", role: "admin", teams: [] },
    ]);

    // The new role applies from Lee's next call: the admin pages open for them now.
    expect((await leePage.goto(`${url}/admin/teams`))?.status()).toBe(200);
    await expect(leePage.getByRole("heading", { level: 2, name: "FE: Frontend" }).count()).resolves.toBe(1);

    // The sign-in policy page: the admin moves the install to invited people only, with a confirmation.
    await page.goto(`${url}/admin/sign-in-policy`);
    await expect(page.getByText("The install's sign-in policy is organization members and invited people.").count()).resolves.toBe(1);
    await Promise.all([
      page.waitForURL(/\/confirm\/settings\.set_sign_in_policy\?/),
      page.getByRole("link", { name: "Change the policy to invited people only" }).click(),
    ]);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Change the sign-in policy");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Confirmed");
    await page.goto(`${url}/admin/sign-in-policy`);
    await expect(page.getByText("The install's sign-in policy is invited people only.").count()).resolves.toBe(1);

    // After setup's own events, the invite, Lee's joining and sign-in, the role change and the sign-in policy are
    // security events; creating the team and adding Lee to it are not.
    const { rows: events } = await server.owner.query<{ type: string }>("SELECT type FROM events WHERE class = 'security' ORDER BY number");
    expect(events.map(({ type }) => type)).toEqual([
      "setup.completed",
      "github.installation_connected",
      "sign_in.completed",
      "invite.created",
      "member.joined",
      "sign_in.completed",
      "member.role_changed",
      "settings.sign_in_policy_changed",
    ]);
    await invitee.close();
    await admin.close();
  });
});
