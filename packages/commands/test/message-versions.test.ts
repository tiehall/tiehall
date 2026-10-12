import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";

// Messages are append-only (requests: Messages are append-only; design.md,
// Design rules: Requests and events). Editing a message adds its next version
// and never overwrites or removes an earlier one, so every version is stored,
// and reads back in the web UI, exactly as it was written, byte for byte;
// agents read it on /api/v1 without the invisible characters the agent view
// strips (agent-safety: Invisible characters are stripped from the agent
// view). Any member reads a message on its own, with every version, oldest
// first, and the request whose thread holds it (design.md, Decisions: D45
// (3)). Only the message's author edits it. The database holds to it too: the app role may only insert and read
// messages and their versions, and a trigger refuses every update and delete,
// whoever tries.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;
let carol: string;
let key: string;
let requestId: string;
let messageId: string;

/** A body that a normalizing, trimming or re-encoding store would change. */
const ORIGINAL = "  Café, café and ﬁ: \u{1F600}\u200B tab\there,\r\nCRLF and a trailing space \n";
const EDITED = "Café, with the question answered below.";

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE", "OPS"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  carol = await addUser(install.owner, { login: "carol" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
  await joinTeams(install.owner, carol, team["OPS"] ?? "");
  await install.owner.query("INSERT INTO request_counters (org_id, team_id, last_number) SELECT id, $1, 141 FROM orgs", [team["FE"]]);
  ({ key, id: requestId } = await openRequest(install, tokenOf(alice), { targetTeam: "FE" }));
  expect(key).toBe("FE-142");
  const posted = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/messages`, { kind: "comment", body: ORIGINAL });
  expect(posted.status).toBe(200);
  messageId = posted.body.message.id;
});

afterAll(async () => {
  await install.close();
});

const edit = (user: string, body: string, id = messageId) => callApi(install, tokenOf(user), "POST", `/api/v1/messages/${id}/versions`, { body });
const readMessage = async (id = messageId) => (await callApi(install, tokenOf(carol), "GET", `/api/v1/messages/${id}`)).body;
/** The message as a person reads it in the web UI, which leaves nothing out. */
const readInTheWebUi = async (id = messageId) => {
  const result = await install.web(sessionOf(carol)).read<{ versions: { untrusted: { body: string } }[] }>("messages.get", { messageId: id });
  if (!result.ok) throw new Error(`messages.get answered ${result.problem.status}`);
  return result.output;
};
/** The original body as agents read it: without its zero-width space and its carriage return (decisions-from-groups-15-28, D55 (36)), its tab kept. */
const ORIGINAL_FOR_AGENTS = ORIGINAL.replace("\u200B", "").replace("\r", "");

/** Every stored version's bytes, as the database holds them. */
async function storedVersions(): Promise<{ version: number; bytes: Buffer }[]> {
  const { rows } = await install.owner.query<{ version: number; bytes: Buffer }>(
    "SELECT version, convert_to(body, 'UTF8') AS bytes FROM message_versions WHERE message_id = $1 ORDER BY version",
    [messageId],
  );
  return rows;
}

describe("editing a message", () => {
  it("adds version 2, and version 1 reads back unchanged, byte for byte", async () => {
    const answer = await edit(bob, EDITED);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: messageId, version: 2, untrusted: { body: EDITED } });
    const read = await readMessage();
    expect(read.versions).toEqual([
      { version: 1, createdAt: expect.any(String), untrusted: { body: ORIGINAL_FOR_AGENTS } },
      { version: 2, createdAt: expect.any(String), untrusted: { body: EDITED } },
    ]);
    const shown = await readInTheWebUi();
    expect(Buffer.from(shown.versions[0]?.untrusted.body ?? "", "utf8").equals(Buffer.from(ORIGINAL, "utf8"))).toBe(true);
    expect(await storedVersions()).toEqual([
      { version: 1, bytes: Buffer.from(ORIGINAL, "utf8") },
      { version: 2, bytes: Buffer.from(EDITED, "utf8") },
    ]);
  });

  it("names the request whose thread holds it, by its id, its key and its target team", async () => {
    expect((await readMessage()).request).toEqual({ id: requestId, key: "FE-142", targetTeam: { id: team["FE"], key: "FE" } });
  });

  it("shows the latest version in the thread, with when it was edited", async () => {
    const [shown] = (await callApi(install, tokenOf(carol), "GET", `/api/v1/requests/${key}`)).body.messages;
    expect(shown).toMatchObject({ id: messageId, version: 2, editedAt: expect.any(String), untrusted: { body: EDITED } });
  });

  it("adds the next version on every edit, from the web UI too, and keeps all of them", async () => {
    const caller = sessionOf(bob);
    const result = await install.web(caller).write("messages.edit", { messageId, body: "Third wording." }, install.fromThePage(caller));
    expect(result).toMatchObject({ ok: true, output: { version: 3 } });
    expect((await readInTheWebUi()).versions.map(({ untrusted }) => untrusted.body)).toEqual([ORIGINAL, EDITED, "Third wording."]);
  });

  it("records an event that names the message and its version, and not its text", async () => {
    const { rows } = await install.owner.query<{ type: string; data: Record<string, unknown>; actor_user_id: string }>(
      "SELECT type, data, actor_user_id FROM events WHERE type = 'request.message_edited' ORDER BY number",
    );
    expect(rows.map(({ data, actor_user_id }) => ({ version: data["version"], messageId: data["messageId"], by: actor_user_id }))).toEqual([
      { version: 2, messageId, by: bob },
      { version: 3, messageId, by: bob },
    ]);
    expect(JSON.stringify(rows)).not.toContain("Third wording");
  });

  it.each([
    ["Alice, the requester, who did not write it", () => alice],
    ["Carol, a member of a third team", () => carol],
  ])("is refused with 403 for %s, and adds nothing", async (_name, who) => {
    const before = await storedVersions();
    const answer = await edit(who(), "Rewritten by someone else.");
    expect(answer).toEqual({ status: 403, body: expect.objectContaining({ type: "https://tiehall.com/problems/forbidden" }) });
    expect(await storedVersions()).toEqual(before);
  });

  it("gets 400 for a blank body and 404 for a message that does not exist, adding nothing", async () => {
    const before = await storedVersions();
    expect((await edit(bob, "   ")).status).toBe(400);
    expect((await edit(bob, "Hello.", "7a1f0c56-6ad1-4a3e-9b1c-3f0d8f2f2b11")).status).toBe(404);
    expect((await callApi(install, tokenOf(carol), "GET", "/api/v1/messages/7a1f0c56-6ad1-4a3e-9b1c-3f0d8f2f2b11")).status).toBe(404);
    expect(await storedVersions()).toEqual(before);
  });
});

describe("the stored thread", () => {
  /** The error a statement fails with, or undefined when it succeeds. */
  async function failureOf(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      return String((error as { cause?: Error }).cause?.message ?? (error as Error).message);
    }
  }

  it("cannot be rewritten or deleted by the app role, which may only insert and read it", async () => {
    for (const table of ["messages", "message_versions"]) {
      expect(await failureOf(() => install.db.execute(`UPDATE ${table} SET org_id = org_id`)), table).toMatch(/permission denied/);
      expect(await failureOf(() => install.db.execute(`DELETE FROM ${table}`)), table).toMatch(/permission denied/);
      expect(await failureOf(() => install.db.execute(`TRUNCATE ${table}`)), table).toMatch(/permission denied/);
    }
  });

  it("refuses every update and delete, even from the database owner", async () => {
    for (const statement of ["UPDATE message_versions SET body = 'rewritten'", "DELETE FROM message_versions", "UPDATE messages SET kind = 'comment'", "DELETE FROM messages", "TRUNCATE messages CASCADE"]) {
      expect(await failureOf(() => install.owner.query(statement)), statement).toMatch(/Messages are append-only/);
    }
    expect((await storedVersions())[0]).toEqual({ version: 1, bytes: Buffer.from(ORIGINAL, "utf8") });
  });
});
