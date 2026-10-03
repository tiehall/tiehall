import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubDelivery, type StubInstallation } from "@tiehall/testing/github";
import { checkDepartures, createLogger, processDelivery, processGitHubDelivery, reconcileGitHub, SIGN_IN_REFUSED, type WebSessionCaller } from "../src/index.ts";
import { storeDelivery } from "./support/github-app.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { invite } from "./support/invites.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Leaving the GitHub organization ends access (sign-in: Leaving the GitHub
// organization ends access; activity-log: Which actions are security events;
// requests: A removed member's claims stay and their proposals are
// cancelled; design.md, Self-hosting decisions: S5). A member who joined
// through membership of a GitHub organization is removed, as an admin removal
// would remove them but with no block, once GitHub positively reports,
// through a connected installation that is working, that their account is no
// longer a member of an organization Tiehall has seen it in, and no working
// connected installation reports it a member of its organization. Tiehall
// checks on the `organization` event, at every sign-in, and in a
// reconciliation job every 15 minutes, in either GitHub mode. A lookup that
// fails, and an installation that is suspended, deleted or disconnected,
// never count as leaving. Members who joined through an invite or by
// completing setup are never removed this way, and neither is the install's
// only admin, until another admin exists. Each removal is a security event
// that names leaving the organization as its cause.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let acme: StubInstallation;
let pia: WebSessionCaller;
/** Tiehall's ids of the connected installations, by account. */
let connected: Record<string, string>;
/** The stub's numeric ids of the accounts, by login. */
const ids = new Map<string, number>();

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["root-acme", "omar-acme", "lee-acme", "jo-acme", "kim-acme", "ana-acme"]) ids.set(login, stub.addUser({ login }).id);
  // root-acme owns both organizations on GitHub, and never signs in to the install.
  stub.addOrg({
    login: "acme",
    members: { "root-acme": "admin", "omar-acme": "admin", "lee-acme": "member", "jo-acme": "member", "kim-acme": "member", "ana-acme": "member" },
  });
  stub.addOrg({ login: "acme-labs", members: { "root-acme": "admin" } });
  // GitHub cannot reach the install here: each delivery is logged, with what GitHub sent, and a test stores it.
  harness = await startSignIn(install, stub, { hook: { url: "https://tiehall.example.com/webhooks/github" } });
  stub.updateApp(harness.app, { public: true });
  acme = await stub.install(harness.app, { account: "acme" });
  await stub.install(harness.app, { account: "acme-labs" });
  connected = await harness.connect("acme");
  install.useGitHub(harness.github);
  pia = sessionOf(await addUser(install.owner, { login: "pia", role: "admin" }));
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await install?.close();
});

/** Signs the person in, which makes them a member through the organizations that report them; returns their user. */
async function join(login: string): Promise<string> {
  const { response, jar } = await harness.signIn(login);
  expect(response.status, login).toBe(302);
  return (await harness.sessionOf(jar))!.userId;
}

async function isMember(userId: string): Promise<boolean> {
  return (await install.owner.query("SELECT 1 FROM members WHERE user_id = $1", [userId])).rows.length === 1;
}

async function roleOf(userId: string): Promise<string | undefined> {
  return (await install.owner.query<{ role: string }>("SELECT role FROM members WHERE user_id = $1", [userId])).rows[0]?.role;
}

/** The 15-minute reconciliation, as the worker runs it. */
async function reconcile(): Promise<void> {
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github: harness.github, execute: install.execute, jobs: { send: async () => undefined } },
  );
}

/**
 * GitHub answers a requester that may not see acme's members as it documents: the membership check sends it on to
 * the public membership check, and the member list holds the public members only, of whom omar-acme is one.
 */
function answerPublicMembersOnly(): void {
  stub.setMemberAnswers("documented");
  stub.setMembershipPublic("acme", "omar-acme", true);
}

/** The installation's permissions without the Members permission, as GitHub issues its tokens once an owner removed it. */
function withoutMembersPermission(installation: StubInstallation): void {
  const { members: _removed, ...rest } = installation.permissions;
  stub.setInstallationPermissions(installation, rest);
}

/** The member lookups GitHub answered from here on as it does a requester that may not see the members: by the public members only. */
function publicAnswers(from: number): string[] {
  return stub.received
    .slice(from)
    .filter(({ path, status }) => (/^\/orgs\/[^/]+\/members(\/[^/]+)?$/.test(path) && (status === 302 || status === 200)) || path.includes("/public_members/"))
    .map(({ method, path, status }) => `${method} ${path} ${status}`);
}

