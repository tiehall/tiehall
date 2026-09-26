import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "@tiehall/catalog";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, packetOf, sendApi, tokenOf } from "./support/requests.ts";

// The event log (requests: The event log; requests: Events carry ids, not
// bodies; design.md, Design rules: Requests and events; design.md, Technical
// decisions: T5). Every committed change to a request appends a domain event
// in the same transaction, through the write path, so an event exists if and
// only if its change committed: a change that fails, even at commit, leaves no
// event, and its request number is taken again by the next create. Events name
// requests and messages by id and never carry a message's text.

let install: TestInstall;
const team: Record<string, string> = {};
let alice: string;
let bob: string;

const CANARY = "canary-7Q2kX: ship the migration on Friday";

beforeAll(async () => {
  install = await startTestInstall();
  for (const name of ["BE", "FE"]) team[name] = await addTeam(install.owner, name);
  alice = await addUser(install.owner, { login: "alice" });
  bob = await addUser(install.owner, { login: "bob" });
  await joinTeams(install.owner, alice, team["BE"] ?? "");
  await joinTeams(install.owner, bob, team["FE"] ?? "");
});

afterAll(async () => {
  await install.close();
});

/** The events, requests and the teams' counts, to show that a failed change left none of them. */
async function everything() {
  const { rows } = await install.owner.query(
    `SELECT (SELECT coalesce(json_agg(e ORDER BY e.number), '[]') FROM events e) AS events,
            (SELECT count(*) FROM requests) AS requests,
            (SELECT count(*) FROM packet_revisions) AS revisions,
            (SELECT coalesce(json_agg(c ORDER BY c.team_id), '[]') FROM request_counters c) AS counters`,
  );
  return rows[0];
}

/** Makes the database refuse a request with this title, as the insert runs or as the transaction commits. */
async function refuseTitle(title: string, when: "insert" | "commit"): Promise<void> {
  await install.owner.query(`
    CREATE OR REPLACE FUNCTION probe_refuse_title() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.title = '${title}' THEN RAISE EXCEPTION 'probe: refused'; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS probe_refuse_title ON requests;
    ${
      when === "insert"
        ? "CREATE TRIGGER probe_refuse_title AFTER INSERT ON requests FOR EACH ROW EXECUTE FUNCTION probe_refuse_title();"
        : "CREATE CONSTRAINT TRIGGER probe_refuse_title AFTER INSERT ON requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_refuse_title();"
    }`);
}

describe("a failed create", () => {
  it.each(["insert", "commit"] as const)("leaves no event when it fails at the %s, and the next create takes its number", async (when) => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: `Before the ${when} failure` });
    await refuseTitle(`Fails at the ${when}`, when);
    const before = await everything();
    const answer = await callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", title: `Fails at the ${when}`, packet: packetOf() });
    expect(answer.status).toBe(500);
    expect(await everything()).toEqual(before);
    await install.owner.query("DROP TRIGGER probe_refuse_title ON requests");
    const next = await openRequest(install, tokenOf(alice), { targetTeam: "FE" });
    expect(Number(next.key.split("-")[1])).toBe(Number(opened.key.split("-")[1]) + 1);
  });
});

describe("a message event", () => {
  it("names the request and the message, and not the text", async () => {
    const opened = await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Plan the rollout" });
    const posted = await callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${opened.key}/messages`, {
      kind: "question",
      body: CANARY,
      blocking: false,
    });
    expect(posted.status).toBe(200);
    const edited = await callApi(install, tokenOf(bob), "POST", `/api/v1/messages/${posted.body.message.id}/versions`, { body: `${CANARY}, edited` });
    expect(edited.status).toBe(200);
    const { rows } = await install.owner.query<{ type: string; class: string; data: unknown }>(
      "SELECT type, class, data FROM events WHERE data->>'messageId' = $1 ORDER BY number",
      [posted.body.message.id],
    );
    expect(rows).toEqual([
      { type: "request.message_posted", class: "domain", data: { requestId: opened.id, messageId: posted.body.message.id, kind: "question", blocking: false } },
      { type: "request.message_edited", class: "domain", data: { requestId: opened.id, messageId: posted.body.message.id, version: 2 } },
    ]);
    const all = await install.owner.query("SELECT * FROM events");
    expect(JSON.stringify(all.rows)).not.toContain("canary-7Q2kX");
  });
});

describe("every request change so far", () => {
  // Each operation that changes a request, with a call that changes one; a new one fails this test until it is added.
  const WRITES: Record<string, (key: string) => Promise<{ status: number; body: any }>> = {
    "requests.create": async () => callApi(install, tokenOf(alice), "POST", "/api/v1/requests", { targetTeam: "FE", title: "Another one", packet: packetOf() }),
    "requests.claim": async (key) => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/claim`),
    "requests.set_status": async (key) => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/status`, { state: "in_progress" }),
    "requests.propose": async (key) => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/proposals`, { kind: "reassign", team: "BE" }),
    "messages.post": async (key) => callApi(install, tokenOf(bob), "POST", `/api/v1/requests/${key}/messages`, { kind: "question", body: "Blocking?", blocking: true }),
    "messages.edit": async (key) => {
      const [first] = (await callApi(install, tokenOf(bob), "GET", `/api/v1/requests/${key}`)).body.messages;
      return callApi(install, tokenOf(bob), "POST", `/api/v1/messages/${first.id}/versions`, { body: "Blocking, reworded?" });
    },
    "packets.add_revision": async (key) => {
      const etag = (await sendApi(install, tokenOf(alice), "GET", `/api/v1/requests/${key}/packet`)).headers.get("etag") ?? "";
      const packet = { ...packetOf(), untrusted: { ...(packetOf()["untrusted"] as object), links: [{ url: "https://wiki.example.com/more" }] } };
      return sendApi(install, tokenOf(alice), "POST", `/api/v1/requests/${key}/packet/revisions`, { body: { packet }, headers: { "if-match": etag } });
    },
  };

  it("covers every operation that writes to a request", () => {
    const writes = CATALOG.commands.filter(({ id, method }) => /^(requests|messages|packets)\./.test(id) && method !== undefined && method !== "GET");
    expect(writes.map(({ id }) => id).sort()).toEqual(Object.keys(WRITES).sort());
  });

  it("appends a domain event about the request in the same transaction as each change", async () => {
    const { key, id } = await openRequest(install, tokenOf(alice), { targetTeam: "FE", title: "Walk through every change" });
    for (const [operation, change] of Object.entries(WRITES)) {
      const before = Number((await install.owner.query<{ last: string }>("SELECT coalesce(max(number), 0) AS last FROM events")).rows[0]?.last);
      const answer = await change(key);
      // A commitment answers 202 with the proposal it became, whose creation is the change.
      expect(answer.status, operation).toBe(operation === "requests.propose" ? 202 : 200);
      const { rows } = await install.owner.query<{ class: string; request: string }>(
        "SELECT class, data->>'requestId' AS request FROM events WHERE number > $1 ORDER BY number",
        [before],
      );
      const changed = operation === "requests.create" ? answer.body.id : id;
      expect(rows.length, operation).toBeGreaterThan(0);
      expect(rows, operation).toEqual(rows.map(() => ({ class: "domain", request: changed })));
    }
  });
});
