import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareVersions, MINIMUM_CLI_VERSION } from "@tiehall/core";
import { CLI_VERSION } from "tiehall";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { cliMachine, realSleep, signedInCli, type CliMachine } from "./support/cli.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { mcpPerson, PROBLEM, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// The CLI sends its version and the server keeps a minimum (public-api: The
// CLI sends its version and the server keeps a minimum; agent-surfaces: The
// Claude Code plugin; design.md, Decisions this change rests on: D28 #1,
// #63). Every call of the tiehall CLI names its version in the
// Tiehall-CLI-Version header, and /api/v1 answers a call from a CLI older
// than the install's minimum with 400 and the problem type upgrade-required,
// which says how to upgrade, before it runs anything, whoever calls: the
// hooks of the Claude Code plugin run the CLI, so the minimum also holds the
// plugin to the versions whose hooks work.

let harness: AgentAccessHarness;
let sam: McpPerson;
let dana: McpPerson;
let danaCli: CliMachine;

beforeAll(async () => {
  harness = await startAgentAccess();
  sam = await mcpPerson(harness, "sam-be", { teams: ["BE"] });
  dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
  danaCli = await signedInCli(harness, dana);
}, 120_000);

afterAll(async () => {
  danaCli?.close();
  await harness?.close();
});

