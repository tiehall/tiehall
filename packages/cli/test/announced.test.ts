import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { announce } from "../src/announced.ts";
import { hookInput, INSTALL, manualClock, saveLogin, startCli, stubInstall, type ManualClock, type Running, type StubInstall } from "./support/hooks.ts";

// News is announced once (requester-loop: News is announced once;
// requester-loop: The hooks read with the CLI's cursor and acknowledge
// nothing; design.md, Technical decisions: T15). The CLI keeps, on the user's
// machine, a mark of the updates it has announced, one per install: the
// number of the last update the SessionStart digest or a Stop-hook waiter has
// announced, in `announced.json` in its configuration folder, readable only by
// the user. Neither announces an update the mark holds, and each adds to it
// the updates it announces, before it announces them. The mark acknowledges
// nothing: an announced update stays in every pull reader until it is
// acknowledged. Another install's mark is its own, and signing in to an
// install again starts its mark anew, since the new login may be another
// user's.

const NET = "https://tiehall.example.net";
const MINUTE = 60_000;

let configDir: string;
let clock: ManualClock;
let install: StubInstall;
const running: Running[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tiehall-mark-"));
  clock = manualClock();
  install = stubInstall(clock);
  saveLogin(configDir, clock, INSTALL, 24 * 60 * MINUTE);
});

afterEach(async () => {
  for (const waiter of running.splice(0)) {
    if (!waiter.ended()) {
      await clock.advance(30 * MINUTE);
      await waiter.done;
    }
  }
  rmSync(configDir, { recursive: true, force: true });
});

function waiter(session = "session-1", fetch = install.fetch, args: string[] = []): Running {
  const started = startCli(["hook", "wait", ...args], { configDir, clock, fetch, stdin: hookInput(session) });
  running.push(started);
  return started;
}

function digest(session = "session-2", fetch = install.fetch, args: string[] = []) {
  return startCli(["hook", "session-start", ...args], { configDir, clock, fetch, stdin: hookInput(session, "SessionStart") }).done;
}

