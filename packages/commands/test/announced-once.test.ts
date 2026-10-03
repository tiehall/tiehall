import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { acknowledgeEverything, realSleep, signedInCli, type CliMachine, type CliRun } from "./support/cli.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, MODERN, mcpPerson, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// News is announced once, against the real handler (requester-loop: News is
// announced once; requester-loop: Claude Code Stop-hook waiter;
// requester-loop: Claude Code SessionStart digest; design.md, Technical
// decisions: T15). The CLI runs as the package `tiehall` exports it, signed in
// through the device flow to a Testcontainers-backed install, whose wait
// holds 1.5 seconds here. Once a waiter has woken Claude for a question, the
// waiter of the next turn does not wake it again for that question, which
// nobody acknowledged, and a new session's digest does not list it; the
// question still reaches every pull reader, `tiehall updates` and whats_new,
// until it is acknowledged.

const HOLD_MS = 1_500;

let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;
let samCli: CliMachine;

beforeAll(async () => {
  harness = await startAgentAccess({ wait: { holdMs: HOLD_MS } });
  sam = await mcpPerson(harness, "sam-be", { teams: ["BE"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  samCli = await signedInCli(harness, sam);
}, 120_000);

afterAll(async () => {
  samCli?.close();
  await harness?.close();
});

/** Posts a question as Dana, in the web UI; returns its update's number, as `tiehall updates` lists it. */
async function ask(key: string): Promise<void> {
  const result = await harness.install.web(dana.session).write("messages.post", { key, kind: "question", body: "Which browsers?" }, harness.install.fromThePage(dana.session));
  if (!result.ok) throw new Error(`messages.post answered ${JSON.stringify(result.problem)}`);
}

const hook = (event: string, session: string) => ({ stdin: JSON.stringify({ session_id: session, hook_event_name: event }), sleep: realSleep });

/** Starts `tiehall hook wait` on Sam's machine, as the Stop hook of this session runs it at the end of a turn. */
function waiter(session: string): { done: Promise<CliRun>; ended(): boolean } {
  let ended = false;
  const done = samCli.run(["hook", "wait"], hook("Stop", session)).then((run) => {
    ended = true;
    return run;
  });
  return { done, ended: () => ended };
}

const waits = () => samCli.calls.filter(({ url }) => new URL(url).pathname === "/api/v1/events/wait").length;

async function untilWaited(count: number): Promise<void> {
  const until = Date.now() + 30_000;
  while (waits() < count) {
    if (Date.now() > until) throw new Error("The waiter did not call the wait endpoint.");
    await realSleep(20);
  }
}

/** The numbers of the updates on this request that `tiehall updates` lists now, which reads with the CLI's cursor. */
async function listedByTheCli(key: string): Promise<number[]> {
  const page = JSON.parse((await samCli.run(["updates", "--json", "--limit", "50"])).stdout) as { events: { number: number; request: { key: string } }[] };
  return page.events.filter(({ request }) => request.key === key).map(({ number }) => number);
}

describe("news the waiter announced", () => {
  // requester-loop: News is announced once, "The next turn does not wake Claude again for the same news".
  it("does not wake Claude again at the next turn, and the next update does", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    await acknowledgeEverything(samCli);
    let calls = waits();
    const first = waiter("session-turns");
    await untilWaited(calls + 1);
    await ask(request.key);
    const woken = await first.done;
    expect(woken.code).toBe(2);
    expect(woken.stderr).toContain(`${request.key} request.message_posted (team FE) ${URL_OF_INSTALL}/${request.key}\n`);
    // Claude's turn ends without acknowledging the question: the next waiter waits past it.
    calls = waits();
    const next = waiter("session-turns");
    await untilWaited(calls + 2);
    await realSleep(HOLD_MS * 2);
    expect(next.ended()).toBe(false);
    await ask(request.key);
    const again = await next.done;
    expect(again.code).toBe(2);
    expect(again.stderr.split("\n").filter((line) => line.startsWith(request.key))).toHaveLength(1);
  }, 60_000);

  // requester-loop: News is announced once, "A new session does not list announced news again".
  it("is not listed by a new session's digest, and stays in tiehall updates and whats_new until it is acknowledged", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    await acknowledgeEverything(samCli);
    const calls = waits();
    const wait = waiter("session-old");
    await untilWaited(calls + 1);
    await ask(request.key);
    expect((await wait.done).code).toBe(2);
    const digest = await samCli.run(["hook", "session-start"], hook("SessionStart", "session-new"));
    expect(digest).toEqual({ code: 0, stdout: "", stderr: "" });
    // The pull readers still have it: the CLI's, and the agent's whats_new, with its own cursor.
    const [question] = await listedByTheCli(request.key);
    expect(question).toBeGreaterThan(0);
    const client = await connectMcp(harness, { token: sam.token, version: MODERN });
    try {
      let found = false;
      let args: Record<string, unknown> = { limit: 50 };
      for (;;) {
        const read = await client.callTool({ name: "whats_new", arguments: args });
        const events = (read.structuredContent as { events: { number: number }[] }).events;
        if (events.length === 0) break;
        found ||= events.some(({ number }) => number === question);
        args = { limit: 50, acknowledge: Math.max(...events.map(({ number }) => number)) };
      }
      expect(found).toBe(true);
    } finally {
      await client.close();
    }
    // Once acknowledged through tiehall updates, the CLI no longer lists it.
    expect((await samCli.run(["updates", "--json", "--acknowledge", String(question)])).code).toBe(0);
    expect(await listedByTheCli(request.key)).toEqual([]);
  }, 60_000);
});

// requester-loop: Claude Code SessionStart digest; requester-loop: News is announced once. The agent acknowledges
// through whats_new, whose cursor is its own, so the CLI client's cursor stays behind every update the hooks
// announced; once more of them wait after it than the digest's page of 50 holds, the next session's digest still
// lists the updates that were never announced.
describe("a digest behind more announced updates than a page holds", () => {
  it("lists, in the next session, the updates the first session's digest had no room for", async () => {
    await acknowledgeEverything(samCli);
    const keys: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      keys.push((await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" })).key);
    }
    const entries = (stdout: string) => stdout.split("\n").filter((line) => /^[A-Z][A-Z0-9]*-\d+ /.test(line));
    const first = await samCli.run(["hook", "session-start"], hook("SessionStart", "session-page-1"));
    expect(entries(first.stdout)).toHaveLength(50);
    expect(first.stdout).toContain("More updates wait after these");
    // The agent reads and acknowledges every update through whats_new, which leaves the CLI's cursor where it was.
    const client = await connectMcp(harness, { token: sam.token, version: MODERN });
    try {
      let args: Record<string, unknown> = { limit: 50 };
      for (;;) {
        const read = await client.callTool({ name: "whats_new", arguments: args });
        const events = (read.structuredContent as { events: { number: number }[] }).events;
        if (events.length === 0) break;
        args = { limit: 50, acknowledge: Math.max(...events.map(({ number }) => number)) };
      }
    } finally {
      await client.close();
    }
    const second = await samCli.run(["hook", "session-start"], hook("SessionStart", "session-page-2"));
    expect(second.code).toBe(0);
    const listed = [...entries(first.stdout), ...entries(second.stdout)];
    expect(new Set(listed).size).toBe(listed.length);
    for (const key of keys) expect(listed.some((line) => line.startsWith(`${key} request.opened (team FE) ${URL_OF_INSTALL}/${key}`)), key).toBe(true);
    expect(entries(second.stdout).at(-1)).toContain(keys.at(-1));
    expect(await samCli.run(["hook", "session-start"], hook("SessionStart", "session-page-3"))).toEqual({ code: 0, stdout: "", stderr: "" });
  }, 120_000);
});
