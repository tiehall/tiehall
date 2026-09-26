import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packetValidator } from "@tiehall/packet";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, tokenOf } from "./support/requests.ts";

// The `extensions` field (handoff-packet: The `extensions` field; design.md,
// Decisions this change rests on: D28 #23). Its keys are reverse-DNS
// namespaces, such as com.acme.billing; Tiehall keeps what is under them as
// sent, without dropping keys it does not know, and returns it unchanged; it
// is capped at 16 KB of JSON; and it is untrusted, so an agent that reads the
// packet as JSON finds its contents under the packet's `untrusted` object. A
// key that is not a namespace, or extensions over the cap, get 400 and store
// nothing.

let install: TestInstall;
let alice: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  await joinTeams(install.owner, alice, be);
});

afterAll(async () => {
  await install.close();
});

/** A request's packet with these extensions. */
function withExtensions(extensions: unknown): Record<string, unknown> {
  const packet = packetOf("Charge the new plan from the first of next month.");
  return { ...packet, untrusted: { ...(packet["untrusted"] as object), extensions } };
}

/** Extensions whose JSON takes exactly this many bytes. */
function extensionsOfSize(bytes: number): Record<string, unknown> {
  const of = (filler: string) => ({ "com.acme.billing": { notes: filler } });
  const overhead = new TextEncoder().encode(JSON.stringify(of(""))).length;
  const extensions = of("x".repeat(bytes - overhead));
  expect(new TextEncoder().encode(JSON.stringify(extensions)).length).toBe(bytes);
  return extensions;
}

async function everything(): Promise<unknown> {
  const { rows } = await install.owner.query(
    "SELECT (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM packet_revisions) AS revisions, (SELECT count(*) FROM events) AS events",
  );
  return rows[0];
}

async function refused(packet: unknown): Promise<void> {
  const before = await everything();
  const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", title: "Extensions", packet });
  expect(answer.status).toBe(400);
  expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/invalid-input" });
  expect(await everything()).toEqual(before);
}

describe("extensions", () => {
  it("keep com.acme.billing with its nested values exactly as sent, keys Tiehall does not know included", async () => {
    const extensions = {
      "com.acme.billing": { cost_center: "CC-12", flags: ["urgent"], approval: { by: "finance", levels: [1, 2.5, null, true] } },
      "io.example.tracker": { "Ticket ID": 4821, "": "empty key", "ünïcode": "✓" },
    };
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: withExtensions(extensions) });
    const read = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(read.status).toBe(200);
    expect(read.body.packet.untrusted.extensions).toEqual(extensions);
    expect(JSON.stringify(read.body.packet.untrusted.extensions)).toBe(JSON.stringify(extensions));
  });

  it("sit under the packet's untrusted object when an agent reads the packet as JSON, and nowhere else", async () => {
    const extensions = { "com.acme.billing": { cost_center: "CC-12" } };
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: withExtensions(extensions) });
    const { body } = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(body.packet.untrusted).toMatchObject({ extensions });
    expect(Object.keys(body.packet).sort()).toEqual(["kind", "schema_version", "untrusted"]);
    expect(JSON.stringify({ ...body, packet: { ...body.packet, untrusted: undefined } })).not.toContain("CC-12");
  });

  it.each([["billing"], ["com"], ["com..acme"], [".com.acme"], ["com.acme."], ["com.acme billing"], ["COM.ACME"], ["__proto__"], ["constructor"]])(
    "get 400 for the key %s, which is not a reverse-DNS namespace, and store nothing",
    async (key) => {
      await refused(withExtensions({ [key]: { cost_center: "CC-12" } }));
    },
  );

  // A computed key makes `__proto__` an own key, as JSON.parse does on the server, not the object's prototype.
  it("get 400 for a __proto__ key next to a namespace, rather than dropping it, and store nothing", async () => {
    await refused(withExtensions({ "com.acme.billing": { cost_center: "CC-12" }, ["__proto__"]: { cost_center: "CC-13" } }));
  });

  it("keep a __proto__ key inside a namespace's value as sent", async () => {
    const extensions = { "com.acme.billing": { ["__proto__"]: { polluted: true }, cost_center: "CC-12" } };
    expect(Object.keys(extensions["com.acme.billing"])).toEqual(["__proto__", "cost_center"]);
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: withExtensions(extensions) });
    const read = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body.packet.untrusted.extensions)).toBe(JSON.stringify(extensions));
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("pass at 16 KB of JSON", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: withExtensions(extensionsOfSize(16 * 1024)) });
    const read = await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet`);
    expect(read.body.packet.untrusted.extensions).toEqual(extensionsOfSize(16 * 1024));
  });

  it("get 400 at 20 KB of JSON, and one byte over 16 KB, and store nothing", async () => {
    await refused(withExtensions(extensionsOfSize(20 * 1024)));
    await refused(withExtensions(extensionsOfSize(16 * 1024 + 1)));
  });

  it("are refused by the packet schema when a key is not a namespace, and accepted under namespaces", () => {
    const validate = packetValidator();
    expect(validate(withExtensions({ billing: {} }))).toBe(false);
    expect(validate(withExtensions({ ["__proto__"]: {} }))).toBe(false);
    expect(validate(withExtensions({ "com.acme.billing": { anything: [1, { goes: true }] } }))).toBe(true);
  });
});