/** The mark of each install, as the CLI keeps it. */
function marks(): Record<string, { through: number }> {
  const file = join(configDir, "announced.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { installs: Record<string, { through: number }> }).installs : {};
}

describe("the waiter", () => {
  // requester-loop: News is announced once, "The next turn does not wake Claude again for the same news".
  it("does not wake Claude again for news it announced, which nobody acknowledged, and wakes it for the next", async () => {
    const first = waiter();
    await install.untilHolding();
    const question = install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    expect((await first.done).code).toBe(2);
    expect(marks()).toEqual({ [INSTALL]: { through: question.seq } });
    // The next turn ends: the install answers the new waiter at once with the question, which nobody acknowledged.
    const next = waiter();
    await install.untilHolding();
    const answered = install.calls.filter(({ path }) => path === "/api/v1/events/wait").slice(-2);
    expect(answered.map(({ query }) => query)).toEqual([{}, { cursor: String(question.seq) }]);
    await clock.advance(5 * MINUTE);
    expect(next.ended()).toBe(false);
    install.post({ type: "request.claimed", key: "FE-142", team: "FE" });
    const woken = await next.done;
    expect(woken.code).toBe(2);
    expect(woken.stderr).toContain("FE-142 request.claimed (team FE)");
    expect(woken.stderr).not.toContain("request.message_posted");
  });

  it("does not wake Claude for news the session's digest listed", async () => {
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    expect((await digest()).stdout).toContain("FE-142");
    const wait = waiter();
    await install.untilHolding();
    await clock.advance(3 * MINUTE);
    expect(wait.ended()).toBe(false);
  });

  it("starts from the CLI client's cursor when that is past the mark, as after an acknowledgement", async () => {
    const question = install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    expect((await digest()).stdout).toContain("FE-142");
    install.post({ type: "request.claimed", key: "FE-142", team: "FE" });
    install.cursor = question.seq + 1;
    const wait = waiter();
    await install.untilHolding();
    expect(install.calls.filter(({ path }) => path === "/api/v1/events/wait").map(({ query }) => query)).toEqual([{}]);
    install.post({ type: "request.status_changed", key: "FE-142", team: "FE" });
    expect((await wait.done).stderr).toContain("FE-142 request.status_changed (team FE)");
  });
});

describe("the digest", () => {
  // requester-loop: News is announced once, "A new session does not list announced news again".
  it("does not list news the waiter announced, which tiehall updates still lists until it is acknowledged", async () => {
    const wait = waiter();
    await install.untilHolding();
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    expect((await wait.done).code).toBe(2);
    expect(await digest("session-new")).toEqual({ code: 0, stdout: "", stderr: "" });
    const pulled = await startCli(["updates", "--json"], { configDir, clock, fetch: install.fetch }).done;
    expect(JSON.parse(pulled.stdout).events.map(({ request }: { request: { key: string } }) => request.key)).toEqual(["FE-142"]);
  });

  it("lists news once: a second session's digest lists only what came since", async () => {
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    expect((await digest("session-a")).stdout).toContain("FE-142");
    install.post({ type: "request.message_posted", key: "FE-143", team: "FE" });
    const second = await digest("session-b");
    expect(second.stdout).not.toContain("FE-142");
    expect(second.stdout).toContain("FE-143");
  });
});

// requester-loop: Claude Code SessionStart digest; requester-loop: News is announced once. The agent acknowledges
// through whats_new, whose cursor is its own, so the CLI client's cursor can stay behind more announced updates than
// the digest's page of 50 holds; the digest still lists the updates past the mark, reading them with the wait
// endpoint, which answers at once when updates come after the cursor it is given, and acknowledges nothing.
describe("the digest behind more announced updates than a page holds", () => {
  /** Posts this many updates, one per request, FE-1 onwards, and returns them. */
  function postMany(count: number) {
    return Array.from({ length: count }, (_, index) => install.post({ type: "request.message_posted", key: `FE-${index + 1}`, team: "FE" }));
  }

  /** Moves the mark to this number, as earlier hooks announcing up to it did. */
  async function announcedUpTo(through: number): Promise<void> {
    await announce(configDir, INSTALL, () => ({ through, picked: true }));
  }

  /** The lines of a digest that name an update. */
  const entries = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("FE-"));

  /** Resolves with the run's result, or "held" when it has not ended after a moment of real time. */
  function unlessHeld<T>(done: Promise<T>): Promise<T | "held"> {
    return Promise.race([done, new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 1_000))]);
  }

  it("lists the updates past the mark, and acknowledges nothing", async () => {
    const posted = postMany(55);
    await announcedUpTo(posted[51]!.seq);
    const printed = await digest();
    expect(printed.code).toBe(0);
    expect(entries(printed.stdout)).toEqual([53, 54, 55].map((number) => `FE-${number} request.message_posted (team FE) ${INSTALL}/FE-${number}`));
    expect(marks()).toEqual({ [INSTALL]: { through: posted[54]!.seq } });
    expect(install.cursor).toBe(0);
    expect(install.calls.filter(({ body }) => typeof body === "object" && body !== null && "acknowledge" in body)).toEqual([]);
  });

  it("lists, in the next session, the updates the first session's digest had no room for", async () => {
    postMany(55);
    const first = await digest("session-a");
    expect(entries(first.stdout)).toHaveLength(50);
    expect(first.stdout).toContain("More updates wait after these");
    const second = await digest("session-b");
    expect(entries(second.stdout)).toEqual([51, 52, 53, 54, 55].map((number) => `FE-${number} request.message_posted (team FE) ${INSTALL}/FE-${number}`));
    expect(second.stdout).not.toContain("More updates wait after these");
    expect(await digest("session-c")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("prints nothing, without holding the session's start, when nothing is new past the mark", async () => {
    const posted = postMany(55);
    await announcedUpTo(posted[54]!.seq);
    expect(await unlessHeld(digest())).toEqual({ code: 0, stdout: "", stderr: "" });
    const waits = install.calls.filter(({ path }) => path === "/api/v1/events/wait");
    expect(waits.map(({ query }) => query)).toEqual([{ cursor: String(posted[54]!.seq - 1) }]);
  });

  it("gives up after a moment, printing nothing, when the install holds its read past the mark", async () => {
    // The update the mark ends at is no longer one of the user's, as after they left a team, and nothing came after it.
    const posted = postMany(55);
    await announcedUpTo(posted[54]!.seq + 10);
    const run = startCli(["hook", "session-start"], { configDir, clock, fetch: install.fetch, stdin: hookInput("session-held", "SessionStart") });
    await install.untilHolding();
    await clock.advance(3_000);
    expect(await unlessHeld(run.done)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(install.holding()).toBe(0);
  });
});

describe("the mark", () => {
  // requester-loop: News is announced once, "Another install keeps its own mark".
  it("is one per install: an announcement on one install adds nothing to another's", async () => {
    const net = stubInstall(clock, NET);
    const both = (request: Request) => (new URL(request.url).origin === NET ? net.fetch(request) : install.fetch(request));
    const logins = JSON.parse(readFileSync(join(configDir, "logins.json"), "utf8")) as { logins: Record<string, unknown> };
    logins.logins[NET] = logins.logins[INSTALL];
    writeFileSync(join(configDir, "logins.json"), JSON.stringify(logins), { mode: 0o600 });
    // The same numbers on both installs: FE-142 of .com is announced; FE-142 of .net is news still.
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE", seq: 500 });
    net.post({ type: "request.message_posted", key: "FE-142", team: "FE", seq: 500 });
    expect((await digest("session-com", both, ["--install", INSTALL])).stdout).toContain(`${INSTALL}/FE-142`);
    expect(marks()).toEqual({ [INSTALL]: { through: 500 } });
    expect((await digest("session-net", both, ["--install", NET])).stdout).toContain(`${NET}/FE-142`);
    expect(marks()).toEqual({ [INSTALL]: { through: 500 }, [NET]: { through: 500 } });
  });

  it("is readable only by the user", async () => {
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    await digest();
    expect(statSync(join(configDir, "announced.json")).mode & 0o777).toBe(0o600);
  });

  it("starts anew when the user signs in to the install again, since the login may be another user's", async () => {
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    expect((await digest()).stdout).toContain("FE-142");
    const login = startCli(["login", INSTALL], { configDir, clock, fetch: install.fetch });
    await install.untilCalls(install.calls.length + 1);
    await clock.advance(5_000);
    expect((await login.done).code).toBe(0);
    expect(marks()).toEqual({});
    expect((await digest()).stdout).toContain("FE-142");
  });

  it("acknowledges nothing: the CLI client's cursor stays where it was", async () => {
    install.cursor = 3;
    install.post({ type: "request.message_posted", key: "FE-142", team: "FE" });
    await digest();
    const wait = waiter();
    await install.untilHolding();
    install.post({ type: "request.claimed", key: "FE-142", team: "FE" });
    expect((await wait.done).code).toBe(2);
    expect(install.cursor).toBe(3);
    expect(install.calls.filter(({ body }) => typeof body === "object" && body !== null && "acknowledge" in body)).toEqual([]);
  });
});
