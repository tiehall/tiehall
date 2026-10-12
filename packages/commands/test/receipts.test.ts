import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { applyChangeSets, emailReceipts, expireProposals, openMailer, type Banner, type CiCaller, type Mailer, type WebSessionCaller } from "../src/index.ts";
import { hiddenField, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { addInstallation } from "./support/apis.ts";
import { changesOf, reportOf } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// Receipts (requests: Receipts; requester-loop: The web inbox; design.md,
// Decisions this change rests on: D23, D28 #61, D30 (4); design.md,
// Self-hosting decisions: S7 and S10). After every confirmation, the person who
// gave it gets a receipt that states, in Tiehall's own words, what they
// confirmed: in the standing list of their web inbox and, with SMTP set, by
// email. For a commitment that needs each side, the accountable human's
// receipt says it waits for the other side, and when the other side's
// confirmation makes it take effect, both people get a receipt that says so.
// If it ends without taking effect instead, the accountable human's receipt
// shows how. Receipt emails are transactional: turning off the daily digest
// does not stop them. Every other action the confirmation step guards, each
// of tools/repo-checks/confirmation-actions.json, gives the person who
// confirmed it a receipt too, in the review page's own words, and no receipt
// holds a secret, a key or a token's value (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (81); Technical decisions:
// T11).

let install: TestInstall;
let clock = new Date("2026-10-01T09:00:00Z");
let sink: SmtpSink;
let mailer: Mailer;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall({ now: () => clock });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
  for (const [id, login] of [[alice, "alice"], [bob, "bob"]] as const) {
    await install.owner.query("UPDATE users SET email = $2 WHERE id = $1", [id, `${login}@acme.example`]);
  }
});

beforeEach(async () => {
  sink = await startSmtpSink();
  mailer = openMailer({ host: "127.0.0.1", port: sink.port, tls: "none", from: "Tiehall <tiehall@acme.example>" });
});

afterEach(async () => {
  mailer.close();
  await sink.close();
});

afterAll(async () => {
  await install.close();
});

/** The receipts in the standing list of the user's web inbox about one request, oldest first. */
async function receiptsOf(user: string, key: string): Promise<string[]> {
  const result = await install.web(sessionOf(user)).read<{ receipts: { text: string; proposal: { request: { key: string } } }[] }>("inbox.standing_list", {});
  if (!result.ok) throw new Error(`inbox.standing_list answered ${result.problem.status}`);
  return result.output.receipts.filter((receipt) => receipt.proposal.request.key === key).map(({ text }) => text);
}

async function sendReceipts(with_ = mailer): Promise<void> {
  await emailReceipts.handle(
    { id: "receipts", queue: emailReceipts.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => clock, mailer: with_, installUrl: URL_OF_INSTALL },
  );
}

/** The receipt emails sent about a request: to whom, and the receipt's sentence each holds. */
function receiptEmails(key: string) {
  return sink.messages
    .map(({ to, data }) => ({ to: to.join(","), data: data.replace(/=\r\n/g, "").replace(/\r\n/g, "\n") }))
    .filter(({ data }) => data.includes(`Subject: Tiehall: receipt for your confirmation on ${key}`))
    .map(({ to, data }) => ({ to, text: data.slice(data.indexOf("\n\n") + 2).split("\n")[0] ?? "" }));
}

const confirm = (user: string, proposal: string) => install.confirm(sessionOf(user), "proposals.confirm", { proposal });

async function dueDateProposal() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  const answer = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
    body: { packet: { ...packetOf(), due_date: "2026-10-15" } },
    headers: { "if-match": '"1"' },
  });
  return { key: request.key as string, proposal: answer.body.proposal.id as string };
}

