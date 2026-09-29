import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_JSON } from "@tiehall/catalog";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { SIGN_IN_REFUSED, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { callApi, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The sign-in policy (sign-in: The sign-in policy; agent-safety: Actions that
// need the confirmation step; activity-log: Which actions are security events;
// design.md, Self-hosting decisions: S5 and S7). The install has one sign-in
// policy with two settings: "organization members and invited people", which
// a new install starts with, and "invited people only", under which
// membership of a GitHub organization admits nobody who is not a member yet,
// while invites and existing memberships still admit. Changing it removes no
// member. Only an admin changes it, in the web UI, with the confirmation step,
// and no agent surface offers the change. Each change is a security event.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let pia: WebSessionCaller;
let dana: WebSessionCaller;
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "ana-acme", "lee-acme", "kim-acme", "jo-contracts"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin", "ana-acme": "member", "lee-acme": "member", "kim-acme": "member" } });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  install.useGitHub(harness.github);
  pia = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "pia" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana" }), sessionId: randomUUID() };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

async function policy(): Promise<string> {
  const { rows } = await install.owner.query<{ policy: string }>(
    "SELECT coalesce((SELECT sign_in_policy FROM install_settings), (SELECT column_default FROM information_schema.columns WHERE table_name = 'install_settings' AND column_name = 'sign_in_policy')) AS policy",
  );
  return rows[0]!.policy.replace(/^'(.*)'::text$/, "$1");
}

async function isMember(login: string): Promise<boolean> {
  const { rows } = await install.owner.query("SELECT 1 FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id WHERE u.github_login = $1", [
    login,
  ]);
  return rows.length === 1;
}

describe("a new install", () => {
  it("admits organization members, its policy being organization members and invited people", async () => {
    expect(await policy()).toBe("organization_members_and_invited");
    expect((await harness.signIn("ana-acme")).response.status).toBe(302);
    expect(await isMember("ana-acme")).toBe(true);
  });
});

describe("an admin's change of the policy", () => {
  it("shows on its review page, in Tiehall's words, what it changes", async () => {
    const input = encodeURIComponent(JSON.stringify({ policy: "invited_only" }));
    const page = await install.confirmRoute(pia)(new Request(`${URL_OF_INSTALL}/confirm/settings.set_sign_in_policy?input=${input}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Change the install&#39;s sign-in policy from organization members and invited people to invited people only.");
    expect(html).toContain("No member is removed");
    expect(await policy()).toBe("organization_members_and_invited");
  });

  it("to invited people only applies once confirmed, removes no member, and is a security event naming the admin and both settings", async () => {
    const from = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    expect((await install.confirm(pia, "settings.set_sign_in_policy", { policy: "invited_only" })).status).toBe(200);
    expect(await policy()).toBe("invited_only");
    expect(await isMember("ana-acme")).toBe(true);
    const { rows } = await install.owner.query("SELECT type, class, data, actor_kind, actor_user_id FROM events WHERE number > $1 ORDER BY number", [from]);
    expect(rows).toEqual([
      {
        type: "settings.sign_in_policy_changed",
        class: "security",
        data: { policy: "invited_only", previousPolicy: "organization_members_and_invited" },
        actor_kind: "web_session",
        actor_user_id: pia.userId,
      },
    ]);
  });
});

describe("under invited people only", () => {
  it("a new organization member gets 403 and the text that says to ask an admin for an invite", async () => {
    const { response } = await harness.signIn("lee-acme");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
    expect(await isMember("lee-acme")).toBe(false);
  });

  it("an existing member who joined through the organization still signs in", async () => {
    expect((await harness.signIn("ana-acme")).response.status).toBe(302);
  });

  it("an invited person still signs in, organization member or not", async () => {
    for (const login of ["kim-acme", "jo-contracts"]) {
      expect((await install.confirm(pia, "invites.create", { login })).status).toBe(200);
      expect((await harness.signIn(login)).response.status, login).toBe(302);
      expect(await isMember(login), login).toBe(true);
    }
  });

  it("changed back to organization members and invited people, admits new organization members again", async () => {
    expect((await install.confirm(pia, "settings.set_sign_in_policy", { policy: "organization_members_and_invited" })).status).toBe(200);
    expect((await harness.signIn("lee-acme")).response.status).toBe(302);
  });
});

describe("changing the policy", () => {
  it("by a member gets 403, and the policy is unchanged", async () => {
    const before = await policy();
    expect((await install.confirm(dana, "settings.set_sign_in_policy", { policy: "invited_only" })).status).toBe(403);
    expect(await policy()).toBe(before);
  });

  it("without the confirmation step gets 403, and the policy is unchanged", async () => {
    const before = await policy();
    const result = await install.web(pia).write("settings.set_sign_in_policy", { policy: "invited_only" }, install.fromThePage(pia));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await policy()).toBe(before);
  });

  it("is offered on no agent surface: neither the OpenAPI document, the CLI nor the tool list has it, and an admin's token gets 404", async () => {
    const document = JSON.parse(OPENAPI_JSON) as { paths: Record<string, Record<string, { operationId?: string; "x-tiehall-cli"?: unknown }>> };
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
    expect(operations.map(({ operationId }) => operationId)).not.toContain("settings.set_sign_in_policy");
    const tools = JSON.parse(readFileSync(new URL("../../../mcp/tools.json", import.meta.url), "utf8")) as { tools: { _meta?: { operationId?: string } }[] };
    expect(tools.tools.map(({ _meta }) => _meta?.operationId)).not.toContain("settings.set_sign_in_policy");
    const before = await policy();
    const token = tokenOf(pia.userId);
    await expect(install.execute("settings.set_sign_in_policy", token, { policy: "invited_only" })).rejects.toMatchObject({ status: 404 });
    expect((await callApi(install, token, "POST", "/api/v1/settings/sign-in-policy", { policy: "invited_only" })).status).toBe(404);
    expect(await policy()).toBe(before);
  });
});
