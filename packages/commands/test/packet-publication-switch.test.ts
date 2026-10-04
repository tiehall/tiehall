import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PACKET_SCHEMA_ID, PACKET_SCHEMA_VERSION, packetJsonSchema, CATALOG } from "@tiehall/catalog";
import { openApiDocument } from "@tiehall/catalog/openapi";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sendApi, tokenOf } from "./support/requests.ts";

// A simulated publication of the packet schema (handoff-packet: The beta
// label; handoff-packet: The packet media type; design.md, Decisions this
// change rests on: D28 #22, #24). The publication switch, the schema
// directory's publication.json, is turned on for this file's whole install,
// as publishing the schema turns it on: packets then carry schema_version
// "1.0" and the schema's $id is its v1.0 release URL, a packet the install
// stored before publication reads back as a packet of 1.0, and a client that
// still sends 1-beta is refused like any packet that fails the schema. The API
// keeps serving packets as application/json; the media type is only named in
// the published spec.

vi.mock("@tiehall/packet/publication.json", () => ({ default: { published: true } }));

const PACKET = { schema_version: "1.0", kind: "request", untrusted: { need: "Expose the invoice total in the orders API." } };

let install: TestInstall;
let alice: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  await joinTeams(install.owner, alice, be);
}, 120_000);

afterAll(async () => {
  await install?.close();
});

describe("a published packet schema", () => {
  it("has packets carry 1.0, with the v1.0 release URL as the schema's $id", () => {
    expect(PACKET_SCHEMA_VERSION).toBe("1.0");
    expect(PACKET_SCHEMA_ID).toBe("https://tiehall.com/schemas/packet/v1.0.json");
    const schema = packetJsonSchema() as { $id: string; oneOf: { properties: { schema_version: { const: string } } }[] };
    expect(schema.$id).toBe("https://tiehall.com/schemas/packet/v1.0.json");
    expect(schema.oneOf.map((variant) => variant.properties.schema_version.const)).toEqual(["1.0", "1.0"]);
    const component = (openApiDocument(CATALOG) as { components: { schemas: { Packet: { oneOf: { properties: { schema_version: { const: string } } }[] } } } }).components.schemas.Packet;
    expect(component.oneOf.map((variant) => variant.properties.schema_version.const)).toEqual(["1.0", "1.0"]);
  });

  it("opens a request with a packet of 1.0 and serves it back as application/json", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: PACKET });
    const read = await sendApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toMatch(/^application\/json\b/);
    expect(read.body.packet).toEqual(PACKET);
  });

  it("reads a packet stored before publication as a packet of 1.0", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: PACKET });
    // Revision 2, as the install stored it while the schema was beta.
    const stored = { ...PACKET, schema_version: "1-beta", untrusted: { need: "Stored before publication." } };
    await install.owner.query(
      "INSERT INTO packet_revisions (org_id, request_id, number, packet, actor_kind, surface) SELECT org_id, id, 2, $2::json, 'system', 'github' FROM requests WHERE id = $1",
      [opened.id, JSON.stringify(stored)],
    );
    const read = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet/revisions/2`);
    expect(read.status).toBe(200);
    expect(read.body.packet).toEqual({ ...PACKET, untrusted: { need: "Stored before publication." } });
  });

  it("refuses a packet that still carries 1-beta, like any packet that fails the schema", async () => {
    const refused = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", title: "Add a dark mode", packet: { ...PACKET, schema_version: "1-beta" } });
    expect(refused.status).toBe(400);
  });
});
