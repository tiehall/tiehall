import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub, type StubInstallation } from "@tiehall/testing/github";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectInstallations,
  emailAdminAlerts,
  knownInstallations,
  openMailer,
  pollGitHub,
  processDelivery,
  readInstallations,
  reconcileGitHub,
  settleModeFromDeliveryLog,
  withOrg,
  type AdminAlertEmailData,
  type Banner,
  type Mailer,
  type WebSessionCaller,
} from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// A broken GitHub installation is surfaced (tracker-mirrors: Broken
// integrations are surfaced; github-app-reachability 1.5 and 1.7;
// github-layer-hardening 1.21). When a connected installation of the
// install's GitHub App is suspended or deleted on GitHub, whether a delivery
// says so or the listing of the App's installations finds it, the web UI shows
// a banner about it to the install's admins and to the members of each team
// whose mirrors go through it, its intake repository being one the
// installation covered, and to no one else; with SMTP set, every admin gets
// one email about it, and without SMTP the banner is the only alert. The
// banner goes once the installation works again. The banner about GitHub's
// webhook, after a given-up delivery, now shows to the members of each team
// whose mirrors go through GitHub too. An App without a webhook, whose
// delivery log GitHub answers with 404, shows no banner and sends no email.
//
// Here FE maps acme/fe-intake, which the acme installation covers, and DATA
// maps acme-labs/data-intake, which the acme-labs installation covers; BE maps
// nothing.

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let acme: StubInstallation;
let labs: StubInstallation;
let ada: WebSessionCaller;
let pia: WebSessionCaller;
let ayse: WebSessionCaller;
let dan: WebSessionCaller;
let alice: WebSessionCaller;

const jobs = { send: async (_tx: unknown, queue: string, data: Record<string, unknown>) => void install.sentJobs.push({ queue, data }) };

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse", "dan"], { repositories: ["acme/fe-intake"] });
  acme = stub.installations(provider.app).find(({ account }) => account.login === "acme")!;
  // A public App installs on other accounts too, such as acme-labs.
  stub.updateApp(provider.app, { public: true });
  stub.addOrg({ login: "acme-labs", members: { "acme-owner": "admin", dan: "member" } });
  stub.addRepo("acme-labs/data-intake");
  labs = await stub.install(provider.app, { account: "acme-labs", repositories: ["acme-labs/data-intake"] }, { delivery: "none" });
  const app = (await provider.github.app())!;
  await readInstallations({ database: install.db, app });
  await withOrg(install.db, async (context) => {
    const known = await knownInstallations(context);
    await connectInstallations(
      context,
      known.filter(({ account: { login } }) => login === "acme-labs").map(({ id }) => id),
    );
  });
  await readInstallations({ database: install.db, app });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  pia = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
  ayse = sessionOf(await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") }));
  dan = sessionOf(await addUser(install.owner, { login: "dan", githubAccountId: provider.account("dan") }));
  alice = sessionOf(await addUser(install.owner, { login: "alice" }));
  for (const [session, email] of [
    [ada, "ada@acme.example"],
    [pia, "pia@acme.example"],
    [ayse, "ayse@acme.example"],
  ] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [session.userId, email]);
  }
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const data = await addTeam(install.owner, "DATA");
  await joinTeams(install.owner, alice.userId, be);
  await joinTeams(install.owner, ayse.userId, fe);
  await joinTeams(install.owner, dan.userId, data);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  await install.execute("mirrors.map_repository", ada, { teamId: data, repository: "acme-labs/data-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(() => {
  install.sentJobs.splice(0);
});

afterEach(async () => {
  // Every installation works again, as GitHub and Tiehall's listing say.
  for (const installation of [acme, labs]) if (installation.suspendedAt !== null) await stub.unsuspend(installation, { delivery: "none" });
  await reconcile();
  await install.owner.query("UPDATE github_app SET mode = 'polling', webhook_given_up_at = NULL");
  install.sentJobs.splice(0);
});

/** One run of the 15-minute reconciliation, which lists the App's installations. */
async function reconcile(): Promise<void> {
  await reconcileGitHub.handle(
    { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github: provider.github, execute: install.execute, jobs },
  );
}

