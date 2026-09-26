import { readFileSync } from "node:fs";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequestInTheWebUi, packetOf, sendApi, tokenOf } from "./support/requests.ts";

// Adding a packet revision (public-api: Packet revisions use ETag and
// If-Match; handoff-packet: Immutable, numbered revisions; handoff-packet:
// Packet changes that are commitments; handoff-packet: The beta label;
// requests: Which side may act on a request; design.md, Decisions this change
// rests on: D28 #3, #21). Reading a packet answers with the ETag of its
// revision, such as "3". The requester side, the user who opened the request
// and the members of its requesting team, adds the next revision with
// If-Match set to the current revision's ETag: without it the answer is 428,
// with another revision's 412, and nothing is added, so two writers at the
// same revision cannot overwrite each other. Anyone else, the target team
// included, gets 403. A revision keeps the packet's kind, and validating and
// storing it makes no outbound connection.
//
// Until proposals come with task 14.4, a change that is a commitment, moving
// the due date or changing the scope of a claimed request, is refused with
// 409 and adds nothing, so no commitment takes effect without the people who
// confirm it.

let install: TestInstall;
let alice: string;
let ayse: string;
let bob: string;
let carol: string;

beforeAll(async () => {
  install = await startTestInstall();
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const ops = await addTeam(install.owner, "OPS");
  alice = await addUser(install.owner, { login: "alice" });
  ayse = await addUser(install.owner, { login: "ayse" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, ayse, be);
  await joinTeams(install.owner, bob, fe);
  await joinTeams(install.owner, carol, ops);
});

afterAll(async () => {
  await install.close();
});

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../packet/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

/** A packet with these fields under untrusted, on top of the smallest one. */
function packetWith(untrusted: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
  const packet = packetOf();
  return { ...packet, ...top, untrusted: { ...(packet["untrusted"] as object), ...untrusted } };
}

const readPacket = (user: string, key: string) => sendApi(install, tokenOf(user), "GET", `/api/v1/requests/${key}/packet`);

function addRevision(user: string, key: string, packet: unknown, ifMatch?: string) {
  return sendApi(install, tokenOf(user), "POST", `/api/v1/requests/${key}/packet/revisions`, {
    body: { packet },
    ...(ifMatch === undefined ? {} : { headers: { "if-match": ifMatch } }),
  });
}

/** The request's revisions and the events about it, which a refused write leaves as they were. */
async function stateOf(requestId: string): Promise<unknown> {
  const { rows } = await install.owner.query(
    `SELECT (SELECT count(*) FROM packet_revisions WHERE request_id = $1) AS revisions,
            (SELECT count(*) FROM events WHERE data->>'requestId' = $1::text) AS events`,
    [requestId],
  );
  return rows[0];
}

/** Brings the request's packet to this revision, as its requester. */
async function reachRevision(key: string, revision: number): Promise<void> {
  for (let next = 2; next <= revision; next += 1) {
    const added = await addRevision(alice, key, packetWith({ links: [{ url: `https://wiki.example.com/r${next}` }] }), `"${next - 1}"`);
    expect(added.status).toBe(200);
  }
}

describe("reading a packet", () => {
  it("answers with the ETag of its current revision, and of the revision read by its number", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const read = await readPacket(alice, opened.key);
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"1"');
    await reachRevision(opened.key, 3);
    expect((await readPacket(bob, opened.key)).headers.get("etag")).toBe('"3"');
    const first = await sendApi(install, tokenOf(bob), "GET", `/api/v1/requests/${opened.key}/packet/revisions/1`);
    expect(first.headers.get("etag")).toBe('"1"');
  });
});

