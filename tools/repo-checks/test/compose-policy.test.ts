import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The CI Compose policy check (task 2.10; operations: Releases are built once in
// CI and pulled by the servers; operations: Only the reverse proxy is
// reachable; operations: Secrets are never stored in plaintext). It runs the
// same script as the CI job against the real Compose files, alone and with
// fixture overrides layered on top.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-compose.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/compose/${name}.yaml`, import.meta.url));
const selfHost = "deploy/compose.yaml";
const saas = "deploy/compose.yaml,deploy/compose.saas.yaml";

function check(...stacks: string[]) {
  const args = stacks.flatMap((stack) => ["--stack", stack]);
  const run = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the Compose policy check", () => {
  it("fails a stack where the database publishes its port", () => {
    const run = check(`${saas},${fixture("publishes-database-port")}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("postgres: [ports-only-on-caddy] publishes 5432:5432");
  });

  it("fails a stack that gives a web server the backup passphrase", () => {
    const run = check(`${saas},${fixture("web-gets-backup-passphrase")}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("web-a: [app-secrets] receives backup_repo1_passphrase");
    expect(run.stderr).not.toContain("web-b:");
  });

  it("fails a stack where the worker publishes a port", () => {
    const run = check(`${saas},${fixture("worker-publishes-port")}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("worker: [ports-only-on-caddy] publishes 127.0.0.1:9229:9229");
  });

  it("fails a self-host app on the host network, or with the schema owner's password", () => {
    const hostNetwork = check(`${selfHost},${fixture("app-uses-host-network")}`);
    expect(hostNetwork.status).toBe(1);
    expect(hostNetwork.stderr).toContain("app: [ports-only-on-caddy] uses the host network");

    const ownerPassword = check(`${selfHost},${fixture("app-gets-owner-password")}`);
    expect(ownerPassword.status).toBe(1);
    expect(ownerPassword.stderr).toContain("app: [app-secrets] receives owner_database_password");
  });

  it("passes the real self-host file and the real production stack, which it checks by default", () => {
    const run = check();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("deploy/compose.yaml: ");
    expect(run.stdout).toContain("deploy/compose.yaml + deploy/compose.saas.yaml: ");
  });
});