/** A version below the install's minimum. */
function older(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.99`;
  return `${major - 1}.99.99`;
}

async function stored(key: string): Promise<{ state: string; claimant: string | null }> {
  const { rows } = await harness.install.owner.query(
    `SELECT r.state, r.claimant_user_id AS claimant FROM requests r JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id WHERE t.key || '-' || r.number = $1`,
    [key],
  );
  return rows[0];
}

describe("the CLI's version", () => {
  it("is at least the install's minimum, for the CLI this repository builds", () => {
    expect(compareVersions(CLI_VERSION, MINIMUM_CLI_VERSION)).toBeGreaterThanOrEqual(0);
  });

  it("rides in every call the CLI makes", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    const from = danaCli.calls.length;
    expect((await danaCli.run(["get", request.key])).code).toBe(0);
    const calls = danaCli.calls.slice(from);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ cliVersion }) => cliVersion === CLI_VERSION)).toBe(true);
  });
});

describe("a call from a CLI older than the minimum", () => {
  // public-api: The CLI sends its version and the server keeps a minimum, "An old CLI is told to upgrade".
  it("gets 400 upgrade-required with directions to upgrade, and the operation does not run", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    const headers = { authorization: `Bearer ${dana.token}`, "tiehall-cli-version": older(MINIMUM_CLI_VERSION) };
    const inbox = await harness.api("GET", "/api/v1/inbox", headers);
    expect(inbox.status).toBe(400);
    expect(inbox.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await inbox.json()) as { type: string; detail: string };
    expect(problem.type).toBe(`${PROBLEM}upgrade-required`);
    expect(problem.detail).toContain("npm install --global tiehall@latest");
    const claim = await harness.api("POST", `/api/v1/requests/${request.key}/claim`, headers);
    expect(claim.status).toBe(400);
    expect(await stored(request.key)).toEqual({ state: "open", claimant: null });
  });

  it("is told to upgrade before its token is looked at, and a path that serves nothing still gets 404", async () => {
    const version = older(MINIMUM_CLI_VERSION);
    expect((await harness.api("GET", "/api/v1/inbox", { "tiehall-cli-version": version })).status).toBe(400);
    expect((await harness.api("GET", "/api/v1/inbox", { authorization: "Bearer not-a-token", "tiehall-cli-version": version })).status).toBe(400);
    expect((await harness.api("GET", "/api/v1/nothing-here", { "tiehall-cli-version": version })).status).toBe(404);
  });

  it("is shown by the CLI as the problem it is, and changes nothing", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    const machine = await signedInCli(harness, dana);
    try {
      // The machine's calls leave with an older CLI's version, as an old CLI's would.
      machine.pretendVersion(older(MINIMUM_CLI_VERSION));
      const run = await machine.run(["claim", request.key]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("Upgrade required: This tiehall CLI is version");
      expect(run.stderr).toContain("npm install --global tiehall@latest");
      expect(await stored(request.key)).toEqual({ state: "open", claimant: null });
    } finally {
      machine.close();
    }
  });
});

// public-api: The CLI sends its version and the server keeps a minimum (decisions-from-groups-15-28: design.md,
// Decisions this change rests on: D55 (35)): the minimum is checked on /api/v1 alone. tiehall login goes through the
// authorization server's device flow, whose errors are OAuth's and which does not check the version, so a CLI older
// than the minimum signs in, here through the install's own device flow, and is told to upgrade at its first command.
describe("tiehall login from a CLI older than the minimum", () => {
  it("completes the device flow, and the CLI's first command gets upgrade-required", async () => {
    const machine = cliMachine(harness);
    try {
      const version = older(MINIMUM_CLI_VERSION);
      machine.pretendVersion(version);
      let approved = false;
      const login = await machine.run(["login", URL_OF_INSTALL], {
        sleep: async () => {
          if (approved) return;
          const code = /type this code: (\S+)/.exec(machine.printed())?.[1];
          if (code === undefined) throw new Error(`the CLI printed no code: ${machine.printed()}`);
          await harness.approveDevice(dana, code);
          approved = true;
        },
      });
      expect(login.code).toBe(0);
      expect(Object.keys(machine.logins())).toEqual([URL_OF_INSTALL]);
      const signIn = machine.calls.filter(({ url }) => url.startsWith(`${URL_OF_INSTALL}/api/auth/`));
      expect(signIn.length).toBeGreaterThan(1);
      expect(signIn.every(({ cliVersion }) => cliVersion === version)).toBe(true);

      const from = machine.calls.length;
      const first = await machine.run(["inbox"]);
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("Upgrade required: This tiehall CLI is version");
      expect(first.stderr).toContain("npm install --global tiehall@latest");
      expect(machine.calls.slice(from).map(({ url }) => new URL(url).pathname)).toEqual(["/api/v1/inbox"]);
    } finally {
      machine.close();
    }
  });
});

// agent-surfaces: The Claude Code plugin, "A hook runs an old CLI"; requester-loop: Claude Code SessionStart digest, "An
// old CLI asks for an upgrade"; requester-loop: Claude Code Stop-hook waiter, "An old CLI's waiter stays silent". The
// hooks run the CLI, so the minimum holds them too: the install refuses an old CLI's hooks with 400 upgrade-required,
// the digest prints no updates but one fixed line that asks to upgrade the CLI, and the waiter exits without code 2,
// without a word and without calling again (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (52)).
describe("the hooks of a CLI older than the minimum", () => {
  it("fetch no updates: the digest prints the line that asks to upgrade, and the waiter exits without code 2 after one call", async () => {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "BE" });
    const result = await harness.install.web(sam.session).write("messages.post", { key: request.key, kind: "comment", body: "For FE." }, harness.install.fromThePage(sam.session));
    expect(result.ok).toBe(true);
    const machine = await signedInCli(harness, dana);
    try {
      machine.pretendVersion(older(MINIMUM_CLI_VERSION));
      const input = (event: string) => ({ stdin: JSON.stringify({ session_id: "session-old", hook_event_name: event }), sleep: realSleep });
      expect(await machine.run(["hook", "session-start"], input("SessionStart"))).toEqual({ code: 0, stdout: `Tiehall: this tiehall CLI is older than the install supports, so it shows no updates. Run npm install --global tiehall@latest, then start a new session.\n`, stderr: "" });
      const from = machine.calls.length;
      expect(await machine.run(["hook", "wait"], input("Stop"))).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(machine.calls.slice(from).map(({ url }) => new URL(url).pathname)).toEqual(["/api/v1/events/wait"]);
      // The same calls from the CLI this repository builds read the updates.
      const current = await signedInCli(harness, dana);
      try {
        const digest = await current.run(["hook", "session-start"], input("SessionStart"));
        expect(digest.stdout).toContain(request.key);
      } finally {
        current.close();
      }
    } finally {
      machine.close();
    }
  });
});

describe("a call that names no CLI version", () => {
  it("is no CLI's, such as a script's with a token, and runs", async () => {
    expect((await harness.api("GET", "/api/v1/inbox", { authorization: `Bearer ${dana.token}` })).status).toBe(200);
  });

  it("names one the install cannot read, and gets 400 invalid-input", async () => {
    const answer = await harness.api("GET", "/api/v1/inbox", { authorization: `Bearer ${dana.token}`, "tiehall-cli-version": "the newest" });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { type: string }).type).toBe(`${PROBLEM}invalid-input`);
  });
});
