import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand, packet } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { createExecute, HANDLERS, storePacketRevision, type Execute, type Handlers } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, sessionOf, tokenOf } from "./support/requests.ts";

// System actions (requests: System actions need no proposal or confirmation;
// agent-access: Six kinds of caller; design.md, Design rules: Requests and
// events; design.md, Technical decisions: T3). Some changes follow a signed
// GitHub event or a signed contract report rather than anyone's decision, such
// as the packet revisions a contract report adds, even to a claimed request.
// They are internal system commands, which only a system job or a verified
// integration event runs, never a person or an agent: they take effect at
// once, need no proposal and no confirmation, and are recorded as the system's.
// The same change started by an agent is a commitment, and becomes a proposal.
// A fixture system command stands in for the real ones group 23 adds.

const addContractRevision = defineCommand({
  id: "probes.add_contract_revision",
  summary: "A fixture system action: add a packet revision from a contract report, even to a claimed request.",
  input: z.object({ requestId: z.uuid(), packet }),
  output: z.object({ revision: z.number().int() }),
  scopes: [],
  commitment: false,
  confirm: false,
  system: true,
  surfaces: [],
  stability: "alpha",
});

const handlers: Handlers = {
  ...HANDLERS,
  [addContractRevision.id]: async (input, context) => {
    const { requestId, packet: next } = input as { requestId: string; packet: never };
    return context.write(async (writer) => ({ revision: await storePacketRevision(writer, requestId, next) }));
  },
};

let install: TestInstall;
let execute: Execute;
let alice: string;
let bob: string;

beforeAll(async () => {
  install = await startTestInstall();
  execute = createExecute({
    catalog: defineCatalog([...CATALOG.commands, addContractRevision]),
    handlers,
    store: { database: install.db, jobs: { send: async () => {} } },
  });
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, bob, fe);
});

afterAll(async () => {
  await install.close();
});

const contractPacket = { ...packetOf(), untrusted: { need: "Move to the v2 endpoint: 3 breaking changes instead of 2." } };

async function claimedRequest() {
  const request = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
  expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${request.key}/claim`)).status).toBe(200);
  return request as { id: string; key: string };
}

async function stored(requestId: string) {
  const { rows } = await install.owner.query(
    `SELECT (SELECT count(*)::int FROM packet_revisions WHERE request_id = $1) AS revisions,
            (SELECT count(*)::int FROM proposals WHERE request_id = $1) AS proposals,
            (SELECT actor_kind FROM packet_revisions WHERE request_id = $1 ORDER BY number DESC LIMIT 1) AS "latestBy"`,
    [requestId],
  );
  return rows[0];
}

describe("a system command", () => {
  it("run by a system job changes a claimed request at once, with no proposal and no confirmation", async () => {
    const request = await claimedRequest();
    const output = await execute(addContractRevision.id, { kind: "system_job", job: "contract.apply_report" }, { requestId: request.id, packet: contractPacket });
    expect(output).toEqual({ revision: 2 });
    expect(await stored(request.id)).toEqual({ revisions: 2, proposals: 0, latestBy: "system" });
  });

  it("run for a verified integration event takes effect the same way", async () => {
    const request = await claimedRequest();
    await execute(addContractRevision.id, { kind: "integration_event", source: "github" }, { requestId: request.id, packet: contractPacket });
    expect(await stored(request.id)).toEqual({ revisions: 2, proposals: 0, latestBy: "integration" });
  });

  it("is refused to a person's web session, and changes nothing", async () => {
    const request = await claimedRequest();
    const refused = await execute(addContractRevision.id, sessionOf(alice), { requestId: request.id, packet: contractPacket }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Refusal);
    expect(refused).toMatchObject({ status: 403 });
    expect(await stored(request.id)).toEqual({ revisions: 1, proposals: 0, latestBy: "agent" });
  });

  it("is refused to an agent's token as a path that is not there", async () => {
    const request = await claimedRequest();
    const refused = await execute(addContractRevision.id, tokenOf(alice), { requestId: request.id, packet: contractPacket }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 404 });
  });
});

describe("the same change through an agent's token", () => {
  it("is a commitment on a claimed request, which becomes a proposal", async () => {
    const request = await claimedRequest();
    const answer = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${request.key}/packet/revisions`, {
      body: { packet: contractPacket },
      headers: { "if-match": '"1"' },
    });
    expect(answer.status).toBe(202);
    expect(answer.body.proposal).toMatchObject({ kind: "scope", state: "pending" });
    expect(await stored(request.id)).toEqual({ revisions: 1, proposals: 1, latestBy: "agent" });
  });
});
