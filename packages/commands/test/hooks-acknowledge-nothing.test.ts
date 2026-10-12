import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { acknowledgeEverything, realSleep, signedInCli, type CliMachine, type CliRun } from "./support/cli.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, MODERN, mcpPerson, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// The hooks read with the CLI's cursor and acknowledge nothing
// (requester-loop: The hooks read with the CLI's cursor and acknowledge
// nothing; requests: Read cursors move only on acknowledgement; design.md,
// Decisions this change rests on: D28 #60; design.md, Technical decisions:
// T15). The CLI runs as the package `tiehall` exports it, against a
// Testcontainers-backed install, whose wait holds 1.5 seconds here. After the
// SessionStart digest has printed two updates and the Stop-hook waiter has
// exited with code 2 for a third, none of the user's read cursors has moved:
// `tiehall updates` still lists all three, and the agent's next whats_new
// includes the one that woke Claude. The agent acknowledges through whats_new
// or `tiehall updates`; once either has acknowledged them, the hooks, which
// read after the furthest cursor of the user's CLI and MCP clients, follow
// it, on another machine of the user's too, whose mark of the news announced
// is its own, while `tiehall updates` keeps the CLI's own place
// (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55
// (44); design.md, Technical decisions: T6).

const HOLD_MS = 1_500;

let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;
let laptop: CliMachine;
let desktop: CliMachine;

