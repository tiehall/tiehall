import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MINIMUM_PLUGIN_VERSION, MINIMUM_SKILL_VERSION } from "@tiehall/core";
import { repositoryFiles } from "../src/markdown.ts";
import { checkMarketplace, MARKETPLACE_FILE, marketplaceProblems, pluginSourceFolder } from "../src/marketplace.ts";
import { pluginProblems } from "../src/plugin.ts";

// The plugin, installable from the public repository through Claude Code's
// plugin marketplace mechanism (agent-surfaces: The Claude Code plugin;
// public-api: Client pieces are built from public source with provenance). The
// repository is a plugin marketplace: its root holds .claude-plugin/
// marketplace.json, which Claude Code reads when someone runs `claude plugin
// marketplace add <owner>/<repo>`, and which lists one plugin, tiehall, from
// the relative path ./packages/claude-plugin, so `claude plugin install
// tiehall@tiehall` installs the plugin from the repository's own files. The
// check holds the file to what Claude Code reads (the keys it knows, a name it
// can install from and that no official marketplace reserves, an owner, a
// relative source inside the repository that names the plugin's folder, an
// entry named as the plugin's manifest, and no version or component beside
// the manifest's), and the plugin there to the plugin check. The real install
// is the founder's step in a real Claude Code; the last test does what it
// does with the files a clone holds: it resolves the entry's source, copies
// the plugin's folder alone, as Claude Code copies a plugin into its cache,
// and runs the copy's hooks.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-plugin.ts", import.meta.url));
const plugin = join(root, "packages/claude-plugin");
const minimums = { plugin: MINIMUM_PLUGIN_VERSION, skill: MINIMUM_SKILL_VERSION };
const scratch = mkdtempSync(join(tmpdir(), "tiehall-marketplace-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const VALID = {
  name: "tiehall",
  description: "Tiehall's Claude Code plugin.",
  owner: { name: "The Tiehall maintainers" },
  plugins: [{ name: "tiehall", source: "./packages/claude-plugin", description: "Tiehall in Claude Code." }],
};

let made = 0;

/** A marketplace root in the scratch folder with this marketplace file, and a copy of the real plugin at packages/claude-plugin unless told not to. */
function marketplace(file: unknown, options: { plugin?: boolean } = {}): string {
  made += 1;
  const folder = join(scratch, `marketplace-${made}`);
  mkdirSync(join(folder, ".claude-plugin"), { recursive: true });
  writeFileSync(join(folder, MARKETPLACE_FILE), typeof file === "string" ? file : `${JSON.stringify(file, null, 2)}\n`);
  if (options.plugin !== false) {
    cpSync(plugin, join(folder, "packages/claude-plugin"), { recursive: true, filter: (source) => !source.includes("node_modules") });
  }
  return folder;
}

/** The valid marketplace file with these changes to its one plugin entry. */
function withEntry(changes: Record<string, unknown>): unknown {
  return { ...VALID, plugins: [{ ...VALID.plugins[0], ...changes }] };
}

describe("the marketplace check", () => {
  it("passes the repository's marketplace, which lists the plugin tiehall from ./packages/claude-plugin", () => {
    expect(marketplaceProblems(root, minimums)).toEqual([]);
    const report = checkMarketplace(root, minimums);
    expect(report.name).toBe("tiehall");
    expect(report.plugins).toEqual([{ name: "tiehall", source: "./packages/claude-plugin", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as unknown }]);
  });

  it("is part of pnpm check:plugin, which names the marketplace and the command that installs the plugin", () => {
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^The marketplace tiehall lists the plugin tiehall \d+\.\d+\.\d+ from \.\/packages\/claude-plugin: claude plugin install tiehall@tiehall\.$/m);
  });

  it("passes a valid marketplace", () => {
    expect(marketplaceProblems(marketplace(VALID), minimums)).toEqual([]);
  });

  it("fails without the marketplace file, or with one that is not a JSON object", () => {
    const folder = join(scratch, "none");
    mkdirSync(folder, { recursive: true });
    expect(marketplaceProblems(folder, minimums)).toEqual([
      ".claude-plugin/marketplace.json: is missing: it makes the repository a Claude Code plugin marketplace that lists the plugin.",
    ]);
    expect(marketplaceProblems(marketplace("{"), minimums)).toEqual([".claude-plugin/marketplace.json: is not JSON."]);
    expect(marketplaceProblems(marketplace("[]"), minimums)).toEqual([".claude-plugin/marketplace.json: is not a JSON object."]);
  });

  it("fails on a key Claude Code does not read, which it would ignore", () => {
    expect(marketplaceProblems(marketplace({ ...VALID, homepage: "https://example.com" }), minimums)).toEqual([
      ".claude-plugin/marketplace.json: has the key homepage, which a Claude Code marketplace file does not have.",
    ]);
    expect(marketplaceProblems(marketplace(withEntry({ minimumVersion: "0.1.0" })), minimums)).toEqual([
      ".claude-plugin/marketplace.json: plugins[0] has the key minimumVersion, which a Claude Code plugin entry does not have.",
    ]);
  });

  it("fails on a name Claude Code cannot install from, one an official marketplace reserves, or another than tiehall", () => {
    expect(marketplaceProblems(marketplace({ ...VALID, name: "tie hall" }), minimums)).toContain(
      '.claude-plugin/marketplace.json: names the marketplace "tie hall"; a marketplace name uses only letters, digits, ".", "_" and "-", starts with a letter or digit, and holds no "..".',
    );
    expect(marketplaceProblems(marketplace({ ...VALID, name: "claude-plugins-official" }), minimums)).toContain(
      '.claude-plugin/marketplace.json: names the marketplace "claude-plugins-official", which Claude Code reserves.',
    );
    expect(marketplaceProblems(marketplace({ ...VALID, name: "acme-tools" }), minimums)).toEqual([
      '.claude-plugin/marketplace.json: names the marketplace "acme-tools"; it is tiehall, so the plugin installs as tiehall@tiehall.',
    ]);
  });

  it("fails without an owner's name or a description", () => {
    const { owner: _owner, description: _description, ...bare } = VALID;
    expect(marketplaceProblems(marketplace({ ...bare, owner: { email: "maintainers@example.com" } }), minimums)).toEqual([
      ".claude-plugin/marketplace.json: names no owner; owner.name names who maintains the marketplace.",
      ".claude-plugin/marketplace.json: describes no marketplace; Claude Code shows the description to people who add it.",
    ]);
  });

  it("fails unless it lists exactly the plugin tiehall", () => {
    expect(marketplaceProblems(marketplace({ ...VALID, plugins: [] }), minimums)).toEqual([
      ".claude-plugin/marketplace.json: lists 0 plugins; it lists one, the plugin tiehall from ./packages/claude-plugin.",
    ]);
    expect(marketplaceProblems(marketplace({ ...VALID, plugins: [VALID.plugins[0], { ...VALID.plugins[0], name: "tiehall-2" }] }), minimums)).toContain(
      ".claude-plugin/marketplace.json: lists 2 plugins; it lists one, the plugin tiehall from ./packages/claude-plugin.",
    );
  });

  it("fails on a source that is not a relative path inside the repository to the plugin's folder", () => {
    expect(marketplaceProblems(marketplace(withEntry({ source: "packages/claude-plugin" })), minimums)).toContain(
      '.claude-plugin/marketplace.json: plugins[0] takes the plugin from "packages/claude-plugin"; a relative source starts with "./" and is written from the repository\'s root.',
    );
    expect(marketplaceProblems(marketplace(withEntry({ source: "./packages/../packages/claude-plugin" })), minimums)).toContain(
      '.claude-plugin/marketplace.json: plugins[0] takes the plugin from "./packages/../packages/claude-plugin", which holds "..": Claude Code refuses a source that leaves the marketplace\'s root.',
    );
    expect(marketplaceProblems(marketplace(withEntry({ source: "./plugins/tiehall" })), minimums)).toContain(
      '.claude-plugin/marketplace.json: plugins[0] takes the plugin from "./plugins/tiehall", where no plugin is: the folder holds no .claude-plugin/plugin.json.',
    );
    expect(marketplaceProblems(marketplace(withEntry({ source: { source: "github", repo: "acme/tiehall" } })), minimums)).toContain(
      ".claude-plugin/marketplace.json: plugins[0] takes the plugin from another repository; it takes it from this one, ./packages/claude-plugin.",
    );
  });

  it("fails on an entry named otherwise than the plugin's manifest, so it would not install by the manifest's name", () => {
    expect(marketplaceProblems(marketplace(withEntry({ name: "tiehall-plugin" })), minimums)).toEqual([
      '.claude-plugin/marketplace.json: plugins[0] is named "tiehall-plugin", while the plugin\'s manifest names it "tiehall"; the two are the same.',
    ]);
  });

  it("fails on an entry that sets a version or components beside the plugin's manifest", () => {
    expect(marketplaceProblems(marketplace(withEntry({ version: "0.2.0" })), minimums)).toEqual([
      ".claude-plugin/marketplace.json: plugins[0] sets a version; the plugin's manifest states it, and Claude Code takes the manifest's.",
    ]);
    expect(marketplaceProblems(marketplace(withEntry({ hooks: { Stop: [] } })), minimums)).toEqual([
      ".claude-plugin/marketplace.json: plugins[0] declares hooks; the plugin's own files declare its components.",
    ]);
  });

  it("fails when the plugin it lists fails the plugin check", () => {
    const folder = marketplace(VALID);
    rmSync(join(folder, "packages/claude-plugin/.mcp.json"));
    expect(marketplaceProblems(folder, minimums)).toEqual(["packages/claude-plugin/.mcp.json: is missing."]);
  });
});

