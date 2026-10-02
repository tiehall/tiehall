import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { cliMachine, type CliMachine } from "./support/cli.ts";
import { changesOf } from "./support/contract.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { mcpPerson, type McpPerson } from "./support/mcp.ts";
import { packetOf } from "./support/requests.ts";

// tiehall contract diff against the install (contract-changes: Attaching a
// contract diff to a request by hand; agent-surfaces: CLI contract and hook
// commands; agent-access: OAuth scopes are coarse). Deniz, a member of PAY,
// runs the CLI in the payments repository, between two refs of the
// payments-api document, and attaches the classified result to FE-142, a
// request Deniz opened to FE, with the CLI's login, through the operation
// behind attach_contract_changes. The CLI runs in this process, signed in
// through the install's device flow; oasdiff on its PATH stands in for the
// pinned engine and prints what it recorded for the breaking pair of task
// 23.1.

const FIXTURES = fileURLToPath(new URL("../../../actions/contract/test/fixtures/oasdiff/", import.meta.url));

let harness: AgentAccessHarness;
let deniz: McpPerson;
let mehmet: McpPerson;
let scratch: string;
let repository: string;
let bin: string;

/** Runs git in a folder, and throws when it fails. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  harness = await startAgentAccess();
  deniz = await mcpPerson(harness, "deniz-pay", { teams: ["PAY"] });
  mehmet = await mcpPerson(harness, "mehmet-fe", { teams: ["FE"] });
  scratch = mkdtempSync(join(tmpdir(), "tiehall-cli-contract-diff-"));
  repository = join(scratch, "payments");
  mkdirSync(join(repository, "openapi"), { recursive: true });
  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "config", "user.name", "Deniz");
  git(repository, "config", "user.email", "deniz@acme.example");
  git(repository, "remote", "add", "origin", "git@github.com:acme/payments.git");
  copyFileSync(join(FIXTURES, "breaking", "base.yaml"), join(repository, "openapi", "payments.yaml"));
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--message", "The base");
  git(repository, "checkout", "--quiet", "-b", "new-payment-fields");
  copyFileSync(join(FIXTURES, "breaking", "revision.yaml"), join(repository, "openapi", "payments.yaml"));
  git(repository, "commit", "--quiet", "--all", "--message", "The change");
  bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "oasdiff"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "oasdiff version 1.32.1"; exit 0; fi\nif [ "$1" = "changelog" ]; then cat '${join(FIXTURES, "breaking", "changelog.json")}'; exit 0; fi\nexit 3\n`,
  );
  chmodSync(join(bin, "oasdiff"), 0o755);
}, 120_000);

afterAll(async () => {
  await harness?.close();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** A CLI of this person's, signed in through the device flow with these scopes. */
async function cliOf(person: McpPerson, scopes: readonly string[]): Promise<CliMachine> {
  const machine = cliMachine(harness);
  machine.saveLogin(URL_OF_INSTALL, await harness.signInCli(person, scopes));
  return machine;
}

/** Opens a request to FE from PAY with Deniz's agent; returns its key. */
async function openToFe(): Promise<string> {
  const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${deniz.token}` }, {
    targetTeam: "FE",
    title: "Move to the new payment fields",
    packet: packetOf("The payments API drops the amount field; move to the new one."),
  });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { key: string }).key;
}

/** The request's packet as it is now. */
async function packetNow(key: string): Promise<{ revision: number; packet: { untrusted: { contract?: Record<string, unknown> } } }> {
  return (await (await harness.api("GET", `/api/v1/requests/${key}/packet`, { authorization: `Bearer ${deniz.token}` })).json()) as never;
}

/** Runs `tiehall contract diff` in the repository, attaching to the request. */
function attach(machine: CliMachine, key: string) {
  return machine.run(
    ["contract", "diff", "--api", "payments-api", "--spec", "openapi/payments.yaml", "--base", "main", "--head", "new-payment-fields", "--attach", key, "--if-match", "1", "--pull-request", "310"],
    { cwd: repository, env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` } },
  );
}

describe("tiehall contract diff --attach", () => {
  it("attaches the classified diff to the request as the contract section of its packet's next revision", async () => {
    const key = await openToFe();
    const machine = await cliOf(deniz, ["requests:read", "requests:write", "contracts:report"]);

    const ran = await attach(machine, key);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(`The packet of ${key} is at revision 2 now`);
    const current = await packetNow(key);
    expect(current.revision).toBe(2);
    expect(current.packet.untrusted.contract).toMatchObject({
      api: "payments-api",
      base: { ref: "main", sha: git(repository, "rev-parse", "main") },
      head: { ref: "new-payment-fields", sha: git(repository, "rev-parse", "new-payment-fields") },
      engine: { name: "oasdiff", version: "1.32.1" },
      changes: changesOf("breaking"),
      provider_pr: { repository: "acme/payments", number: 310 },
      provider_status: "open",
    });
    machine.close();
  });

  it("prints the scope-change proposal an attachment to a claimed request becomes, and the packet keeps its revision", async () => {
    const key = await openToFe();
    expect((await harness.api("POST", `/api/v1/requests/${key}/claim`, { authorization: `Bearer ${mehmet.token}` })).status).toBe(200);
    const machine = await cliOf(deniz, ["requests:read", "requests:write", "contracts:report"]);

    const ran = await attach(machine, key);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(`change the scope of ${key}`);
    expect(ran.stdout).not.toContain("/confirm/");
    expect((await packetNow(key)).revision).toBe(1);
    machine.close();
  });

  it("is refused with 403 insufficient_scope for a login without contracts:report, and the packet is unchanged", async () => {
    const key = await openToFe();
    const machine = await cliOf(deniz, ["requests:read", "requests:write"]);

    const ran = await attach(machine, key);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("contracts:report");
    expect((await packetNow(key)).revision).toBe(1);
    machine.close();
  });
});