/** The reconciliation, through a new client of the App, so it uses no installation token issued earlier. */
async function reconcileAnew(): Promise<void> {
  const reading = await startSignIn(install, stub, { sameAppAs: harness });
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github: reading.github, execute: install.execute, jobs: { send: async () => undefined } },
  );
}

/** Stores and processes a delivery GitHub made, as the worker does. */
async function processed(delivery: StubDelivery | undefined): Promise<void> {
  expect(delivery).toBeDefined();
  const deliveryId = await storeDelivery(install, delivery!);
  await processDelivery({ database: install.db, github: harness.github, execute: install.execute, logger: install.logger }, deliveryId);
}

async function removals(userId: string): Promise<{ data: Record<string, unknown>; actor_kind: string; actor_user_id: string | null }[]> {
  const { rows } = await install.owner.query(
    "SELECT data, actor_kind, actor_user_id FROM events WHERE type = 'member.removed' AND data->>'userId' = $1 ORDER BY number",
    [userId],
  );
  return rows;
}

async function isBlocked(login: string): Promise<boolean> {
  const { rows } = await install.owner.query(
    "SELECT 1 FROM sign_in_blocks b JOIN users u ON u.org_id = b.org_id AND u.github_account_id = b.github_account_id WHERE u.github_login = $1",
    [login],
  );
  return rows.length === 1;
}

describe("the organization event", () => {
  it("removes a member who joined through the organization, keeps their claim, cancels their proposals, and records the cause with no block", async () => {
    const lee = await join("lee-acme");
    const ana = await join("ana-acme");
    await joinTeams(install.owner, ana, await addTeam(install.owner, "BE"));
    await joinTeams(install.owner, lee, await addTeam(install.owner, "FE"));
    const claimed = await openRequest<{ key: string }>(install, tokenOf(ana), { targetTeam: "FE" });
    const declined = await openRequest<{ key: string }>(install, tokenOf(ana), { targetTeam: "FE" });
    for (const { key } of [claimed, declined]) expect((await callApi(install, tokenOf(lee), "POST", `/api/v1/requests/${key}/claim`)).status).toBe(200);
    const proposal = (await callApi(install, tokenOf(lee), "POST", `/api/v1/requests/${declined.key}/status`, { state: "declined" })).body.proposal.id as string;
    const agent = tokenOf(lee);

    const [delivery] = await stub.removeMember("acme", "lee-acme");
    await processed(delivery);

    expect(await isMember(lee)).toBe(false);
    expect((await callApi(install, agent, "GET", `/api/v1/requests/${claimed.key}`)).status).toBe(403);
    expect((await callApi(install, tokenOf(ana), "GET", `/api/v1/requests/${claimed.key}`)).body).toMatchObject({ state: "claimed", claimant: { id: lee } });
    const { rows } = await install.owner.query("SELECT state, cancel_reason FROM proposals WHERE id = $1", [proposal]);
    expect(rows).toEqual([{ state: "cancelled", cancel_reason: "accountable_removed" }]);
    expect(await removals(lee)).toEqual([
      {
        data: { userId: lee, cause: "left_organization", blocked: false, installationId: connected["acme"] },
        actor_kind: "integration",
        actor_user_id: null,
      },
    ]);
    expect(await isBlocked("lee-acme")).toBe(false);
  });

  // The worker's job that processes a delivery logs through the worker's own logger, as every job does, never
  // through a logger of its own that writes past the worker's.
  it("logs the removal through the logger the worker gives the processing job", async () => {
    const lee = await join("lee-acme");
    const [delivery] = await stub.removeMember("acme", "lee-acme");
    expect(delivery).toBeDefined();
    const deliveryId = await storeDelivery(install, delivery!);
    const lines: string[] = [];
    await processGitHubDelivery.handle(
      { id: randomUUID(), queue: processGitHubDelivery.type.queue, data: { deliveryId }, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github: harness.github, execute: install.execute, jobs: { send: async () => undefined }, logger: createLogger({ write: (line) => void lines.push(line) }) },
    );
    expect(await isMember(lee)).toBe(false);
    expect(lines.join("\n")).toContain("github: a member who left a GitHub organization was removed");
  });

  // GitHub's signature covers only a delivery's body, not its delivery id, so a captured body can come back under
  // a new id; and GitHub may deliver late or out of order. A delivery is a hint: Tiehall asks GitHub whether the
  // member is still in the organization before it removes anyone, so an old report removes nobody who is a member now.
  it("replayed under a new delivery id after the member rejoined removes nobody", async () => {
    const lee = await join("lee-acme");
    const [delivery] = await stub.removeMember("acme", "lee-acme");
    await processed(delivery);
    expect(await isMember(lee)).toBe(false);
    await stub.addMember("acme", "lee-acme", "member", { delivery: "none" });
    expect(await join("lee-acme")).toBe(lee);

    await processed({ ...delivery!, guid: randomUUID() });

    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toHaveLength(1);
  });

  it("arriving after GitHub reports the member back in the organization removes nobody", async () => {
    const lee = await join("lee-acme");
    // Lee leaves and rejoins before Tiehall processes the delivery of the leaving.
    const [delivery] = await stub.removeMember("acme", "lee-acme");
    await stub.addMember("acme", "lee-acme", "member", { delivery: "none" });

    await processed(delivery);

    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toEqual([]);
  });

  it("replayed after the member renamed their login removes nobody, because GitHub is asked by their account", async () => {
    const lee = await join("lee-acme");
    // A report of Lee leaving, captured and never processed; Lee stays in acme and renames the login.
    const [delivery] = await stub.removeMember("acme", "lee-acme");
    await stub.addMember("acme", "lee-acme", "member", { delivery: "none" });
    stub.renameUser("lee-acme", "lee-renamed");

    await processed({ ...delivery!, guid: randomUUID() });

    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toEqual([]);
  });

  it("removes nobody when GitHub cannot be asked whether the member left", async () => {
    const lee = await join("lee-acme");
    const [delivery] = await stub.removeMember("acme", "lee-acme");
    const erroring = await startSignIn(install, stub, {
      sameAppAs: harness,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (/^\/orgs\/[^/]+\/members/.test(url.pathname)) return new Response('{"message":"Server Error"}', { status: 500 });
        return fetch(input, init);
      },
    });
    const deliveryId = await storeDelivery(install, delivery!);
    await processDelivery({ database: install.db, github: erroring.github, execute: install.execute, logger: install.logger }, deliveryId);

    expect(await isMember(lee)).toBe(true);
  });

  it("about someone who never joined through the organization changes nothing", async () => {
    // Kim became a member some other way, such as through an invite, so Tiehall has seen Kim in no organization.
    const kim = await addUser(install.owner, { login: "kim-acme", githubAccountId: ids.get("kim-acme")! });
    const [delivery] = await stub.removeMember("acme", "kim-acme");
    await processed(delivery);
    expect(await isMember(kim)).toBe(true);
    expect(await removals(kim)).toEqual([]);
  });
});