/** One poll of polling mode. */
async function poll(): Promise<void> {
  await pollGitHub.handle(
    { id: randomUUID(), queue: pollGitHub.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github: provider.github, execute: install.execute, jobs },
  );
}

async function bannersOf(session: WebSessionCaller): Promise<Banner[]> {
  return ((await install.execute("install.get_banners", session, {}, { readOnly: true })) as { banners: Banner[] }).banners;
}

/** The ids of the banners the member sees about GitHub. */
async function githubBannersOf(session: WebSessionCaller): Promise<string[]> {
  return (await bannersOf(session)).map(({ id }) => id).filter((id) => id.startsWith("github_"));
}

/** Tiehall's id of the installation on this account that is not deleted. */
async function idOf(login: string): Promise<string> {
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = $1 AND deleted_at IS NULL", [login]);
  return rows[0]!.id;
}

/** The admin alert emails that were started, taken from the jobs sent. */
const alertJobs = () => install.sentJobs.splice(0).filter(({ queue }) => queue === emailAdminAlerts.type.queue);

/** Runs alert email jobs as the worker does, with this mailer. */
async function runAlertJobs(mailer: Mailer, sent: ReturnType<typeof alertJobs>): Promise<void> {
  for (const { data } of sent) {
    await emailAdminAlerts.handle(
      { id: randomUUID(), queue: emailAdminAlerts.type.queue, data: data as AdminAlertEmailData, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), mailer, installUrl: URL_OF_INSTALL },
    );
  }
}

describe("a suspended installation", () => {
  it("shows a banner to the admins and the members of each team whose mirrors go through it, and to no one else", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await reconcile();

    const banner = `github_installation:${await idOf("acme")}`;
    for (const session of [ada, pia, ayse]) expect(await githubBannersOf(session)).toEqual([banner]);
    // A member of DATA, whose mirrors go through acme-labs, and a member of BE, who maps nothing, see nothing.
    for (const session of [dan, alice]) expect(await githubBannersOf(session)).toEqual([]);
    const [admins] = (await bannersOf(ada)).filter(({ id }) => id === banner);
    expect(admins?.text).toContain("acme");
    expect(admins?.text).toContain("suspended");
    expect(admins?.text).toContain("acme/fe-intake");
    expect(admins?.link.href).toBe("/admin/github");
    // A member cannot open the admin page; their banner leads to the members page, which names the admins.
    const [members] = (await bannersOf(ayse)).filter(({ id }) => id === banner);
    expect(members?.link.href).toBe("/members");
  });

  it("is found with no delivery by the next poll in polling mode, within 2 minutes", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await poll();
    expect(await githubBannersOf(ayse)).toEqual([`github_installation:${await idOf("acme")}`]);
  });

  it("is shown at once when a delivery says so, and starts the admins' email", async () => {
    await stub.suspend(acme, { delivery: "none" });
    // The delivery GitHub sends about it, stored as /webhooks/github stores a verified one.
    const deliveryId = randomUUID();
    await install.owner.query("INSERT INTO github_deliveries (org_id, delivery_id, event, payload, enqueued_at) SELECT id, $1, 'installation', $2, now() FROM orgs", [
      deliveryId,
      JSON.stringify({ action: "suspend", installation: { id: acme.id }, sender: { id: 1, login: "acme-owner", type: "User" } }),
    ]);

    await processDelivery({ database: install.db, github: provider.github, execute: install.execute, jobs }, deliveryId);

    expect(await githubBannersOf(ayse)).toEqual([`github_installation:${await idOf("acme")}`]);
    expect(alertJobs().map(({ data }) => (data as AdminAlertEmailData).alert)).toEqual(["github_installation"]);
  });

  it("goes once the installation works again", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await reconcile();
    await stub.unsuspend(acme, { delivery: "none" });
    await reconcile();
    for (const session of [ada, ayse]) expect(await githubBannersOf(session)).toEqual([]);
  });
});

