import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOG } from "@tiehall/catalog";
import { consumersOf, createTeamApisRoute, withOrg, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Teams declare the APIs they consume (contract-changes: Teams declare the
// APIs they consume; teams-and-roles: What admins and members may do;
// design.md, Decisions this change rests on: D15, D28 #4, #72). The consumer
// map is made of declarations in Tiehall, each stating that one team consumes
// one registered API, made in the web UI on the team's page. Any member of the
// team declares it, which records who declared it and when it was last
// confirmed; anyone who is not a member of that team, an admin included, gets
// 403 and changes nothing. Any member of the team removes the team's
// declaration, after which contract changes to the API no longer route to the
// team. Routing reads the declarations alone, of registered APIs.

let install: TestInstall;
let ada: WebSessionCaller;
let ayse: WebSessionCaller;
let mehmet: WebSessionCaller;
let zeynep: WebSessionCaller;
let fe: string;
let mobile: string;
let pay: string;
let paymentsApi: string;
let billingApi: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  ayse = sessionOf(await addUser(install.owner, { login: "ayse" }));
  mehmet = sessionOf(await addUser(install.owner, { login: "mehmet" }));
  zeynep = sessionOf(await addUser(install.owner, { login: "zeynep" }));
  fe = await addTeam(install.owner, "FE");
  mobile = await addTeam(install.owner, "MOBILE");
  pay = await addTeam(install.owner, "PAY");
  await joinTeams(install.owner, ayse.userId, fe);
  await joinTeams(install.owner, mehmet.userId, fe);
  await joinTeams(install.owner, zeynep.userId, mobile);
  await addInstallation(install.owner, {
    account: "acme",
    repositories: [
      { fullName: "acme/payments", id: 7001 },
      { fullName: "acme/billing", id: 7002 },
    ],
  });
  for (const [name, repository] of [
    ["payments-api", "acme/payments"],
    ["billing-api", "acme/billing"],
  ]) {
    expect((await install.confirm(ada, "apis.register", { name, team: pay, repository })).status).toBe(200);
  }
  const { rows } = await install.owner.query<{ id: string; name: string }>("SELECT id, name FROM apis");
  paymentsApi = rows.find(({ name }) => name === "payments-api")?.id ?? "";
  billingApi = rows.find(({ name }) => name === "billing-api")?.id ?? "";
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("DELETE FROM api_consumers");
  await install.owner.query("UPDATE apis SET unregistered_at = NULL, unregistered_by = NULL");
});

/** The declarations as stored, by API name and team key, with who declared each and when it was last confirmed. */
async function declarations(): Promise<{ api: string; team: string; declared_by: string; confirmed: boolean }[]> {
  const { rows } = await install.owner.query(
    `SELECT a.name AS api, t.key AS team, c.declared_by, c.last_confirmed_at = c.declared_at AS confirmed
       FROM api_consumers c JOIN apis a ON a.org_id = c.org_id AND a.id = c.api_id JOIN teams t ON t.org_id = c.org_id AND t.id = c.team_id
      ORDER BY a.name, t.key`,
  );
  return rows;
}

/** The team keys that routing reads as the API's consumers. */
async function routedTo(apiId: string): Promise<string[]> {
  return (await withOrg(install.db, (context) => consumersOf(context, apiId), { readOnly: true })).map(({ key }) => key);
}

/** A form of the team's page, posted to its target as the caller's browser posts it from the page. */
function teamPageForm(caller: WebSessionCaller, fields: Record<string, string>): Promise<Response> {
  const route = createTeamApisRoute({ execute: install.execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
  return route(
    new Request(`${URL_OF_INSTALL}/teams/apis`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ ...fields, csrf: install.fromThePage(caller).csrfToken ?? "" }).toString(),
    }),
  );
}

describe("a team's declaration that it consumes an API", () => {
  it("is made by any member of the team, recording who declared it and when, and routing then reads it", async () => {
    const before = Date.now();

    const declared = (await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe })) as any;

    expect(declared).toMatchObject({
      declaration: { api: { id: paymentsApi }, team: { id: fe, key: "FE" }, declaredBy: { id: ayse.userId, login: "ayse" } },
    });
    expect(Date.parse(declared.declaration.declaredAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(declared.declaration.lastConfirmedAt).toBe(declared.declaration.declaredAt);
    expect(await declarations()).toEqual([{ api: "payments-api", team: "FE", declared_by: ayse.userId, confirmed: true }]);
    expect(await routedTo(paymentsApi)).toEqual(["FE"]);
  });

  it("made again changes nothing: it keeps its declarer and time", async () => {
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });
    const first = await declarations();

    await install.execute("apis.declare_consumer", mehmet, { api: paymentsApi, team: fe });

    expect(await declarations()).toEqual(first);
  });

  it("is refused with 403 for someone who is not a member of the team, an admin included, and changes nothing", async () => {
    await expect(install.execute("apis.declare_consumer", zeynep, { api: paymentsApi, team: fe })).rejects.toMatchObject({ status: 403, reason: "forbidden" });
    await expect(install.execute("apis.declare_consumer", ada, { api: paymentsApi, team: fe })).rejects.toMatchObject({ status: 403 });
    expect(await declarations()).toEqual([]);
    expect(await routedTo(paymentsApi)).toEqual([]);
  });

  it("is refused with 404 for an API that does not exist, and 409 for one that is unregistered", async () => {
    await expect(install.execute("apis.declare_consumer", ayse, { api: fe, team: fe })).rejects.toMatchObject({ status: 404 });
    await install.execute("apis.unregister", ada, { api: billingApi });
    await expect(install.execute("apis.declare_consumer", ayse, { api: billingApi, team: fe })).rejects.toMatchObject({ status: 409 });
    expect(await declarations()).toEqual([]);
  });

  it("is removed by any member of the team, after which routing reads it no more", async () => {
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });

    await expect(install.execute("apis.remove_consumer", mehmet, { api: paymentsApi, team: fe })).resolves.toEqual({ api: paymentsApi, team: fe, declared: false });

    expect(await declarations()).toEqual([]);
    expect(await routedTo(paymentsApi)).toEqual([]);
  });

  it("is refused removal with 403 for someone who is not a member of the team, and stays", async () => {
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });

    await expect(install.execute("apis.remove_consumer", zeynep, { api: paymentsApi, team: fe })).rejects.toMatchObject({ status: 403 });
    await expect(install.execute("apis.remove_consumer", ada, { api: paymentsApi, team: fe })).rejects.toMatchObject({ status: 403 });

    expect(await routedTo(paymentsApi)).toEqual(["FE"]);
  });

  it("is offered on no agent surface: declarations are made in the web UI", () => {
    for (const id of ["apis.declare_consumer", "apis.remove_consumer", "apis.list_for_team"]) expect(CATALOG.get(id)?.surfaces, id).toEqual([]);
  });
});

