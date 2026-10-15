import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Codex SessionStart snippet is not offered until it has been tested
// (requester-loop: Codex and other clients pull, "An untested snippet is not
// offered"; design.md, Decisions this change rests on: D8; design.md, Open
// Questions). Codex hooks cannot wake an idle session, so a SessionStart
// snippet is the only hook Tiehall may offer for Codex, and only once a run in
// a real Codex session has shown that it works (task 19.21, whose recorded run
// replaces this test). Until then neither the Claude Code plugin nor
// Tiehall's documentation offers one: no file of the plugin, and no
// documentation page, speaks of Codex and of a SessionStart hook together. A
// Codex agent pulls with whats_new meanwhile, as the skill teaches. The
// client-matrix log, docs/client-matrix/log.md, offers nothing: it records the
// maintainers' runs against real clients, Codex's and Claude Code's hooks
// among them, and will record task 19.21's own run.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
/** The maintainers' record of their runs against real clients, which offers no snippet. */
const CLIENT_MATRIX_LOG = "docs/client-matrix/log.md";

/** The committed files of the plugin and of Tiehall's documentation: every Markdown file but the plan's and the client-matrix log, and the docs pages. */
function offeringFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "--", "packages/claude-plugin", "*.md", "apps/web/app/docs"], { cwd: repoRoot, encoding: "utf8" });
  return listed
    .split("\n")
    .filter((file) => file !== "" && !file.startsWith("openspec/") && !file.startsWith(".claude/") && !file.includes("/test/") && file !== CLIENT_MATRIX_LOG);
}

const CODEX = /\bcodex\b/i;
const SESSION_START = /\bSessionStart\b|\bsession[_-]start\b/i;

describe("the Codex SessionStart snippet", () => {
  it("is offered by no file of the plugin and no documentation page, until a Codex session shows that it works", () => {
    const files = offeringFiles();
    expect(files).toEqual(expect.arrayContaining(["README.md", "packages/claude-plugin/skills/tiehall/SKILL.md", "packages/claude-plugin/hooks/hooks.json"]));
    const offering = files.filter((file) => {
      const text = readFileSync(join(repoRoot, file), "utf8");
      return CODEX.test(text) && SESSION_START.test(text);
    });
    expect(offering).toEqual([]);
  });

  it("leaves a Codex agent to pull: the skill tells it to call whats_new at the start of a session", () => {
    const skill = readFileSync(join(repoRoot, "packages/claude-plugin/skills/tiehall/SKILL.md"), "utf8").replace(/\s+/g, " ");
    expect(skill).toMatch(/such as Codex[^.]*, call `whats_new` at the start of every session/);
  });
});
