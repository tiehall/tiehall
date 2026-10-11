import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOG, OPENAPI_JSON, toolSnapshot } from "@tiehall/catalog";
import { createApisRoute, type WebSessionCaller } from "../src/index.ts";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, sessionOf } from "./support/requests.ts";

// Admins register APIs, each bound to one repository (contract-changes: Admins
// register APIs, each bound to one repository; teams-and-roles: What admins
// and members may do; agent-safety: Actions that need the confirmation step;
// agent-surfaces: Admin actions and trust changes are on no agent surface;
// activity-log: Which actions are security events; design.md, Decisions this
// change rests on: D28 #4, #44; design.md, Readings to confirm with the
// founder: R19). An admin registers an API in the web UI, on the admin page
// /admin/apis, whose form leads to the registration's review page, where it
// takes effect with the confirmation step. Each API has one provider team and
// is bound to one GitHub repository that a connected installation covers:
// Tiehall stores the repository's GitHub id and its owner's, which the OIDC
// token of a CI run in that repository names, and, when the admin names one,
// the one workflow (`job_workflow_ref`) whose runs may report for it. A
// repository that no connected installation covers gets 409; a registration
// without a valid confirmation, and a member's, get 403; no agent surface
// offers it; each registration is a security event.

const REGISTER = "apis.register";

let install: TestInstall;
let ada: WebSessionCaller;
let dana: WebSessionCaller;
let pay: string;
/** The GitHub id of acme, the account the App is installed on, which owns acme/payments. */
let acmeId: number;

beforeAll(async () => {
  install = await startTestInstall();
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  const danaId = await addUser(install.owner, { role: "member", login: "dana" });
  dana = sessionOf(danaId);
  pay = await addTeam(install.owner, "PAY");
  await joinTeams(install.owner, danaId, pay);
  ({ accountId: acmeId } = await addInstallation(install.owner, {
    account: "acme",
    repositories: [
      { fullName: "acme/payments", id: 7001 },
      { fullName: "acme/web", id: 7002 },
    ],
  }));
  // An installation nobody connected, and a connected one GitHub suspended.
  await addInstallation(install.owner, { account: "acme-labs", repositories: [{ fullName: "acme-labs/tools", id: 7101 }], connected: false });
  await addInstallation(install.owner, { account: "acme-old", repositories: [{ fullName: "acme-old/ledger", id: 7201 }], suspended: true });
}, 60_000);

afterAll(async () => {
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("DELETE FROM apis");
});

/** The registered APIs as stored. */
async function stored(): Promise<Record<string, unknown>[]> {
  const { rows } = await install.owner.query(
    `SELECT a.name, t.key AS team, a.repository_id::int AS repository_id, a.repository_owner_id::bigint::text AS owner_id,
            a.repository_full_name AS repository, a.job_workflow_ref AS workflow, a.registered_by
       FROM apis a JOIN teams t ON t.org_id = a.org_id AND t.id = a.provider_team_id ORDER BY a.name`,
  );
  return rows;
}

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

/** The review page of a registration, as the caller's browser opens it. */
function reviewPage(caller: WebSessionCaller, input: unknown): Promise<Response> {
  return install.confirmRoute(caller)(new Request(`${URL_OF_INSTALL}/confirm/${REGISTER}?input=${encodeURIComponent(JSON.stringify(input))}`));
}