/** Every file and folder under a folder, relative to it, symbolic links included. */
function entriesUnder(folder: string, prefix = ""): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory() ? [name, ...entriesUnder(join(folder, entry.name), `${name}/`)] : [name];
  });
}

/** Runs a hook's command as Claude Code runs it: with sh, from the plugin's copy, with the hook's input on standard input. */
function runHook(command: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ session_id: "session-1", hook_event_name: "SessionStart" }));
  });
}

describe("installing the plugin from the repository", () => {
  it(
    "works from the files a clone holds: the entry's source resolves, and the plugin's folder, copied alone, passes and runs its hooks",
    async () => {
      // A clone holds the files git tracks, or would track once committed, and none it ignores.
      const clone = join(scratch, "clone");
      const files = [...repositoryFiles(root)].filter((file) => file.startsWith(".claude-plugin/") || file.startsWith("packages/claude-plugin/"));
      for (const file of files) {
        mkdirSync(dirname(join(clone, file)), { recursive: true });
        cpSync(join(root, file), join(clone, file), { verbatimSymlinks: true });
      }
      expect(marketplaceProblems(clone, minimums)).toEqual([]);
      const report = checkMarketplace(clone, minimums);
      const entry = report.plugins[0];
      if (entry === undefined) throw new Error("The marketplace lists no plugin.");

      // Claude Code copies the plugin's folder alone into its cache, as <marketplace>/<plugin>/<version>.
      const source = pluginSourceFolder(clone, entry.source);
      const cache = join(scratch, "cache", report.name ?? "", entry.name, entry.version);
      cpSync(source, cache, { recursive: true, verbatimSymlinks: true });
      expect(pluginProblems(cache, minimums)).toEqual([]);
      // No link leads out of the copy, and no lockfile makes Claude Code install the package's development dependencies.
      for (const name of entriesUnder(cache)) expect(lstatSync(join(cache, name)).isSymbolicLink(), name).toBe(false);
      for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "bun.lock"]) expect(existsSync(join(cache, lockfile)), lockfile).toBe(false);

      // The MCP connection goes to the install whose URL the user gives once.
      const mcp = JSON.parse(readFileSync(join(cache, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
      expect(mcp.mcpServers["tiehall"]?.url.replace("${TIEHALL_URL}", "https://tiehall.example.com")).toBe("https://tiehall.example.com/mcp");

      // Each hook runs tiehall hook <name> for that install, from the copy.
      const bin = join(scratch, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "tiehall"), "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
      chmodSync(join(bin, "tiehall"), 0o755);
      const hooks = JSON.parse(readFileSync(join(cache, "hooks/hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, CLAUDE_PLUGIN_ROOT: cache, TIEHALL_URL: "https://tiehall.example.com" };
      const ran: Record<string, string> = {};
      for (const [event, groups] of Object.entries(hooks.hooks)) {
        const command = groups[0]?.hooks[0]?.command ?? "";
        const result = await runHook(command, env);
        expect(result.code, event).toBe(0);
        ran[event] = result.stdout.trim();
      }
      expect(ran).toEqual({
        SessionStart: "hook session-start --install https://tiehall.example.com",
        Stop: "hook wait --install https://tiehall.example.com",
        SessionEnd: "hook session-end --install https://tiehall.example.com",
      });
    },
    60_000,
  );
});