describe("a receipt", () => {
  it("follows a decline's confirmation, in the web inbox and by email", async () => {
    clock = new Date("2026-10-01T09:00:00Z");
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(200);
    const sentence = `${request.key} was declined, with your confirmation.`;
    expect(await receiptsOf(bob, request.key)).toEqual([sentence]);
    await sendReceipts();
    expect(receiptEmails(request.key)).toEqual([{ to: "bob@acme.example", text: sentence }]);
    // It links the decline's undo page, for the 15 minutes it can be undone.
    const email = (sink.messages.at(-1)?.data ?? "").replace(/=\r\n/g, "");
    expect(email).toContain(`You can undo it until 2026-10-01T09:15:00.000Z on its undo page: ${URL_OF_INSTALL}/confirm/${proposal}/undo`);
    await sendReceipts();
    expect(receiptEmails(request.key)).toHaveLength(1);
  });

  it("is listed without SMTP, and no email is sent", async () => {
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(200);
    await sendReceipts(openMailer(undefined));
    expect(sink.connections).toBe(0);
    expect(await receiptsOf(bob, request.key)).toEqual([`${request.key} was declined, with your confirmation.`]);
  });

  it("goes to each side for a two-sided due date, and a final one to both when it takes effect", async () => {
    clock = new Date("2026-10-03T09:00:00Z");
    const { key, proposal } = await dueDateProposal();
    clock = new Date("2026-10-03T10:00:00Z");
    expect((await confirm(alice, proposal)).status).toBe(200);
    const waits = `You confirmed setting the due date of ${key} to 2026-10-15; it waits for a confirmation from the other side of the request.`;
    expect(await receiptsOf(alice, key)).toEqual([waits]);
    clock = new Date("2026-10-03T11:00:00Z");
    expect((await confirm(bob, proposal)).status).toBe(200);
    const tookEffect = `The due date of ${key} was set to 2026-10-15, with your confirmation.`;
    expect(await receiptsOf(alice, key)).toEqual([`${waits} The other side confirmed it too.`, tookEffect]);
    expect(await receiptsOf(bob, key)).toEqual([tookEffect]);
    await sendReceipts();
    expect(receiptEmails(key).sort((a, b) => a.to.localeCompare(b.to) || a.text.localeCompare(b.text))).toEqual([
      { to: "alice@acme.example", text: tookEffect },
      // Emailed once Bob had confirmed too, its words say so.
      { to: "alice@acme.example", text: `${waits} The other side confirmed it too.` },
      { to: "bob@acme.example", text: tookEffect },
    ]);
  });

  it("shows that the other side never confirmed once the proposal expired", async () => {
    clock = new Date("2026-10-01T09:00:00Z");
    const { key, proposal } = await dueDateProposal();
    clock = new Date("2026-10-02T09:00:00Z");
    expect((await confirm(alice, proposal)).status).toBe(200);
    await expireProposals.handle(
      { id: "expire", queue: expireProposals.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date("2026-10-08T09:00:00Z") },
    );
    expect(await receiptsOf(alice, key)).toEqual([
      `You confirmed setting the due date of ${key} to 2026-10-15; it waits for a confirmation from the other side of the request. It expired before the other side confirmed it, so it did not take effect.`,
    ]);
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet`)).body.packet.due_date).toBeUndefined();
  });

  it("is emailed to a person who turned off the daily digest", async () => {
    await install.owner.query("UPDATE users SET digest_enabled = false WHERE id = $1", [bob]);
    const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    const proposal = (await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" })).body.proposal.id;
    expect((await confirm(bob, proposal)).status).toBe(200);
    await sendReceipts();
    expect(receiptEmails(request.key)).toEqual([{ to: "bob@acme.example", text: `${request.key} was declined, with your confirmation.` }]);
  });
});

describe("every confirmation", () => {
  /** The actions of the committed list that a task has built, by their confirm commands. */
  const BUILT: readonly string[] = (
    JSON.parse(readFileSync(new URL("../../../tools/repo-checks/confirmation-actions.json", import.meta.url), "utf8")) as {
      items: { actions: { command?: string }[] }[];
    }
  ).items.flatMap(({ actions }) => actions.flatMap(({ command }) => (command === undefined ? [] : [command])));

  let harness: AgentAccessHarness;
  /** An admin, who confirms every action. */
  let pia: SignedIn;
  let piaSession: WebSessionCaller;
  let alice: string;
  let lee: string;
  let sam: string;
  let newcomer: number;
  let fe: string;
  let pay: string;
  let unconnected: string;
  let payAccount: number;
  /** The decline Pia confirmed, which the undo then undoes. */
  let decline: { key: string; proposal: string };
  /** The values no receipt may hold: a token's, the webhook secret, a private key. */
  const secrets: string[] = [];
  const confirmed: string[] = [];

  beforeAll(async () => {
    harness = await startAgentAccess();
    const { install, stub, signIn } = harness;
    pia = await harness.member("pia-admin");
    piaSession = sessionOf(pia.userId);
    await install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [pia.userId]);
    await install.owner.query("UPDATE users SET email = 'pia@acme.example' WHERE id = $1", [pia.userId]);
    alice = await addUser(install.owner, { login: "alice-be" });
    lee = await addUser(install.owner, { login: "lee-dev" });
    sam = await addUser(install.owner, { login: "sam-dev" });
    const be = await addTeam(install.owner, "BE");
    fe = await addTeam(install.owner, "FE");
    pay = await addTeam(install.owner, "PAY");
    await joinTeams(install.owner, alice, be);
    await joinTeams(install.owner, pia.userId, fe);
    // GitHub: the App installed on acme and connected, through which an invite reads the account it names.
    newcomer = stub.addUser({ login: "newcomer-dev" }).id;
    await stub.addMember("acme", "pia-admin", "admin");
    await stub.install(signIn.app, { account: "acme" });
    await signIn.connect("acme");
    install.useGitHub(signIn.github);
    // An installation listed and not connected yet, and a connected one that covers the payments repository.
    const { rows: listed } = await install.owner.query<{ id: string }>(
      `INSERT INTO github_installations (org_id, app_id, installation_id, account_id, account_login, account_type, repository_selection)
         SELECT id, $1, 880001, 880002, 'acme-labs', 'Organization', 'selected' FROM orgs RETURNING id`,
      [signIn.app.id],
    );
    unconnected = listed[0]?.id ?? "";
    payAccount = (await addInstallation(install.owner, { account: "acme-pay", repositories: [{ fullName: "acme-pay/payments", id: 7101 }] })).accountId;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  /** Pia's receipts, oldest first, as the standing list of their web inbox lists them. */
  async function receiptsOfPia(): Promise<{ kind: string; text: string; action: string | null }[]> {
    const result = await harness.install.web(piaSession).read<{ receipts: { kind: string; text: string; action: { id: string } | null }[] }>("inbox.standing_list", {});
    if (!result.ok) throw new Error(`inbox.standing_list answered ${result.problem.status}`);
    return result.output.receipts.map(({ kind, text, action }) => ({ kind, text, action: action?.id ?? null }));
  }

  /** Confirms an action as Pia does on its review page, and fails the test unless it is applied. */
  async function confirmAs(command: string, input: unknown, entered: Record<string, string> = {}): Promise<void> {
    const answer = await harness.install.confirm(piaSession, command, input, {}, entered);
    expect(answer.status, await answer.clone().text()).toBe(200);
  }

  interface Case {
    command: string;
    /** Confirms the action, as the person does in the web UI. */
    run(): Promise<void>;
    /** What the receipt says, or the start of it. */
    says(): string;
  }

  const cases: Case[] = [
    {
      command: "proposals.confirm",
      async run() {
        const request = await openRequest(harness.install, tokenOf(alice), { targetTeam: "FE" });
        const proposed = await callApi(harness.install, tokenOf(pia.userId), "POST", `/api/v1/requests/${request.key}/status`, { state: "declined" });
        decline = { key: request.key, proposal: proposed.body.proposal.id };
        await confirmAs("proposals.confirm", { proposal: decline.proposal });
      },
      says: () => `${decline.key} was declined, with your confirmation.`,
    },
    {
      command: "proposals.undo",
      run: () => confirmAs("proposals.undo", { proposal: decline.proposal }),
      says: () => `The decline of ${decline.key} was undone by pia-admin.`,
    },
    {
      command: "members.change_role",
      run: () => confirmAs("members.change_role", { userId: lee, role: "admin" }),
      says: () => "You confirmed: Change a member's role. Its review page said: Change the role of the member lee-dev from member to admin.",
    },
    {
      command: "members.remove",
      run: () => confirmAs("members.remove", { userId: sam }),
      says: () => "You confirmed: Remove a member. Its review page said: Remove the member sam-dev, whose role is member, from the install.",
    },
    {
      command: "invites.create",
      run: () => confirmAs("invites.create", { accountId: newcomer, role: "member" }),
      says: () => "You confirmed: Invite a person. Its review page said: Invite the GitHub account newcomer-dev to the install, with the role member.",
    },
    {
      command: "settings.set_sign_in_policy",
      run: () => confirmAs("settings.set_sign_in_policy", { policy: "invited_only" }),
      says: () => "You confirmed: Change the sign-in policy.",
    },
    {
      command: "github.connect_installation",
      run: () => confirmAs("github.connect_installation", { installation: unconnected }),
      says: () => "You confirmed: Connect a GitHub installation. Its review page said: Connect the install's GitHub App installation on the GitHub organization acme-labs",
    },
    {
      command: "github.upload_private_key",
      async run() {
        const key = harness.stub.addPrivateKey(harness.signIn.app);
        secrets.push(key, ...key.split("\n").filter((line) => line.length > 40));
        await confirmAs("github.upload_private_key", {}, { privateKey: key });
      },
      says: () => "You confirmed: Upload a new private key for the GitHub App.",
    },
    {
      command: "github.store_webhook_secret",
      async run() {
        const secret = `whsec-canary-${randomUUID()}`;
        secrets.push(secret);
        await confirmAs("github.store_webhook_secret", {}, { secret });
      },
      says: () => "You confirmed: Store the GitHub App's webhook secret.",
    },
    {
      command: "apis.register",
      run: () => confirmAs("apis.register", { name: "payments-api", team: pay, repository: "acme-pay/payments" }),
      says: () => "You confirmed: Register an API. Its review page said: Register the API payments-api for the team PAY, bound to the GitHub repository acme-pay/payments.",
    },
    {
      command: "personal_access_tokens.create",
      async run() {
        secrets.push(await harness.personalAccessToken(pia, { name: "Release script", expiresInDays: 30 }));
      },
      says: () => "You confirmed: Create a personal access token.",
    },
    {
      command: "settings.set_personal_access_token_max_lifetime",
      run: () => confirmAs("settings.set_personal_access_token_max_lifetime", { maxLifetimeDays: 30 }),
      says: () => "You confirmed: Change the longest lifetime of personal access tokens.",
    },
    {
      command: "settings.set_personal_access_tokens",
      run: () => confirmAs("settings.set_personal_access_tokens", { on: false }),
      says: () => "You confirmed: Switch personal access tokens off. Its review page said: Switch personal access tokens off for the install.",
    },
    {
      command: "settings.set_write_budget",
      run: () => confirmAs("settings.set_write_budget", { dailyWriteBudget: 8000 }),
      says: () => "You confirmed: Change the daily write budget.",
    },
    {
      command: "agent_clients.approve",
      async run() {
        const client = await harness.registerClient();
        const started = await harness.authorize(pia.cookie, client, pkcePair());
        const consent = new URL(started.headers.get("location") ?? "", URL_OF_INSTALL);
        const html = await (await harness.handle(new Request(consent, { headers: { cookie: pia.cookie, accept: "text/html" } }))).text();
        const approved = await harness.handle(
          new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve`, {
            method: "POST",
            headers: { cookie: pia.cookie, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", accept: "text/html" },
            body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
          }),
        );
        expect(approved.status).toBe(303);
      },
      says: () => "You confirmed: Approve an agent client.",
    },
    {
      command: "agent_clients.approve_device",
      async run() {
        const { accessToken, refreshToken } = await harness.signInCli(pia);
        secrets.push(accessToken, refreshToken);
      },
      says: () => "You confirmed: Sign in the tiehall CLI.",
    },
    {
      command: "contract.confirm_fan_out",
      async run() {
        const { install } = harness;
        // payments-api has 11 consumer teams: the report opens requests to 10 of them, and the 11th waits for an admin.
        for (const key of ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11"]) {
          const team = await addTeam(install.owner, key);
          await install.owner.query(
            `INSERT INTO api_consumers (org_id, api_id, team_id, declared_by, declared_at, last_confirmed_at)
               SELECT apis.org_id, apis.id, $1, $2, now(), now() FROM apis WHERE apis.name = 'payments-api'`,
            [team, pia.userId],
          );
        }
        const ci: CiCaller = {
          kind: "ci",
          repositoryId: "7101",
          repositoryOwnerId: String(payAccount),
          jobWorkflowRef: "acme-pay/payments/.github/workflows/contract.yml@refs/heads/main",
        };
        await install.execute("contract.report", ci, reportOf("payments-api", changesOf("breaking"), { pullRequest: 900 }));
        // Its burst ended 3 minutes ago, so the worker applies it now.
        const { rows: reported } = await install.owner.query<{ id: string }>(
          "UPDATE contract_change_sets SET burst_started_at = now() - interval '3 minutes' WHERE pull_request_number = 900 RETURNING id",
        );
        await install.owner.query("UPDATE contract_reports SET received_at = now() - interval '3 minutes' WHERE pull_request_number = 900");
        install.sentJobs.splice(0);
        await applyChangeSets.handle(
          { id: randomUUID(), queue: applyChangeSets.type.queue, data: { changeSetId: reported[0]?.id ?? "" }, signal: new AbortController().signal },
          { database: install.db, now: () => new Date(), execute: install.execute },
        );
        const { banners } = (await install.execute("install.get_banners", piaSession, {}, { readOnly: true })) as { banners: Banner[] };
        const link = banners.find(({ id }) => id === "contract_fan_out")?.link.href ?? "";
        await confirmAs("contract.confirm_fan_out", JSON.parse(new URL(link, URL_OF_INSTALL).searchParams.get("input") ?? "{}"));
      },
      says: () => "You confirmed: Confirm a contract-change fan-out.",
    },
    {
      command: "activity_log.export",
      run: () => confirmAs("activity_log.export", {}),
      says: () => "You confirmed: Export the activity log.",
    },
  ];

  it.each(cases.map((each) => [each.command, each] as const))("%s gives the person who confirmed it one receipt, in Tiehall's words", async (command, each) => {
    const before = (await receiptsOfPia()).length;

    await each.run();
    confirmed.push(command);

    const added = (await receiptsOfPia()).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.text.startsWith(each.says()), added[0]!.text).toBe(true);
    // A receipt of an action names the action; a proposal's names its proposal, as before.
    expect(added[0]!.action).toBe(command.startsWith("proposals.") ? null : command);
  }, 60_000);

  it("covers each action of the committed list of actions the confirmation step guards", () => {
    expect([...confirmed].sort()).toEqual([...BUILT].sort());
  });

  it("emails each receipt with SMTP set, and none holds a secret, a key or a token's value", async () => {
    const receipts = await receiptsOfPia();
    expect(receipts).toHaveLength(BUILT.length);
    await emailReceipts.handle(
      { id: "receipts", queue: emailReceipts.type.queue, data: {}, signal: new AbortController().signal },
      { database: harness.install.db, now: () => new Date(), mailer, installUrl: URL_OF_INSTALL },
    );
    const toPia = sink.messages.filter(({ to }) => to.includes("pia@acme.example")).map(({ data }) => data.replace(/=\r\n/g, "").replace(/\r\n/g, "\n"));
    expect(toPia).toHaveLength(receipts.length);
    for (const { text } of receipts) expect(toPia.some((email) => email.replace(/\n/g, " ").includes(text.slice(0, 60))), text).toBe(true);
    expect(secrets.length).toBeGreaterThan(4);
    for (const secret of secrets) {
      for (const { text } of receipts) expect(text).not.toContain(secret);
      for (const email of toPia) expect(email.replace(/\n/g, "")).not.toContain(secret);
    }
    for (const text of [...receipts.map(({ text }) => text), ...toPia]) expect(text).not.toContain("PRIVATE KEY");
  });
});
