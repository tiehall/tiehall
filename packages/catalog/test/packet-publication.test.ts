import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKET_MEDIA_TYPE, PACKET_PUBLISHED, PACKET_SCHEMA_ID, PACKET_SCHEMA_VERSION, packetStage } from "../src/index.ts";

// The switch to schema_version "1.0" on publication (handoff-packet: The beta
// label; handoff-packet: The packet media type; design.md, Decisions this
// change rests on: D28 #22, #24). The packet schema directory's
// publication.json is the switch: until the schema is published it says so,
// and packets carry schema_version "1-beta" with the schema's beta $id; from
// publication on they carry "1.0", and the schema's $id is its v1.0 release
// URL. The media type is only named in the published spec, and the API keeps
// serving packets as application/json. A simulated publication turns the
// switch on for a whole install (packages/commands/test/packet-publication-
// switch.test.ts).

describe("the packet's publication switch", () => {
  it("is off: the schema is not published, packets carry 1-beta and the schema has its beta $id", () => {
    const switched = JSON.parse(readFileSync(new URL("../../packet/publication.json", import.meta.url), "utf8")) as { published: boolean };
    expect(switched.published).toBe(false);
    expect(PACKET_PUBLISHED).toBe(false);
    expect(PACKET_SCHEMA_VERSION).toBe("1-beta");
    expect(PACKET_SCHEMA_ID).toBe("https://tiehall.com/schemas/packet/v1-beta.json");
  });

  it("gives packets 1-beta and the beta $id before publication, and 1.0 and the v1.0 release URL from publication on", () => {
    expect(packetStage(false)).toEqual({ published: false, schemaVersion: "1-beta", schemaId: "https://tiehall.com/schemas/packet/v1-beta.json" });
    expect(packetStage(true)).toEqual({ published: true, schemaVersion: "1.0", schemaId: "https://tiehall.com/schemas/packet/v1.0.json" });
  });

  it("names the media type the published spec gives the packet", () => {
    expect(PACKET_MEDIA_TYPE).toBe("application/vnd.tiehall.packet+json; version=1");
  });
});
