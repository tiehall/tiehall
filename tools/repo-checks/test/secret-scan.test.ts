import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The CI secret scan for self-host-install: Release pipeline integrity. It
// runs the same script as the CI job over scratch repositories whose history
// is built here, so no key, not even a fake one, is ever committed to this
// repository.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/scan-secrets.ts", import.meta.url));

function scan(repo: string, ...extra: string[]) {
  const run = spawnSync(process.execPath, [script, repo, ...extra], { encoding: "utf8" });
  if (run.error) throw run.error;
  return { status: run.status, output: run.stdout + run.stderr };
}

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

describe("the secret scan", { timeout: 120_000 }, () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-secret-scan-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function repository(name: string): string {
    const repo = join(scratch, name);
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "README.md"), "# A repository\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Start");
    return repo;
  }

  it("fails on a commit that holds a private key, even after a later commit deletes it", () => {
    const repo = repository("with-key");
    // A fake key, generated for this test only and never used anywhere.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", "deploy_key.pem"), pem);
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Add a deploy key");
    git(repo, "rm", "--quiet", "config/deploy_key.pem");
    git(repo, "commit", "--quiet", "-m", "Remove the deploy key");

    const result = scan(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("RuleID:      private-key");
    expect(result.output).toContain("config/deploy_key.pem");
    // The CI log never shows the secret itself.
    const body = pem.split("\n")[1] ?? "";
    expect(body.length).toBeGreaterThan(20);
    expect(result.output).not.toContain(body.slice(0, 20));
  });

  it("passes a history without secrets", () => {
    const result = scan(repository("clean"));
    expect(result.output).toContain("no leaks found");
    expect(result.status).toBe(0);
  });

  it("passes the history of this repository up to HEAD", () => {
    const result = scan(repoRoot, "--log-opts=HEAD");
    expect(result.output).toContain("no leaks found");
    expect(result.status).toBe(0);
  });
});