describe("routing", () => {
  it("reads only declarations: of each API, the teams that declared it, and of an unregistered API none", async () => {
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });
    await install.execute("apis.declare_consumer", zeynep, { api: paymentsApi, team: mobile });
    await install.execute("apis.declare_consumer", zeynep, { api: billingApi, team: mobile });

    expect(await routedTo(paymentsApi)).toEqual(["FE", "MOBILE"]);
    // The provider team consumes nothing it did not declare, and a team that declared another API gets nothing for this one.
    expect(await routedTo(billingApi)).toEqual(["MOBILE"]);

    await install.execute("apis.unregister", ada, { api: paymentsApi });
    expect(await routedTo(paymentsApi)).toEqual([]);
  });
});

describe("the team's page", () => {
  it("lists the registered APIs with the team's declarations, and whether the reader is one of its members", async () => {
    await install.execute("apis.declare_consumer", ayse, { api: paymentsApi, team: fe });

    const forMember = (await install.execute("apis.list_for_team", mehmet, { team: "FE" }, { readOnly: true })) as any;
    const forOther = (await install.execute("apis.list_for_team", zeynep, { team: "FE" }, { readOnly: true })) as any;

    expect(forMember.member).toBe(true);
    expect(forOther.member).toBe(false);
    expect(forMember.apis).toEqual([
      { id: billingApi, provider: { id: pay, key: "PAY" }, declaration: null, untrusted: { name: "billing-api" } },
      {
        id: paymentsApi,
        provider: { id: pay, key: "PAY" },
        declaration: { declaredBy: expect.objectContaining({ login: "ayse" }), declaredAt: expect.any(String), lastConfirmedAt: expect.any(String), stale: false },
        untrusted: { name: "payments-api" },
      },
    ]);
    expect(forOther.apis).toEqual(forMember.apis);
  });

  it("declares and removes through its forms, which pass the web UI's write checks and lead back to the page, and refuses a form of someone outside the team", async () => {
    const declared = await teamPageForm(mehmet, { action: "declare_api", key: "FE", team: fe, api: billingApi });
    expect(declared.status).toBe(303);
    expect(declared.headers.get("location")).toBe("/FE");
    expect(await routedTo(billingApi)).toEqual(["FE"]);

    expect((await teamPageForm(zeynep, { action: "remove_api", key: "FE", team: fe, api: billingApi })).status).toBe(403);
    expect(await routedTo(billingApi)).toEqual(["FE"]);

    const before = (await install.owner.query("SELECT last_confirmed_at FROM api_consumers WHERE api_id = $1", [billingApi])).rows[0].last_confirmed_at;
    expect((await teamPageForm(ayse, { action: "reconfirm_api", key: "FE", team: fe, api: billingApi })).status).toBe(303);
    const after = (await install.owner.query("SELECT last_confirmed_at, declared_by FROM api_consumers WHERE api_id = $1", [billingApi])).rows[0];
    expect(after.last_confirmed_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(after.declared_by).toBe(mehmet.userId);

    expect((await teamPageForm(ayse, { action: "remove_api", key: "FE", team: fe, api: billingApi })).status).toBe(303);
    expect(await routedTo(billingApi)).toEqual([]);
    expect((await teamPageForm(ayse, { action: "drop_table", key: "FE", team: fe, api: billingApi })).status).toBe(400);
    // A form without the session's CSRF token changes nothing.
    const route = createTeamApisRoute({ execute: install.execute, session: async () => ayse, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
    const forged = await route(
      new Request(`${URL_OF_INSTALL}/teams/apis`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ action: "declare_api", key: "FE", team: fe, api: billingApi }).toString(),
      }),
    );
    expect(forged.status).toBe(403);
    expect(await routedTo(billingApi)).toEqual([]);
  });
});