beforeAll(async () => {
  harness = await startAgentAccess({ wait: { holdMs: HOLD_MS } });
  sam = await mcpPerson(harness, "sam-be", { teams: ["BE"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  laptop = await signedInCli(harness, sam);
  desktop = await signedInCli(harness, sam);
}, 120_000);

afterAll(async () => {
  laptop?.close();
  desktop?.close();
  await harness?.close();
});

async function ask(key: string): Promise<void> {
  const result = await harness.install.web(dana.session).write("messages.post", { key, kind: "question", body: "Which browsers?" }, harness.install.fromThePage(dana.session));
  if (!result.ok) throw new Error(`messages.post answered ${JSON.stringify(result.problem)}`);
}

/** Every read cursor of Sam's, by reader: the CLI's, each agent client's and the web inbox's. */
async function cursors(): Promise<Record<string, number>> {
  const { rows } = await harness.install.owner.query<{ reader: string; acknowledged: string }>(
    "SELECT reader, acknowledged FROM read_cursors WHERE user_id = $1 ORDER BY reader",
    [sam.userId],
  );
  return Object.fromEntries(rows.map(({ reader, acknowledged }) => [reader, Number(acknowledged)]));
}

const hook = (event: string, session: string) => ({ stdin: JSON.stringify({ session_id: session, hook_event_name: event }), sleep: realSleep });
const digest = (machine: CliMachine, session: string): Promise<CliRun> => machine.run(["hook", "session-start"], hook("SessionStart", session));
const waitCalls = (machine: CliMachine) => machine.calls.filter(({ url }) => new URL(url).pathname === "/api/v1/events/wait").length;

async function untilWaited(machine: CliMachine, count: number): Promise<void> {
  const until = Date.now() + 30_000;
  while (waitCalls(machine) < count) {
    if (Date.now() > until) throw new Error("The waiter did not call the wait endpoint.");
    await realSleep(20);
  }
}

/** The numbers of the updates on this request that `tiehall updates` lists on the machine, which reads with the CLI's cursor. */
async function listed(machine: CliMachine, key: string): Promise<number[]> {
  const page = JSON.parse((await machine.run(["updates", "--json", "--limit", "50"])).stdout) as { events: { number: number; request: { key: string } }[] };
  return page.events.filter(({ request }) => request.key === key).map(({ number }) => number);
}

describe("the hooks", () => {
  // requester-loop: The hooks read with the CLI's cursor and acknowledge nothing, "The digest acknowledges nothing"
  // and "The waiter acknowledges nothing".
  it("move no read cursor: after the digest prints two updates and the waiter exits with code 2, every pull reader still has them", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    await acknowledgeEverything(laptop);
    const before = await cursors();
    expect(before["oauth:tiehall-cli"]).toBeGreaterThan(0);
    await ask(request.key);
    await ask(request.key);
    const printed = await digest(laptop, "session-1");
    expect(printed.stdout.split("\n").filter((line) => line.startsWith(request.key))).toHaveLength(2);
    const calls = waitCalls(laptop);
    const waiting = laptop.run(["hook", "wait"], hook("Stop", "session-1"));
    await untilWaited(laptop, calls + 2);
    await ask(request.key);
    const woken = await waiting;
    expect(woken.code).toBe(2);
    expect(woken.stderr).toContain(`${request.key} request.message_posted (team FE) ${URL_OF_INSTALL}/${request.key}`);
    // No read cursor of Sam's has moved, the CLI's included.
    expect(await cursors()).toEqual(before);
    // `tiehall updates` still lists all three, and the agent's next whats_new includes the one that woke Claude.
    const questions = await listed(laptop, request.key);
    expect(questions).toHaveLength(3);
    const client = await connectMcp(harness, { token: sam.token, version: MODERN });
    try {
      let found = false;
      let args: Record<string, unknown> = { limit: 50 };
      for (;;) {
        const read = await client.callTool({ name: "whats_new", arguments: args });
        const events = (read.structuredContent as { events: { number: number }[] }).events;
        if (events.length === 0) break;
        found ||= events.some(({ number }) => number === questions[2]);
        args = { limit: 50, acknowledge: Math.max(...events.map(({ number }) => number)) };
      }
      expect(found).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  // requester-loop: The hooks read with the CLI's cursor and acknowledge nothing, "The hooks follow the CLI's cursor".
  it("follow the CLI's cursor once tiehall updates has acknowledged, on another machine of the user's too", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    await acknowledgeEverything(laptop);
    await ask(request.key);
    await ask(request.key);
    const questions = await listed(laptop, request.key);
    expect(questions).toHaveLength(2);
    // The laptop acknowledges both through `tiehall updates`; the desktop, which announced nothing yet, lists neither.
    expect((await laptop.run(["updates", "--json", "--acknowledge", String(Math.max(...questions))])).code).toBe(0);
    expect(await digest(desktop, "session-desktop")).toEqual({ code: 0, stdout: "", stderr: "" });
    // Its waiter waits after the CLI's cursor too: it wakes for the next question alone.
    const calls = waitCalls(desktop);
    const waiting = desktop.run(["hook", "wait"], hook("Stop", "session-desktop"));
    await untilWaited(desktop, calls + 1);
    await realSleep(HOLD_MS / 2);
    await ask(request.key);
    const woken = await waiting;
    expect(woken.code).toBe(2);
    expect(woken.stderr.split("\n").filter((line) => line.startsWith(request.key))).toHaveLength(1);
    expect(waitCalls(desktop) - calls).toBeLessThanOrEqual(2);
  }, 60_000);

  // requester-loop: The hooks read with the CLI's cursor and acknowledge nothing, "The hooks follow an acknowledgement
  // through whats_new".
  it("follow an acknowledgement through whats_new: the digest and the waiter skip it, tiehall updates still lists it, and no cursor moves", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    await acknowledgeEverything(laptop);
    await ask(request.key);
    await ask(request.key);
    const questions = await listed(laptop, request.key);
    expect(questions).toHaveLength(2);
    // Sam's agent acknowledges the first question through whats_new.
    const client = await connectMcp(harness, { token: sam.token, version: MODERN });
    try {
      const acknowledged = await client.callTool({ name: "whats_new", arguments: { limit: 1, acknowledge: questions[0] } });
      expect(acknowledged.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    const before = await cursors();
    // A new machine of Sam's, whose mark holds nothing: its digest lists the second question alone.
    const phone = await signedInCli(harness, sam);
    try {
      const printed = await digest(phone, "session-phone");
      expect(printed.stdout.split("\n").filter((line) => line.startsWith(request.key))).toHaveLength(1);
      // Its waiter waits past both, and wakes for the next question alone.
      const calls = waitCalls(phone);
      const waiting = phone.run(["hook", "wait"], hook("Stop", "session-phone"));
      await untilWaited(phone, calls + 1);
      await realSleep(HOLD_MS / 2);
      await ask(request.key);
      const woken = await waiting;
      expect(woken.code).toBe(2);
      expect(woken.stderr.split("\n").filter((line) => line.startsWith(request.key))).toHaveLength(1);
      // No read cursor of Sam's has moved, and `tiehall updates`, on the CLI's own cursor, still lists both questions.
      expect(await cursors()).toEqual(before);
      expect((await listed(phone, request.key)).slice(0, 2)).toEqual(questions);
    } finally {
      phone.close();
    }
  }, 60_000);
});
