import { readFileSync } from "node:fs";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packet } from "@tiehall/catalog";
import { loadFixtures } from "@tiehall/packet/conformance";
import { packetValidator } from "@tiehall/packet";
import { createSetupGate, PACKET_SCHEMA_PATH, packetSchemaRoute } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";

// Every install serves the beta schema (handoff-packet: The beta label;
// design.md, Technical decisions: T11; design.md, Readings to confirm with the
// founder: R22). Once setup is complete, anyone may fetch the packet JSON
// Schema at /schemas/packet/v1-beta.json on the install, without signing in,
// because it holds no data of the install: it is the schema file of the
// Apache-2.0 schema directory, with the $id
// https://tiehall.com/schemas/packet/v1-beta.json. That $id names the schema
// and is never fetched: validating packets against the schema, as a client
// does with the served file and as the install does with the definition it was
// generated from, opens no connection to tiehall.com or anywhere else.

const SCHEMA_FILE = new URL("../../packet/schema/v1-beta.json", import.meta.url);

let install: TestInstall;

beforeAll(async () => {
  install = await startTestInstall();
});

afterAll(async () => {
  await install.close();
});

/** Calls the install as a web request without credentials: first the setup gate, then the route. */
async function anonymous(method: string, path: string): Promise<Response> {
  const request = new Request(`${URL_OF_INSTALL}${path}`, { method });
  const gated = await createSetupGate({ database: install.db, url: URL_OF_INSTALL })(request);
  return gated ?? packetSchemaRoute(request);
}

/** Records every outbound connection this process starts while it runs. */
async function connectionsDuring(run: () => Promise<void> | void): Promise<string[]> {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  const fetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const [first] = args;
    attempts.push(JSON.stringify(typeof first === "object" && first !== null ? first : args.slice(0, 2)));
    return (connect as (...parameters: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  globalThis.fetch = async (input, init) => {
    attempts.push(`fetch ${String(input instanceof Request ? input.url : input)}`);
    return fetch(input, init);
  };
  try {
    await run();
  } finally {
    net.Socket.prototype.connect = connect;
    globalThis.fetch = fetch;
  }
  return attempts;
}

describe("the beta schema on the install", () => {
  it("is at /schemas/packet/v1-beta.json", () => {
    expect(PACKET_SCHEMA_PATH).toBe("/schemas/packet/v1-beta.json");
  });

  it("answers a request without credentials after setup with the packet JSON Schema and its beta $id", async () => {
    const answer = await anonymous("GET", PACKET_SCHEMA_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/schema+json");
    const text = await answer.text();
    expect(text).toBe(readFileSync(SCHEMA_FILE, "utf8"));
    expect(JSON.parse(text)).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://tiehall.com/schemas/packet/v1-beta.json",
    });
  });

  it("answers HEAD with the same headers and no body", async () => {
    const answer = await anonymous("HEAD", PACKET_SCHEMA_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/schema+json");
    expect(await answer.text()).toBe("");
  });

  it("is validated against, by a client and by the install, without any outbound connection", async () => {
    const served = (await (await anonymous("GET", PACKET_SCHEMA_PATH)).json()) as Record<string, unknown>;
    const fixtures = loadFixtures();
    const outcomes: boolean[][] = [];
    const attempts = await connectionsDuring(() => {
      const validate = packetValidator(served);
      for (const fixture of fixtures) outcomes.push([validate(fixture.packet), packet.safeParse(fixture.packet).success]);
    });
    expect(attempts).toEqual([]);
    expect(outcomes).toEqual(fixtures.map(({ expected }) => [expected === "valid", expected === "valid"]));
  });

  it("would show an outbound connection if one were made", async () => {
    const attempts = await connectionsDuring(async () => {
      const socket = net.connect({ host: "127.0.0.1", port: 9 });
      socket.on("error", () => {});
      socket.destroy();
    });
    expect(attempts).toEqual([expect.stringContaining('"host":"127.0.0.1"')]);
  });
});
