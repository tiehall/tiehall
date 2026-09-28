import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted, Refusal } from "@tiehall/core";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  connectInstallations,
  createExecute,
  knownInstallations,
  processDelivery,
  processGitHubDelivery,
  readInstallations,
  withOrg,
  type GitHubEventContext,
  type GitHubEventProcessors,
  type Handlers,
  type IntegrationEventCaller,
  type InstallGitHub,
} from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { storeDelivery, storeStubApp } from "./support/github-app.ts";

// Processing GitHub's deliveries in the worker (agent-access: Six kinds of
// caller; tracker-mirrors: Admins connect GitHub installations with the
// confirmation step; tracker-mirrors: GitHub webhooks are verified,
// deduplicated and processed in the background; github-app-reachability:
// design.md, Design rules: Finding installations). A stored delivery is
// processed through the table of connected installations: one from an
// installation that no admin connected changes nothing, and one from a
// connected installation goes to the processor of its event, which runs its
// changes as the integration-event caller, acting for the Tiehall user of the
// delivery's sender if there is one; that caller runs only internal commands.
// A delivery about an installation makes Tiehall list the App's installations
// at once, whatever the installation, so the admin page's list follows it.

let install: TestInstall;
let stub: GitHubStub;
let app: StubApp;
let github: InstallGitHub;
let omarUserId: string;

beforeAll(async () => {
  install = await startTestInstall();
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  stub = await startGitHubStub();
  const omar = stub.addUser({ login: "omar" });
  stub.addUser({ login: "kim" });
  stub.addOrg({ login: "acme", members: { omar: "admin", kim: "member" } });
  stub.addRepo("acme/web");
  // GitHub cannot reach the install here: each delivery is logged, with what GitHub sent, and stored by the test.
  app = stub.createApp({ owner: "acme", hook: { url: "https://tiehall.example.com/webhooks/github" } });
  ({ github } = await storeStubApp(install, stub, app));
  omarUserId = await addUser(install.owner, { login: "omar", githubAccountId: omar.id });
});

afterEach(async () => {
  await stub.close();
  await install.owner.query(
    `DELETE FROM github_deliveries; DELETE FROM github_covered_repositories; DELETE FROM github_connected_installations;
     DELETE FROM github_installations; DELETE FROM integration_secrets; DELETE FROM github_app;
     DELETE FROM members; DELETE FROM sign_in_accounts; DELETE FROM users`,
  );
});

/** Lists the App's installations, as a sync does, and connects the one on this account. */
async function connect(account: string): Promise<void> {
  await readInstallations({ database: install.db, app: (await github.app())! });
  await withOrg(install.db, async (context) => {
    const known = await knownInstallations(context);
    await connectInstallations(
      context,
      known.filter(({ account: { login } }) => login === account).map(({ id }) => id),
    );
  });
}

/** A pull request opened by this GitHub user on acme/web, as GitHub delivers it; the delivery is stored. */
async function pullRequestOpenedBy(login: string): Promise<string> {
  const pr = await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fe-142-header", author: login });
  const [delivery] = stub.deliveries(app).filter(({ event, request }) => event === "pull_request" && (request.payload as { number?: number }).number === pr.number);
  return storeDelivery(install, delivery!);
}

async function processed(deliveryId: string): Promise<boolean> {
  const { rows } = await install.owner.query<{ processed: boolean }>("SELECT processed_at IS NOT NULL AS processed FROM github_deliveries WHERE delivery_id = $1", [deliveryId]);
  return rows[0]?.processed ?? false;
}

/** A processor of pull_request events that records what it was handed. */
function recording(): { processors: GitHubEventProcessors; handed: { event: string; installationId: number; caller: IntegrationEventCaller }[] } {
  const handed: { event: string; installationId: number; caller: IntegrationEventCaller }[] = [];
  return {
    handed,
    processors: {
      pull_request: async (event, context) => {
        handed.push({ event: event.event, installationId: event.installation.installationId, caller: context.caller });
      },
    },
  };
}

