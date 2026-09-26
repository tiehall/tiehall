import fc from "fast-check";
import jsonPatchLibrary from "fast-json-patch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storePacketRevision, write, type Store } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, tokenOf } from "./support/requests.ts";

// What changed since revision N (handoff-packet: What changed since revision
// N; agent-safety: User text in JSON sits under untrusted objects; design.md,
// Decisions this change rests on: D28 #25). For a request and a revision N,
// Tiehall answers with the list of the packet's fields that changed between
// revision N and the current revision, and an RFC 6902 JSON Patch that turns
// the packet of revision N into the current packet. The patch carries what
// people wrote, so it sits under `untrusted`. Both are empty when N is the
// current revision. The property test applies the patch with an independent
// RFC 6902 implementation.

let install: TestInstall;
let alice: string;
let store: Store;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "FE");
  alice = await addUser(install.owner, { login: "alice" });
  await joinTeams(install.owner, alice, be);
  store = { database: install.db, jobs: { send: async () => {} } };
});

afterAll(async () => {
  await install.close();
});

/** A packet with these fields under untrusted, on top of the smallest one. */
function packetWith(untrusted: Record<string, unknown>): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

/** Adds the next revision as the requester, through the revision-add operation. */
async function addRevision(key: string, packet: unknown): Promise<void> {
  const etag = (await sendApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet`)).headers.get("etag") ?? "";
  const added = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": etag } });
  expect(added.status).toBe(200);
}

const changesSince = (key: string, since: number | string) => callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet/changes?since=${since}`);
const packetAt = async (key: string, revision: number) =>
  (await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet/revisions/${revision}`)).body.packet;

function applied(document: unknown, patch: unknown): unknown {
  return jsonPatchLibrary.applyPatch(structuredClone(document), structuredClone(patch) as never, true, false).newDocument;
}

describe("what changed since a revision", () => {
  it("names the acceptance criteria and the links changed in revisions 2 and 3, and patches revision 1 into revision 3", async () => {
    const first = packetWith({ acceptance_criteria: ["It follows the system setting."] });
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: first });
    const second = packetWith({ acceptance_criteria: ["It follows the system setting.", "The choice is kept."] });
    await addRevision(opened.key, second);
    const third = packetWith({ acceptance_criteria: ["It follows the system setting.", "The choice is kept."], links: [{ url: "https://wiki.example.com/dark" }] });
    await addRevision(opened.key, third);
    const answer = await changesSince(opened.key, 1);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      request: { id: opened.id, key: opened.key },
      since: 1,
      revision: 3,
      changedFields: ["acceptance_criteria", "links"],
      untrusted: { patch: expect.any(Array) },
    });
    expect(applied(first, answer.body.untrusted.patch)).toEqual(third);
    expect(applied(await packetAt(opened.key, 1), answer.body.untrusted.patch)).toEqual(await packetAt(opened.key, 3));
  });

  it("is an empty patch and an empty list of fields since the current revision", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    await addRevision(opened.key, packetWith({ links: [{ url: "https://wiki.example.com/a" }] }));
    await addRevision(opened.key, packetWith({ links: [{ url: "https://wiki.example.com/b" }] }));
    expect((await changesSince(opened.key, 3)).body).toMatchObject({ since: 3, revision: 3, changedFields: [], untrusted: { patch: [] } });
    const only = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect((await changesSince(only.key, 1)).body).toMatchObject({ since: 1, revision: 1, changedFields: [], untrusted: { patch: [] } });
  });

  it("answers 404 for a revision the request does not have yet, and 400 for one that is not a number from 1", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(await changesSince(opened.key, 2)).toEqual({ status: 404, body: expect.objectContaining({ type: "https://tiehall.com/problems/record-not-found" }) });
    for (const since of ["0", "one", ""]) expect((await changesSince(opened.key, since)).status, since).toBe(400);
    expect((await callApi(install, tokenOf(alice), "GET", `/api/v1/requests/${opened.key}/packet/changes`)).status).toBe(400);
  });
});

describe("the patch since any revision", () => {
  /** A packet the property test changes from revision to revision. */
  const revisionPacket = fc
    .record(
      {
        need: fc.string({ minLength: 1, maxLength: 30 }).filter((text) => /\S/.test(text)),
        acceptance_criteria: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((text) => /\S/.test(text)), { maxLength: 4 }),
        links: fc.array(fc.record({ url: fc.constantFrom("https://a.example.com/x", "https://b.example.com/y"), title: fc.constantFrom("A", "B") }, { requiredKeys: ["url"] }), {
          maxLength: 3,
        }),
        extensions: fc.dictionary(fc.constantFrom("com.acme.billing", "io.example.tracker"), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 2 }),
      },
      { requiredKeys: ["need"] },
    )
    .map((untrusted) => ({ schema_version: "1-beta", kind: "request", untrusted }));

  it("turns revision N into the current packet when applied", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(revisionPacket, { minLength: 1, maxLength: 4 }), fc.nat(), async (packets, pick) => {
        const [opening, ...later] = packets as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
        const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", packet: opening });
        for (const packet of later) {
          await write(store, { actorKind: "agent", userId: alice, surface: "api" }, (writer) => storePacketRevision(writer, opened.id, packet as never));
        }
        const since = (pick % packets.length) + 1;
        const answer = await changesSince(opened.key, since);
        expect(answer.status).toBe(200);
        expect(answer.body.revision).toBe(packets.length);
        const current = await packetAt(opened.key, packets.length);
        expect(applied(await packetAt(opened.key, since), answer.body.untrusted.patch)).toEqual(current);
        if (since === packets.length) expect(answer.body.changedFields).toEqual([]);
      }),
      { numRuns: 25 },
    );
  });
});