describe("adding a revision", () => {
  it("adds the next revision for the requester with the current revision's ETag, and answers with the new ETag", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const changed = packetWith({ acceptance_criteria: ["The toggle is on the settings page."] });
    const added = await addRevision(alice, opened.key, changed, '"1"');
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ request: { id: opened.id, key: opened.key }, revision: 2, createdAt: expect.any(String), packet: changed });
    expect(added.headers.get("etag")).toBe('"2"');
    expect((await readPacket(alice, opened.key)).body).toEqual(added.body);
  });

  it("lets any member of the requesting team add one, and records the change as theirs for that team", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    expect((await addRevision(ayse, opened.key, packetWith({ links: [{ url: "https://wiki.example.com/dark" }] }), '"1"')).status).toBe(200);
    const { rows } = await install.owner.query(
      "SELECT type, data, actor_kind, actor_user_id, surface FROM events WHERE data->>'requestId' = $1 ORDER BY number DESC LIMIT 1",
      [opened.id],
    );
    expect(rows).toEqual([
      { type: "request.packet_revised", data: { requestId: opened.id, revision: 2 }, actor_kind: "agent", actor_user_id: ayse, surface: "api" },
    ]);
    const stored = await install.owner.query("SELECT actor_user_id, team_id FROM packet_revisions WHERE request_id = $1 AND number = 2", [opened.id]);
    expect(stored.rows).toEqual([{ actor_user_id: ayse, team_id: opened.requester.team.id }]);
  });

  it("gets 428 without If-Match, even when the body names a revision, and adds nothing", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    await reachRevision(opened.key, 3);
    const before = await stateOf(opened.id);
    const answer = await addRevision(alice, opened.key, packetWith({ acceptance_criteria: ["Changed."] }));
    expect(answer.status).toBe(428);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/if-match-required", status: 428 });
    const smuggled = await sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${opened.key}/packet/revisions`, {
      body: { packet: packetWith({ acceptance_criteria: ["Changed."] }), expectedRevision: 3 },
    });
    expect(smuggled.status).toBe(428);
    expect(await stateOf(opened.id)).toEqual(before);
    expect((await readPacket(alice, opened.key)).body.revision).toBe(3);
  });

  it("gives the second of two writers at revision 3 a 412, and the packet stays at revision 4", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    await reachRevision(opened.key, 3);
    const etag = (await readPacket(alice, opened.key)).headers.get("etag") ?? "";
    expect(etag).toBe('"3"');
    const first = await addRevision(alice, opened.key, packetWith({ acceptance_criteria: ["First writer."] }), etag);
    expect(first.status).toBe(200);
    const before = await stateOf(opened.id);
    const second = await addRevision(ayse, opened.key, packetWith({ acceptance_criteria: ["Second writer."] }), etag);
    expect(second.status).toBe(412);
    expect(second.body).toMatchObject({ type: "https://tiehall.com/problems/precondition-failed", status: 412 });
    expect(await stateOf(opened.id)).toEqual(before);
    const current = await readPacket(alice, opened.key);
    expect(current.body).toMatchObject({ revision: 4, packet: { untrusted: { acceptance_criteria: ["First writer."] } } });
  });

  it("lets only one of two writers at the same revision through when they write at once", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    await reachRevision(opened.key, 3);
    const answers = await Promise.all([
      addRevision(alice, opened.key, packetWith({ links: [{ url: "https://wiki.example.com/a" }] }), '"3"'),
      addRevision(ayse, opened.key, packetWith({ links: [{ url: "https://wiki.example.com/b" }] }), '"3"'),
    ]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 412]);
    expect((await readPacket(alice, opened.key)).body.revision).toBe(4);
  });

  it.each([["W/\"1\""], ["*"], ["1"], ['"1", "2"'], ['"one"'], ['"0"']])("gets 412 for If-Match: %s, which names no current revision, and adds nothing", async (ifMatch) => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const before = await stateOf(opened.id);
    const answer = await addRevision(alice, opened.key, packetWith({ links: [{ url: "https://wiki.example.com/x" }] }), ifMatch);
    expect(answer.status).toBe(412);
    expect(await stateOf(opened.id)).toEqual(before);
  });

  it.each([
    ["a member of the target team", () => bob],
    ["a member of a third team", () => carol],
  ])("gets 403 for %s, and adds nothing", async (_who, who) => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const before = await stateOf(opened.id);
    const answer = await addRevision(who(), opened.key, packetWith({ acceptance_criteria: ["Theirs."] }), '"1"');
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/forbidden" });
    expect(await stateOf(opened.id)).toEqual(before);
  });

  it("gets 404 for a request that does not exist", async () => {
    expect((await addRevision(alice, "FE-9999", packetOf(), '"1"')).status).toBe(404);
  });
});

describe("what a revision may change", () => {
  it("adds a scope change at once while the request is unclaimed", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const answer = await addRevision(alice, opened.key, packetWith({ need: "A different need.", acceptance_criteria: ["New."] }), '"1"');
    expect(answer.status).toBe(200);
  });

  it("adds a change outside the scope while the request is claimed", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${opened.key}/claim`)).status).toBe(200);
    const answer = await addRevision(alice, opened.key, packetWith({ links: [{ url: "https://wiki.example.com/more" }], code_refs: [{ repository: "acme/web" }] }), '"1"');
    expect(answer.status).toBe(200);
  });

  it.each([
    ["the need", { need: "A different need." }],
    ["the acceptance criteria", { acceptance_criteria: ["Changed after the claim."] }],
    ["the contract section", { contract: (fixture("valid/contract-packet.json")["untrusted"] as Record<string, unknown>)["contract"] }],
  ])("refuses with 409 a change to %s while the request is claimed, until proposals come, and adds nothing", async (_what, change) => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    expect((await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${opened.key}/claim`)).status).toBe(200);
    const before = await stateOf(opened.id);
    const answer = await addRevision(alice, opened.key, packetWith(change), '"1"');
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ type: "https://tiehall.com/problems/conflict", detail: expect.stringMatching(/commitment/) });
    expect(await stateOf(opened.id)).toEqual(before);
  });

  it("refuses with 409 setting or moving the due date after the request was opened, until proposals come, and adds nothing", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE", packet: packetWith({}, { due_date: "2026-10-15" }) });
    const before = await stateOf(opened.id);
    for (const packet of [packetWith({}, { due_date: "2026-10-22" }), packetWith({})]) {
      const answer = await addRevision(alice, opened.key, packet, '"1"');
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ detail: expect.stringMatching(/due date/) });
    }
    expect(await stateOf(opened.id)).toEqual(before);
    expect((await addRevision(alice, opened.key, packetWith({ links: [{ url: "https://wiki.example.com/d" }] }, { due_date: "2026-10-15" }), '"1"')).status).toBe(200);
  });

  it("keeps the packet's kind: a contract-change packet without its contract section, or a change of kind, gets 400 and adds nothing", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE", packet: fixture("valid/contract-packet.json") });
    const before = await stateOf(opened.id);
    const withoutContract = await addRevision(alice, opened.key, fixture("invalid/contract-change-without-contract.json"), '"1"');
    expect(withoutContract.status).toBe(400);
    const asRequest = await addRevision(alice, opened.key, packetOf("No contract section any more."), '"1"');
    expect(asRequest.status).toBe(400);
    expect(asRequest.body).toMatchObject({ type: "https://tiehall.com/problems/invalid-input", detail: expect.stringMatching(/kind/) });
    expect(await stateOf(opened.id)).toEqual(before);
  });

  it("gets 400 for a known field of the wrong type, and adds nothing", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const before = await stateOf(opened.id);
    const answer = await addRevision(alice, opened.key, packetWith({ links: "https://wiki.example.com" }), '"1"');
    expect(answer.status).toBe(400);
    expect(await stateOf(opened.id)).toEqual(before);
  });
});

describe("validating a new revision", () => {
  it("makes no connection but to the install's own database", async () => {
    const opened = await openRequestInTheWebUi(install, alice, { targetTeam: "FE" });
    const attempts: string[] = [];
    const connect = net.Socket.prototype.connect;
    const fetch = globalThis.fetch;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      const [first] = args as [{ host?: string; port?: number | string } | undefined];
      attempts.push(`${first?.host ?? ""}:${String(first?.port ?? "")}`);
      return (connect as (...parameters: unknown[]) => net.Socket).apply(this, args);
    } as typeof connect;
    globalThis.fetch = async (input, init) => {
      attempts.push(`fetch ${String(input instanceof Request ? input.url : input)}`);
      return fetch(input, init);
    };
    let status: number;
    try {
      status = (await addRevision(alice, opened.key, fixture("valid/extensions.json"), '"1"')).status;
    } finally {
      net.Socket.prototype.connect = connect;
      globalThis.fetch = fetch;
    }
    expect(status).toBe(200);
    for (const attempt of attempts) expect(attempt).toBe(`${install.owner.host}:${install.owner.port}`);
  });
});
