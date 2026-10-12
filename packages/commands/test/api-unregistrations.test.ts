import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumersOf, createApisRoute, reportableApi, withOrg, type CiCaller, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Admins unregister APIs (contract-changes: Admins unregister APIs;
// teams-and-roles: What admins and members may do; activity-log: Which
// actions are security events; design.md, Self-hosting decisions: S6 and S14;
// design.md, Readings to confirm with the founder: R19). An admin unregisters
// an API from the APIs page of the admin UI with no confirmation step,
// because that only stops its reports: from then on a report for it from the
// repository it was bound to is refused with 403, as one for an API that is
// not registered to the caller's repository is. The requests that name it
// stay as they are. A member's attempt gets 403 and changes nothing. Each
// unregistration is a security event. Registering the API again is how its
// provider team, repository or workflow changes: registered again with the
// same repository and provider team, it keeps the teams' declarations that
// they consume it; with another repository or another provider team, it is a
// new API, to which none of them carries over (decisions-from-groups-15-28,
// D55 (56)).

let install: TestInstall;
let ada: WebSessionCaller;
let dana: WebSessionCaller;
let danaId: string;
/** Ayşe, a member of FE, which consumes payments-api. */
let ayse: WebSessionCaller;
let pay: string;
let fe: string;
let acmeId: number;

/** A CI run in acme/payments, as its GitHub Actions OIDC token names it. */
const paymentsRun = (): CiCaller => ({
  kind: "ci",
  repositoryId: "7001",
  repositoryOwnerId: String(acmeId),
  jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main",
});

beforeAll(async () => {
  install = await startTestInstall();
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  danaId = await addUser(install.owner, { role: "member", login: "dana" });
  dana = sessionOf(danaId);
  pay = await addTeam(install.owner, "PAY");
  fe = await addTeam(install.owner, "FE");
  await joinTeams(install.owner, danaId, pay);
  const ayseId = await addUser(install.owner, { role: "member", login: "ayse" });
  ayse = sessionOf(ayseId);
  await joinTeams(install.owner, ayseId, fe);
  ({ accountId: acmeId } = await addInstallation(install.owner, {
    account: "acme",
    repositories: [
      { fullName: "acme/payments", id: 7001 },
      { fullName: "acme/web", id: 7002 },
    ],
  }));
}, 60_000);

afterAll(async () => {
  await install?.close();
});

let paymentsApi: string;

beforeEach(async () => {
  await install.owner.query("DELETE FROM api_consumers");
  await install.owner.query("DELETE FROM apis");
  expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'");
  paymentsApi = rows[0]?.id ?? "";
});

/** The last event's number. */
async function lastEvent(): Promise<number> {
  const { rows } = await install.owner.query("SELECT coalesce(max(number), 0)::int AS n FROM events");
  return rows[0].n;
}

/** The events after that number. */
async function eventsSince(number: number): Promise<Record<string, unknown>[]> {
  const { rows } = await install.owner.query("SELECT type, class, actor_kind, actor_user_id, data FROM events WHERE number > $1 ORDER BY number", [number]);
  return rows;
}

/** The names of the registered APIs, as the APIs page lists them for an admin. */
async function listed(): Promise<string[]> {
  const { apis } = (await install.execute("apis.list", ada, {}, { readOnly: true })) as { apis: { name: string }[] };
  return apis.map(({ name }) => name);
}

/** The APIs page's form, posted from the page by the caller's browser. */
function pageForm(caller: WebSessionCaller, fields: Record<string, string>): Promise<Response> {
  const route = createApisRoute({ execute: install.execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
  return route(
    new Request(`${URL_OF_INSTALL}/admin/apis`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ ...fields, csrf: install.fromThePage(caller).csrfToken ?? "" }).toString(),
    }),
  );
}

/** The keys of the teams whose declarations route the API's changes, as contract-change routing reads them. */
function routedTo(api: string): Promise<string[]> {
  return withOrg(install.db, async (context) => (await consumersOf(context, api)).map(({ key }) => key), { readOnly: true });
}