/** The registration's form posted with the session's CSRF token alone, with no confirmation nonce. */
function postWithoutNonce(caller: WebSessionCaller, input: unknown): Promise<Response> {
  return install.confirmRoute(caller)(
    new Request(`${URL_OF_INSTALL}/confirm/${REGISTER}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ input: JSON.stringify(input), csrf: install.fromThePage(caller).csrfToken ?? "" }).toString(),
    }),
  );
}

/** The APIs page of the admin UI, for the caller's web session. */
function apisRoute(caller: WebSessionCaller): (request: Request) => Promise<Response> {
  return createApisRoute({ execute: install.execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
}

/** The APIs page's form, posted from the page by the caller's browser. */
function pageForm(caller: WebSessionCaller, fields: Record<string, string>): Promise<Response> {
  return apisRoute(caller)(
    new Request(`${URL_OF_INSTALL}/admin/apis`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ ...fields, csrf: install.fromThePage(caller).csrfToken ?? "" }).toString(),
    }),
  );
}

describe("registering an API", () => {
  it("registers it once an admin confirms it on its review page, bound to the repository's GitHub ids, and records a security event", async () => {
    const from = await lastEvent();

    const answer = await install.confirm(ada, REGISTER, { name: "payments-api", team: pay, repository: "acme/payments" });

    expect(answer.status).toBe(200);
    expect(await stored()).toEqual([
      { name: "payments-api", team: "PAY", repository_id: 7001, owner_id: String(acmeId), repository: "acme/payments", workflow: null, registered_by: ada.userId },
    ]);
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'");
    expect(await eventsSince(from)).toEqual([
      { type: "api.registered", class: "security", actor_kind: "web_session", actor_user_id: ada.userId, data: { apiId: rows[0]?.id, providerTeamId: pay } },
    ]);
  });

  it("binds it to the one workflow the admin names, whose job_workflow_ref alone may then report for it", async () => {
    const workflow = "acme/payments/.github/workflows/contract.yml@refs/heads/main";

    const answer = await install.confirm(ada, REGISTER, { name: "payments-api", team: pay, repository: "acme/payments", jobWorkflowRef: workflow });

    expect(answer.status).toBe(200);
    expect((await stored())[0]).toMatchObject({ name: "payments-api", workflow });
  });

  it("matches the repository's name as GitHub does, whatever its case, and stores the name GitHub gives it", async () => {
    expect((await install.confirm(ada, REGISTER, { name: "web-api", team: pay, repository: "Acme/Web" })).status).toBe(200);
    expect((await stored())[0]).toMatchObject({ name: "web-api", repository_id: 7002, repository: "acme/web" });
  });

  it("reviews, in Tiehall's own words, what registering does: the API, its provider team, its repository and its workflow", async () => {
    const page = await reviewPage(ada, {
      name: "payments-api",
      team: pay,
      repository: "acme/payments",
      jobWorkflowRef: "acme/payments/.github/workflows/contract.yml@refs/heads/main",
    });

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Register the API payments-api for the team PAY");
    expect(html).toContain("acme/payments");
    expect(html).toContain("acme/payments/.github/workflows/contract.yml@refs/heads/main");
    expect(await stored()).toEqual([]);
  });

  it.each([
    ["no connected installation covers", "acme/billing"],
    ["only an installation nobody connected covers", "acme-labs/tools"],
    ["only a suspended installation covers", "acme-old/ledger"],
  ])("is refused with 409 for a repository that %s, and registers nothing", async (_case, repository) => {
    const review = await reviewPage(ada, { name: "payments-api", team: pay, repository });
    expect(review.status).toBe(200);
    expect(await review.text()).toContain(`GitHub App covers ${repository}, so confirming registers nothing.`);
    const from = await lastEvent();

    const answer = await install.confirm(ada, REGISTER, { name: "payments-api", team: pay, repository });

    expect(answer.status).toBe(409);
    expect(await stored()).toEqual([]);
    expect(await eventsSince(from)).toEqual([]);
  });

  it("is refused with 409 for a name another API has, which keeps its binding", async () => {
    expect((await install.confirm(ada, REGISTER, { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);

    const answer = await install.confirm(ada, REGISTER, { name: "payments-api", team: pay, repository: "acme/web" });

    expect(answer.status).toBe(409);
    expect(await stored()).toEqual([expect.objectContaining({ name: "payments-api", repository: "acme/payments" })]);
  });

  it("is refused with 404 for a provider team that does not exist", async () => {
    const answer = await install.confirm(ada, REGISTER, { name: "payments-api", team: "5b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", repository: "acme/payments" });
    expect(answer.status).toBe(404);
    expect(await stored()).toEqual([]);
  });

  it.each([
    ["a name in capitals", { name: "Payments", repository: "acme/payments" }],
    // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (59): 1 to 100 lower-case letters,
    // digits, dots, hyphens and underscores, the form in which contract reports name APIs.
    ["a name with one upper-case letter", { name: "payments-Api", repository: "acme/payments" }],
    ["a name of 101 characters", { name: "a".repeat(101), repository: "acme/payments" }],
    ["a repository that is not owner/name", { name: "payments-api", repository: "payments" }],
    ["a workflow that is not a job_workflow_ref", { name: "payments-api", repository: "acme/payments", jobWorkflowRef: "contract.yml" }],
  ])("is refused with 400 for %s", async (_case, input) => {
    const answer = await reviewPage(ada, { team: pay, ...input });
    expect(answer.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("takes a name of 100 characters", async () => {
    const name = `p${"a".repeat(98)}i`;
    expect((await install.confirm(ada, REGISTER, { name, team: pay, repository: "acme/payments" })).status).toBe(200);
    expect(await stored()).toEqual([expect.objectContaining({ name, repository: "acme/payments" })]);
  });

  it("is refused with 403 without a valid confirmation, and registers nothing", async () => {
    const from = await lastEvent();
    const input = { name: "payments-api", team: pay, repository: "acme/payments" };

    expect((await postWithoutNonce(ada, input)).status).toBe(403);
    await expect(install.execute(REGISTER, ada, input)).rejects.toMatchObject({ status: 403, reason: "confirmation-required" });

    expect(await stored()).toEqual([]);
    expect(await eventsSince(from)).toEqual([]);
  });

  it("is refused with 403 for a member, on its review page, its confirmation and the admin page's form, and registers nothing", async () => {
    const input = { name: "payments-api", team: pay, repository: "acme/payments" };
    const from = await lastEvent();

    expect((await reviewPage(dana, input)).status).toBe(403);
    expect((await postWithoutNonce(dana, input)).status).toBe(403);
    expect((await pageForm(dana, { action: "register", name: "payments-api", team: pay, repository: "acme/payments", jobWorkflowRef: "" })).status).toBe(403);

    expect(await stored()).toEqual([]);
    expect(await eventsSince(from)).toEqual([]);
  });

  it("is offered on no agent surface: no MCP tool, no operation of the OpenAPI document and no CLI command registers an API", () => {
    expect(CATALOG.get(REGISTER)?.surfaces).toEqual([]);
    const document = JSON.parse(OPENAPI_JSON) as { paths: Record<string, Record<string, { operationId: string; "x-tiehall-cli"?: { command: string }[] }>> };
    const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
    expect(operations.map(({ operationId }) => operationId).filter((id) => id.startsWith("apis."))).toEqual([]);
    const commands = operations.flatMap((operation) => operation["x-tiehall-cli"] ?? []).map(({ command }) => command);
    expect(commands.filter((command) => /\bapis?\b|register/.test(command))).toEqual([]);
    expect(toolSnapshot(CATALOG).map(({ name }) => name).filter((name) => /api|register/.test(name))).toEqual([]);
  });
});

describe("the APIs page", () => {
  it("lists the registered APIs with their provider team, repository and workflow, and offers the covered repositories", async () => {
    await install.confirm(ada, REGISTER, { name: "payments-api", team: pay, repository: "acme/payments" });

    const page = await apisRoute(ada)(new Request(`${URL_OF_INSTALL}/admin/apis`, { headers: { accept: "text/html" } }));

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("payments-api");
    expect(html).toContain("acme/payments");
    expect(html).toContain('<option value="acme/web">');
    expect(html).not.toContain('<option value="acme-labs/tools">');
  });

  it("leads an admin's form to the review page of the registration it names, with no workflow when none is given", async () => {
    const answer = await pageForm(ada, { action: "register", name: "payments-api", team: pay, repository: "acme/payments", jobWorkflowRef: "" });

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(
      `/confirm/${REGISTER}?input=${encodeURIComponent(JSON.stringify({ name: "payments-api", team: pay, repository: "acme/payments" }))}`,
    );
    expect(await stored()).toEqual([]);
  });

  it("gets 403 for a member", async () => {
    expect((await apisRoute(dana)(new Request(`${URL_OF_INSTALL}/admin/apis`, { headers: { accept: "text/html" } }))).status).toBe(403);
  });
});