describe("a delivery from an installation", () => {
  it("changes nothing when no admin connected the installation, and is recorded as processed", async () => {
    await stub.install(app, { account: "acme" });
    const { processors, handed } = recording();
    const deliveryId = await pullRequestOpenedBy("omar");

    await processDelivery({ database: install.db, github, execute: install.execute, processors }, deliveryId);

    expect(handed).toEqual([]);
    expect(await processed(deliveryId)).toBe(true);
    expect((await install.owner.query("SELECT count(*)::int AS events FROM events")).rows).toEqual([{ events: 0 }]);
  });

  it("goes to its event's processor when the installation is connected, as the integration-event caller acting for the sender's Tiehall user", async () => {
    const installation = await stub.install(app, { account: "acme" });
    await connect("acme");
    const { processors, handed } = recording();

    await processDelivery({ database: install.db, github, execute: install.execute, processors }, await pullRequestOpenedBy("omar"));
    await processDelivery({ database: install.db, github, execute: install.execute, processors }, await pullRequestOpenedBy("kim"));

    expect(handed).toEqual([
      { event: "pull_request", installationId: installation.id, caller: { kind: "integration_event", source: "github", userId: omarUserId } },
      // Kim has no Tiehall user: the caller acts for no user.
      { event: "pull_request", installationId: installation.id, caller: { kind: "integration_event", source: "github" } },
    ]);
  });

  it("is processed once: a job that runs again after it was processed does nothing", async () => {
    await stub.install(app, { account: "acme" });
    await connect("acme");
    const { processors, handed } = recording();
    const deliveryId = await pullRequestOpenedBy("omar");

    await processDelivery({ database: install.db, github, execute: install.execute, processors }, deliveryId);
    await processDelivery({ database: install.db, github, execute: install.execute, processors }, deliveryId);

    expect(handed).toHaveLength(1);
  });
});

describe("the integration-event caller", () => {
  const catalog = defineCatalog([
    defineCommand({
      id: "probes.internal",
      summary: "An internal command, which no surface offers.",
      input: z.object({}),
      output: z.object({}),
      scopes: [],
      commitment: false,
      confirm: false,
      surfaces: [],
      stability: "alpha",
    }),
    defineCommand({
      id: "probes.offered",
      summary: "A command offered on REST.",
      input: z.object({}),
      output: z.object({}),
      scopes: ["requests:write"],
      method: "POST",
      path: "/api/v1/probes",
      commitment: false,
      confirm: false,
      surfaces: ["rest"],
      stability: "alpha",
    }),
  ]);
  const record: Handlers[string] = async (_input, context) =>
    context.write(async (writer) => {
      await writer.record(messagePosted, { requestId: randomUUID(), messageId: randomUUID() });
      return {};
    });

  it("runs only internal commands, and what it runs is recorded as an integration from GitHub, for the mapped user", async () => {
    await stub.install(app, { account: "acme" });
    await connect("acme");
    const execute = createExecute({ catalog, handlers: { "probes.internal": record, "probes.offered": record }, store: { database: install.db, jobs: { send: async () => {} } } });
    const outcomes: unknown[] = [];
    const processors: GitHubEventProcessors = {
      pull_request: async (_event, context: GitHubEventContext) => {
        outcomes.push(await context.run("probes.offered", {}).catch((error: unknown) => (error instanceof Refusal ? error.reason : error)));
        outcomes.push(await context.run("probes.internal", {}));
      },
    };

    await processDelivery({ database: install.db, github, execute, processors }, await pullRequestOpenedBy("omar"));

    expect(outcomes).toEqual(["forbidden", {}]);
    const { rows } = await install.owner.query("SELECT type, actor_kind, actor_user_id, surface FROM events");
    expect(rows).toEqual([{ type: "request.message_posted", actor_kind: "integration", actor_user_id: omarUserId, surface: "github" }]);
  });
});

describe("a delivery about an installation (github-app-reachability 1.5)", () => {
  it("makes Tiehall list the App's installations at once, whether or not the installation is connected", async () => {
    const installation = await stub.install(app, { account: "acme" });
    const [delivery] = stub.deliveries(app).filter(({ event }) => event === "installation");
    const deliveryId = await storeDelivery(install, delivery!);
    const listingsBefore = stub.received.filter(({ path }) => path === "/app/installations").length;

    await processGitHubDelivery.handle(
      { id: randomUUID(), queue: processGitHubDelivery.type.queue, data: { deliveryId }, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github, execute: install.execute },
    );

    expect(stub.received.filter(({ path }) => path === "/app/installations").length).toBe(listingsBefore + 1);
    const known = await withOrg(install.db, (context) => knownInstallations(context));
    expect(known.map(({ installationId, connected }) => ({ installationId, connected }))).toEqual([{ installationId: installation.id, connected: false }]);
    expect(await processed(deliveryId)).toBe(true);
  });
});