/** The API a report from this CI run may report for, by its name; a refusal otherwise. */
function reportFor(caller: CiCaller, name: string): Promise<{ id: string; name: string }> {
  return withOrg(install.db, (context) => reportableApi(context, caller, name), { readOnly: true });
}

describe("unregistering an API", () => {
  it("needs no confirmation step: an admin's form on the APIs page unregisters it, and a security event records it", async () => {
    const page = await (
      await createApisRoute({ execute: install.execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger })(
        new Request(`${URL_OF_INSTALL}/admin/apis`, { headers: { accept: "text/html" } }),
      )
    ).text();
    expect(page).toContain('<input type="hidden" name="action" value="unregister">');
    const from = await lastEvent();

    const answer = await pageForm(ada, { action: "unregister", api: paymentsApi });

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/admin/apis");
    expect(await listed()).toEqual([]);
    expect(await eventsSince(from)).toEqual([
      { type: "api.unregistered", class: "security", actor_kind: "web_session", actor_user_id: ada.userId, data: { apiId: paymentsApi } },
    ]);
  });

  it("refuses with 403 every later report for it, from the repository it was bound to", async () => {
    await expect(reportFor(paymentsRun(), "payments-api")).resolves.toMatchObject({ id: paymentsApi, name: "payments-api" });

    await install.execute("apis.unregister", ada, { api: paymentsApi });

    await expect(reportFor(paymentsRun(), "payments-api")).rejects.toMatchObject({ status: 403, reason: "ci-caller-refused" });
  });

  it("keeps the requests that name it as they are", async () => {
    await openRequest(install, tokenOf(danaId), {
      targetTeam: "FE",
      title: "Move to the new payment fields",
      packet: {
        schema_version: "1-beta",
        kind: "request",
        untrusted: {
          need: "Read the new payment fields.",
          contract: {
            api: "payments-api",
            base: { ref: "main", sha: "a".repeat(40) },
            head: { ref: "new-fields", sha: "b".repeat(40) },
            engine: { name: "oasdiff", version: "1.32.1" },
            changes: [{ id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" }],
            provider_pr: { repository: "acme/payments", number: 310 },
            provider_status: "open",
          },
        },
      },
    });
    const before = (await install.owner.query("SELECT state, claimant_user_id FROM requests WHERE target_team_id = $1", [fe])).rows;

    await install.execute("apis.unregister", ada, { api: paymentsApi });

    expect((await install.owner.query("SELECT state, claimant_user_id FROM requests WHERE target_team_id = $1", [fe])).rows).toEqual(before);
    expect((await install.owner.query("SELECT count(*)::int AS n FROM packet_revisions")).rows[0].n).toBeGreaterThan(0);
  });

  it("is refused with 403 for a member, and the API stays registered", async () => {
    const from = await lastEvent();

    expect((await pageForm(dana, { action: "unregister", api: paymentsApi })).status).toBe(403);
    await expect(install.execute("apis.unregister", dana, { api: paymentsApi })).rejects.toMatchObject({ status: 403 });

    expect(await listed()).toEqual(["payments-api"]);
    await expect(reportFor(paymentsRun(), "payments-api")).resolves.toMatchObject({ id: paymentsApi });
    expect(await eventsSince(from)).toEqual([]);
  });

  it("changes nothing and records nothing for an API that is unregistered already", async () => {
    await install.execute("apis.unregister", ada, { api: paymentsApi });
    const from = await lastEvent();

    await expect(install.execute("apis.unregister", ada, { api: paymentsApi })).resolves.toEqual({ api: paymentsApi, unregistered: true });

    expect(await eventsSince(from)).toEqual([]);
  });

  it("gets 404 for an API that does not exist", async () => {
    const noSuchApi = randomUUID();
    await expect(install.execute("apis.unregister", ada, { api: noSuchApi })).rejects.toMatchObject({ status: 404 });
  });

  it("lets an admin register it again, bound anew, which is how its provider team, repository or workflow changes", async () => {
    await install.execute("apis.unregister", ada, { api: paymentsApi });
    const from = await lastEvent();

    const again = await install.confirm(ada, "apis.register", {
      name: "payments-api",
      team: fe,
      repository: "acme/web",
      workflow: "acme/web/.github/workflows/contract.yml",
    });

    expect(again.status).toBe(200);
    expect(await listed()).toEqual(["payments-api"]);
    // Bound anew under its name; a report from its old repository is refused.
    expect(await eventsSince(from)).toEqual([
      { type: "api.registered", class: "security", actor_kind: "web_session", actor_user_id: ada.userId, data: { apiId: paymentsApi, providerTeamId: fe } },
    ]);
    await expect(reportFor(paymentsRun(), "payments-api")).rejects.toMatchObject({ status: 403 });
    const webRun: CiCaller = { kind: "ci", repositoryId: "7002", repositoryOwnerId: String(acmeId), jobWorkflowRef: "acme/web/.github/workflows/contract.yml@refs/heads/main" };
    await expect(reportFor(webRun, "payments-api")).resolves.toMatchObject({ id: paymentsApi });
  });
});

describe("registering an unregistered API's name again (decisions-from-groups-15-28, D55 (56))", () => {
  /** FE declares that it consumes payments-api, PAY turns its WARN switch on, and an admin unregisters it. */
  beforeEach(async () => {
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });
    await install.execute("apis.set_warn_switch", dana, { api: paymentsApi, on: true });
    expect(await routedTo(paymentsApi)).toEqual(["FE"]);
    await install.execute("apis.unregister", ada, { api: paymentsApi });
    expect(await routedTo(paymentsApi)).toEqual([]);
  });

  /** FE's declaration of payments-api as FE's page lists it, or null when FE has none. */
  async function feDeclaration(): Promise<unknown> {
    const { apis } = (await install.execute("apis.list_for_team", ayse, { team: "FE" }, { readOnly: true })) as {
      apis: { id: string; declaration: unknown }[];
    };
    return apis.find(({ id }) => id === paymentsApi)?.declaration ?? null;
  }

  async function warnSwitch(): Promise<boolean> {
    const { rows } = await install.owner.query<{ on: boolean }>("SELECT warn_opens_requests AS on FROM apis WHERE id = $1", [paymentsApi]);
    return rows[0]?.on ?? false;
  }

  it("keeps the declarations, and the WARN switch, with the same repository and provider team", async () => {
    expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);

    expect(await routedTo(paymentsApi)).toEqual(["FE"]);
    expect(await feDeclaration()).toMatchObject({ declaredBy: { login: "ayse" } });
    expect(await warnSwitch()).toBe(true);
  });

  it("keeps them when only the workflow changes, and the repository's name is written in another case", async () => {
    const workflow = "acme/payments/.github/workflows/contract.yml";
    expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "ACME/Payments", workflow })).status).toBe(200);

    expect(await routedTo(paymentsApi)).toEqual(["FE"]);
  });

  it.each([
    ["another repository", () => ({ team: pay, repository: "acme/web" })],
    ["another provider team", () => ({ team: fe, repository: "acme/payments" })],
  ])("makes it a new API with %s, to which no declaration carries over, with the WARN switch off", async (_case, binding) => {
    expect((await install.confirm(ada, "apis.register", { name: "payments-api", ...binding() })).status).toBe(200);

    expect(await routedTo(paymentsApi)).toEqual([]);
    expect(await feDeclaration()).toBeNull();
    expect(await warnSwitch()).toBe(false);
    // FE declares it again, as a consuming team of the new API does.
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });
    expect(await routedTo(paymentsApi)).toEqual(["FE"]);
  });

  it("brings no declaration back when a moved API is moved back to where it was", async () => {
    expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/web" })).status).toBe(200);
    await install.execute("apis.unregister", ada, { api: paymentsApi });

    expect((await install.confirm(ada, "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);

    expect(await routedTo(paymentsApi)).toEqual([]);
  });
});