describe("the reconciliation", () => {
  it("catches a change no event reported, in polling mode, and records it as the system's", async () => {
    const lee = await join("lee-acme");
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    expect(await isMember(lee)).toBe(true);
    await reconcile();
    expect(await isMember(lee)).toBe(false);
    expect(await removals(lee)).toEqual([
      { data: { userId: lee, cause: "left_organization", blocked: false, installationId: connected["acme"] }, actor_kind: "system", actor_user_id: null },
    ]);
  });

  it("keeps a member another connected organization reports a member, and remembers that organization", async () => {
    await stub.addMember("acme-labs", "lee-acme", "member", { delivery: "none" });
    connected = await harness.connect("acme", "acme-labs");
    const lee = await join("lee-acme");
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    await reconcile();
    expect(await isMember(lee)).toBe(true);
    // Leaving acme-labs as well, with no other organization reporting Lee, ends Lee's access.
    await stub.removeMember("acme-labs", "lee-acme", { delivery: "none" });
    await reconcile();
    expect(await isMember(lee)).toBe(false);
  });

  it("removes no one while the installation is suspended, even for a day of runs", async () => {
    const lee = await join("lee-acme");
    const ana = await join("ana-acme");
    await stub.suspend(acme, { delivery: "none" });
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    for (let run = 0; run < 3; run += 1) await reconcile();
    expect([await isMember(lee), await isMember(ana)]).toEqual([true, true]);
  });

  it("removes no one when GitHub answers the membership lookup with a server error", async () => {
    const lee = await join("lee-acme");
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    const erroring = await startSignIn(install, stub, {
      sameAppAs: harness,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (/^\/orgs\/[^/]+\/members/.test(url.pathname)) return new Response('{"message":"Server Error"}', { status: 500 });
        return fetch(input, init);
      },
    });
    await reconcileGitHub.handle(
      { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github: erroring.github, execute: install.execute, jobs: { send: async () => undefined } },
    );
    expect(await isMember(lee)).toBe(true);
  });

  it("removes no one when GitHub lists only the organization's public members, to a token GitHub issued without the Members permission", async () => {
    const lee = await join("lee-acme");
    answerPublicMembersOnly();
    withoutMembersPermission(acme);
    await reconcileAnew();
    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toEqual([]);
  });

  it("removes no one when GitHub lists only the organization's public members to a token issued with the Members permission, as it may after an owner removes that permission", async () => {
    const lee = await join("lee-acme");
    answerPublicMembersOnly();
    stub.setMembersPublicOnly("acme", true);
    const from = stub.received.length;
    await reconcileAnew();
    expect(publicAnswers(from)).toContain("GET /orgs/acme/members 200");
    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toEqual([]);
  });

  it("removes no one while another organization holds the organization's login, as after a rename, before the listing reads the new one", async () => {
    const lee = await join("lee-acme");
    // acme is renamed, and another organization takes the login, whose one public member is mallory.
    stub.setMemberAnswers("documented");
    stub.renameOrg("acme", "acme-inc");
    stub.addUser({ login: "mallory" });
    stub.addOrg({ login: "acme", members: { mallory: "member" } });
    stub.setMembershipPublic("acme", "mallory", true);
    // The check of the members, as the reconciliation runs it before its listing of the installations reads the new login.
    const reading = await startSignIn(install, stub, { sameAppAs: harness });
    const from = stub.received.length;
    await checkDepartures({ database: install.db, app: (await reading.github.app())!, logger: install.logger, provenance: { actorKind: "system" } }, { every: true });
    expect(stub.received.slice(from).map(({ method, path }) => `${method} ${path}`)).toContain("GET /users/acme");
    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toEqual([]);
  });

  it("removes no one after an admin disconnects the installation, until it is connected again and reports the member gone", async () => {
    const lee = await join("lee-acme");
    const result = await install.web(pia).write("github.disconnect_installation", { installation: connected["acme"] }, install.fromThePage(pia));
    expect(result).toMatchObject({ ok: true });
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    await reconcile();
    expect(await isMember(lee)).toBe(true);
    expect((await install.confirm(pia, "github.connect_installation", { installation: connected["acme"] })).status).toBe(200);
    await reconcile();
    expect(await isMember(lee)).toBe(false);
  });

  it("leaves members who joined through an invite alone", async () => {
    expect((await invite(install, pia, "jo-acme")).status).toBe(200);
    const jo = await join("jo-acme");
    await stub.removeMember("acme", "jo-acme", { delivery: "none" });
    await reconcile();
    expect(await isMember(jo)).toBe(true);
    expect((await harness.signIn("jo-acme")).response.status).toBe(302);
  });

  it("does not remove the install's only admin, and removes them at the first check after another admin exists", async () => {
    const omar = await join("omar-acme");
    await install.owner.query("UPDATE members SET role = CASE WHEN user_id = $1 THEN 'admin' ELSE 'member' END", [omar]);
    await stub.removeMember("acme", "omar-acme", { delivery: "none" });
    await reconcile();
    expect(await roleOf(omar)).toBe("admin");
    const kim = await join("kim-acme");
    expect((await install.confirm(sessionOf(omar), "members.change_role", { userId: kim, role: "admin" })).status).toBe(200);
    await reconcile();
    expect(await isMember(omar)).toBe(false);
    expect(await roleOf(kim)).toBe("admin");
  });
});

describe("a sign-in", () => {
  it("checks membership first: a member who left a minute ago, before any event or reconciliation, gets 403 and is no longer a member", async () => {
    const lee = await join("lee-acme");
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    const { response } = await harness.signIn("lee-acme");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
    expect(await isMember(lee)).toBe(false);
    expect((await removals(lee))[0]?.data).toMatchObject({ cause: "left_organization", blocked: false });
  });

  it("removes no member whose membership GitHub shows only publicly, to a token GitHub issued without the Members permission", async () => {
    const lee = await join("lee-acme");
    answerPublicMembersOnly();
    withoutMembersPermission(acme);
    const reading = await startSignIn(install, stub, { sameAppAs: harness });
    expect((await reading.signIn("lee-acme")).response.status).toBe(302);
    expect(await isMember(lee)).toBe(true);
    expect(await removals(lee)).toEqual([]);
  });

  it("admits a person who left and rejoined the organization again, because leaving records no block", async () => {
    const lee = await join("lee-acme");
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    await reconcile();
    expect(await isMember(lee)).toBe(false);
    await stub.addMember("acme", "lee-acme", "member", { delivery: "none" });
    expect(await join("lee-acme")).toBe(lee);
    expect(await roleOf(lee)).toBe("member");
  });
});