describe("a deleted installation", () => {
  it("shows a banner to the admins and the members of DATA, whose mirrors went through it, and not to a member of FE", async () => {
    const deleted = await idOf("acme-labs");
    await stub.uninstall(labs, { delivery: "none" });
    try {
      await reconcile();
      const banner = `github_installation:${deleted}`;
      for (const session of [ada, dan]) expect(await githubBannersOf(session)).toEqual([banner]);
      for (const session of [ayse, alice]) expect(await githubBannersOf(session)).toEqual([]);
      expect((await bannersOf(ada)).find(({ id }) => id === banner)?.text).toContain("deleted");
    } finally {
      // An admin disconnects the deleted installation, and connects the one made when the App is installed again.
      await install.owner.query("DELETE FROM github_connected_installations WHERE installation_id = $1", [deleted]);
      labs = await stub.install(provider.app, { account: "acme-labs", repositories: ["acme-labs/data-intake"] }, { delivery: "none" });
      await reconcile();
      const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE installation_id = $1", [labs.id]);
      await withOrg(install.db, (context) => connectInstallations(context, [rows[0]!.id]));
      await reconcile();
    }
    expect(await githubBannersOf(ada)).toEqual([]);
  });
});

describe("the admins' email about a broken installation", () => {
  let sink: SmtpSink;
  let mailer: Mailer;

  beforeEach(async () => {
    sink = await startSmtpSink();
    mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
  });

  afterEach(async () => {
    mailer.close();
    await sink.close();
  });

  it("goes to every admin once when SMTP is set, and to no member", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await reconcile();
    const sent = alertJobs();
    expect(sent).toHaveLength(1);

    await runAlertJobs(mailer, sent);
    // A retried job emails nobody twice, and a later run that finds the installation still suspended starts no email.
    await runAlertJobs(mailer, sent);
    await reconcile();
    expect(alertJobs()).toEqual([]);

    expect(sink.messages.map(({ to }) => to[0]).sort()).toEqual(["ada@acme.example", "pia@acme.example"]);
    // The header's folded lines and the text's soft line breaks, joined.
    const message = (sink.messages[0]?.data ?? "").replace(/\r\n[ \t]/g, " ").replace(/=\r\n/g, "");
    expect(message).toContain("Subject: Tiehall: a GitHub installation of the install's App stopped working");
    expect(message).toContain(`${URL_OF_INSTALL}/admin/github`);
    expect(message).toContain("on acme is suspended on GitHub");
  });

  it("is not sent without SMTP settings: the banner is the only alert", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await reconcile();
    await runAlertJobs(openMailer(undefined), alertJobs());
    expect(sink.messages).toEqual([]);
    expect(await githubBannersOf(ada)).toHaveLength(1);
  });

  it("is not sent once the installation works again before the job runs", async () => {
    await stub.suspend(acme, { delivery: "none" });
    await reconcile();
    const sent = alertJobs();
    await stub.unsuspend(acme, { delivery: "none" });
    await reconcile();
    await runAlertJobs(mailer, sent);
    expect(sink.messages).toEqual([]);
  });
});

describe("the banner about GitHub's webhook", () => {
  it("shows to the admins and the members of each team whose mirrors go through GitHub, and to no one else", async () => {
    await install.owner.query("UPDATE github_app SET webhook_given_up_at = now(), mode = 'polling'");
    for (const session of [ada, ayse, dan]) expect(await githubBannersOf(session)).toEqual(["github_webhook"]);
    expect(await githubBannersOf(alice)).toEqual([]);
    expect((await bannersOf(ayse))[0]?.link.href).toBe("/members");
  });
});

describe("an App without a webhook", () => {
  it("shows no banner and sends no email when GitHub answers the request for its delivery log with 404", async () => {
    const from = stub.received.length;
    // Forced: the log is read as the check reads it, although the App has no webhook.
    expect(await settleModeFromDeliveryLog({ database: install.db, app: (await provider.github.app())! })).toBeUndefined();
    expect(stub.received.slice(from).map(({ path, status }) => ({ path, status }))).toEqual([{ path: "/app/hook/deliveries", status: 404 }]);
    for (const session of [ada, ayse, dan]) expect(await githubBannersOf(session)).toEqual([]);
    expect(alertJobs()).toEqual([]);
  });
});
