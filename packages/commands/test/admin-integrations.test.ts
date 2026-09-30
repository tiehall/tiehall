import { randomUUID } from "node:crypto";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import {
  ADMIN_PATH,
  createAdminRoute,
  createHomeRoute,
  emailAdminAlerts,
  emailStatus,
  openMailer,
  readInstallations,
  recordGivenUpDelivery,
  withOrg,
  type Banner,
  type EmailStatus,
  type Mailer,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The integrations' state on the admin page, and the admin banners
// (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// tracker-mirrors: Broken integrations are surfaced; self-host-install:
// Optional email through SMTP; design.md, Decisions this change rests on:
// D28 #41, #83; github-layer-hardening: design.md, Technical decisions: T8).
// The admin page shows how GitHub's changes reach Tiehall, webhook or polling,
// the installations Tiehall acts on, and whether email is set up; only admins
// see it. A problem with an integration is a banner, which the web UI shows to
// the admins, on the admin page and the home page, and to no one else while
// no team's mirrors go through that integration; the given-up GitHub delivery
// is the one such problem built so far, and the fixture here. With SMTP set,
// every admin gets one email about it while its banner shows.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let pia: WebSessionCaller;
let dana: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
  harness = await startSignIn(install, stub, { hook: { url: "http://127.0.0.1:9/webhooks/github" } });
  await stub.install(harness.app, { account: "acme", repositories: ["acme/web", "acme/api"] });
  await harness.connect("acme");
  // The repositories of the connected installation, read as a sync does once it is connected.
  await readInstallations({ database: install.db, app: (await harness.github.app())! });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  pia = sessionOf(await addUser(install.owner, { role: "admin", login: "pia" }));
  dana = sessionOf(await addUser(install.owner, { role: "member", login: "dana" }));
  for (const [session, email] of [
    [ada, "ada@acme.example"],
    [pia, "pia@acme.example"],
    [dana, "dana@acme.example"],
  ] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [session.userId, email]);
  }
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("UPDATE github_app SET mode = 'webhook', webhook_given_up_at = NULL, mode_set_by = 'tiehall'");
  await install.owner.query("UPDATE github_installations SET suspended_at = NULL, deleted_at = NULL");
  install.sentJobs.length = 0;
});

const NO_EMAIL = emailStatus(undefined);
const WITH_EMAIL = emailStatus({ host: "smtp.acme.example", port: 587, tls: "starttls", user: "tiehall-mailer", password: "smtp-secret-canary", from: "Tiehall <tiehall@acme.example>" });

async function adminPage(session: WebSessionCaller, email: EmailStatus = NO_EMAIL): Promise<{ status: number; html: string }> {
  const route = createAdminRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger, email });
  const answer = await route(new Request(`${URL_OF_INSTALL}${ADMIN_PATH}`, { headers: { accept: "text/html" } }));
  return { status: answer.status, html: (await answer.text()).replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))) };
}

async function homePage(session: WebSessionCaller): Promise<string> {
  const route = createHomeRoute({
    session: async () => session,
    secret: () => install.authSecret,
    logger: install.logger,
    banners: async (caller) => ((await install.execute("install.get_banners", caller, {}, { readOnly: true })) as { banners: Banner[] }).banners,
  });
  const answer = await route(new Request(`${URL_OF_INSTALL}/`, { headers: { accept: "text/html" } }));
  expect(answer.status).toBe(200);
  return (await answer.text()).replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** A section of a page, from its heading to the next one. */
function section(html: string, heading: string): string {
  return new RegExp(`<h2>${heading}</h2>([\\s\\S]*?)(?:<h2>|</main>)`).exec(html)?.[1] ?? "";
}

const WEBHOOK_BANNER = "GitHub's webhook deliveries to this install fail";

describe("the admin page's integrations", () => {
  it("shows GitHub's mode, webhook or polling, with the way to switch it", async () => {
    const webhook = section((await adminPage(ada)).html, "GitHub");
    expect(webhook).toContain("GitHub runs in webhook mode");
    expect(webhook).toContain('href="/admin/github"');
    await install.owner.query("UPDATE github_app SET mode = 'polling'");
    expect(section((await adminPage(ada)).html, "GitHub")).toContain("GitHub runs in polling mode");
  });

  it("shows the connected installations, with the repositories they cover, and one that GitHub suspended or deleted", async () => {
    const github = section((await adminPage(ada)).html, "GitHub");
    expect(github).toContain("Connected: acme, the organization, covering 2 repositories.");
    await install.owner.query("UPDATE github_installations SET suspended_at = now()");
    expect(section((await adminPage(ada)).html, "GitHub")).toContain("Connected: acme, the organization, suspended on GitHub: it covers no repository until it is unsuspended.");
    await install.owner.query("UPDATE github_installations SET suspended_at = NULL, deleted_at = now()");
    expect(section((await adminPage(ada)).html, "GitHub")).toContain("Connected: acme, the organization, deleted on GitHub: it covers no repository.");
  });

  it("says that no Jira site is connected", async () => {
    expect(section((await adminPage(ada)).html, "Jira")).toContain("No Jira site is connected.");
  });

  it("shows that email is not set up without SMTP settings, and what then happens to notices", async () => {
    const email = section((await adminPage(ada, NO_EMAIL)).html, "Email");
    expect(email).toContain("Email is not set up");
    expect(email).toContain("notices stay in the web inbox and the admin banners");
  });

  it("shows that email is set up, with its server and from address, and never its login or password", async () => {
    const { html } = await adminPage(ada, WITH_EMAIL);
    const email = section(html, "Email");
    expect(email).toContain("Email is set up: Tiehall sends email through smtp.acme.example, port 587 with STARTTLS, from Tiehall <tiehall@acme.example>.");
    expect(html).not.toContain("tiehall-mailer");
    expect(html).not.toContain("smtp-secret-canary");
  });

  it("is an admin's: a member gets 403, and the answer shows no state", async () => {
    const { status, html } = await adminPage(dana, WITH_EMAIL);
    expect(status).toBe(403);
    for (const text of ["webhook mode", "acme", "smtp.acme.example", "backup"]) expect(html).not.toContain(text);
  });

  it("reads the banners through an operation no agent surface offers", async () => {
    await expect(install.execute("install.get_banners", tokenOf(ada.userId), {})).rejects.toMatchObject({ reason: "route-not-found" });
  });
});

describe("the admin banners", () => {
  it("show nothing while every integration works", async () => {
    expect((await adminPage(ada)).html).not.toContain(WEBHOOK_BANNER);
    expect(await homePage(ada)).not.toContain(WEBHOOK_BANNER);
  });

  it("show a given-up GitHub delivery to every admin, on the admin page and the home page, and to no member", async () => {
    // The fixture: the redelivery job gave a delivery up.
    await install.owner.query("UPDATE github_app SET webhook_given_up_at = now()");
    for (const admin of [ada, pia]) {
      const admins = (await adminPage(admin)).html;
      expect(admins).toContain(WEBHOOK_BANNER);
      expect(admins).toContain('<a href="/admin/github">');
      expect(await homePage(admin)).toContain(WEBHOOK_BANNER);
    }
    expect(await homePage(dana)).not.toContain(WEBHOOK_BANNER);
    const banners = (await install.execute("install.get_banners", dana, {}, { readOnly: true })) as { banners: unknown[] };
    expect(banners.banners).toEqual([]);
  });

  it("say when the given-up delivery moved GitHub to polling mode, and go once the give-up is cleared", async () => {
    await install.owner.query("UPDATE github_app SET webhook_given_up_at = now(), mode = 'polling'");
    expect((await adminPage(ada)).html).toContain("GitHub now runs in polling mode");
    // An admin's switch of the mode, or a verified delivery, clears the give-up (github-mode.ts, github-webhooks.ts).
    await install.owner.query("UPDATE github_app SET webhook_given_up_at = NULL");
    expect((await adminPage(ada)).html).not.toContain(WEBHOOK_BANNER);
    expect(await homePage(ada)).not.toContain(WEBHOOK_BANNER);
  });
});

describe("the admins' email about a given-up GitHub delivery", () => {
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

  /** Records a given-up delivery of the App in use, as the redelivery job does, with the jobs it starts. */
  async function giveUp(): Promise<void> {
    const appId = Number((await install.owner.query<{ app_id: string }>("SELECT app_id FROM github_app")).rows[0]?.app_id);
    await withOrg(install.db, (context) =>
      recordGivenUpDelivery(context, { send: async (_tx, queue, data) => void install.sentJobs.push({ queue, data }) }, appId),
    );
  }

  /** The alert emails the give-ups started, taken from the jobs the install's writes sent. */
  const alertJobs = () => install.sentJobs.splice(0).filter(({ queue }) => queue === emailAdminAlerts.type.queue);

  /** Runs the alert emails the give-ups started, or these jobs, as the worker does, with this mailer. */
  async function runAlertJobs(with_: Mailer = mailer, jobs = alertJobs()): Promise<number> {
    for (const { data } of jobs) {
      await emailAdminAlerts.handle(
        { id: randomUUID(), queue: emailAdminAlerts.type.queue, data: data as { alert: "github_webhook"; raisedAt: string }, signal: new AbortController().signal },
        { database: install.db, now: () => new Date(), mailer: with_, installUrl: URL_OF_INSTALL },
      );
    }
    return jobs.length;
  }

  it("goes to every admin once, and not again for later give-ups while the banner shows", async () => {
    await giveUp();
    const jobs = alertJobs();
    expect(await runAlertJobs(mailer, jobs)).toBe(1);
    expect(sink.messages.map(({ to }) => to[0]).sort()).toEqual(["ada@acme.example", "pia@acme.example"]);
    const [message] = sink.messages;
    expect(message?.data).toContain("Subject: Tiehall: GitHub's webhook deliveries to the install fail");
    expect(message?.data).toContain(`${URL_OF_INSTALL}/admin/github`);

    // A later give-up while the banner shows starts no email, and a retried job sends none twice.
    await giveUp();
    expect(await runAlertJobs()).toBe(0);
    await runAlertJobs(mailer, jobs);
    expect(sink.messages).toHaveLength(2);
  });

  it("is sent again only for a later give-up, once the banner went and came back", async () => {
    await giveUp();
    await runAlertJobs();
    await install.owner.query("UPDATE github_app SET webhook_given_up_at = NULL");
    await giveUp();
    expect(await runAlertJobs()).toBe(1);
    expect(sink.messages).toHaveLength(4);
  });

  it("is not sent without SMTP settings: the banner is the only alert", async () => {
    await giveUp();
    expect(await runAlertJobs(openMailer(undefined))).toBe(1);
    expect(sink.messages).toEqual([]);
    expect((await adminPage(ada)).html).toContain(WEBHOOK_BANNER);
  });

  it("is not sent once the banner has gone before the job runs", async () => {
    await giveUp();
    await install.owner.query("UPDATE github_app SET webhook_given_up_at = NULL");
    await runAlertJobs();
    expect(sink.messages).toEqual([]);
  });
});
