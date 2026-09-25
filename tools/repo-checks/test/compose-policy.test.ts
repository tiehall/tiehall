import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The CI Compose policy check (tasks 2.9 and 3.1; self-host-install: Tiehall's
// containers are confined; self-host-install: Only the migrate step holds the
// database owner's credentials). It runs the same script as the CI job against
// the real Compose file, alone and with fixture overrides layered on top.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-compose.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/compose/${name}.yaml`, import.meta.url));
const selfHost = "deploy/compose.yaml";

function check(...stacks: string[]) {
  const args = stacks.flatMap((stack) => ["--stack", stack]);
  const run = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the Compose policy check", () => {
  it("fails a stack where the database publishes its port", () => {
    const run = check(`${selfHost},${fixture("publishes-database-port")}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("postgres: [ports-only-on-caddy] publishes 5432:5432");
  });

  it("fails an app on the host network, or with the database owner's password", () => {
    const hostNetwork = check(`${selfHost},${fixture("app-uses-host-network")}`);
    expect(hostNetwork.status).toBe(1);
    expect(hostNetwork.stderr).toContain("app: [ports-only-on-caddy] uses the host network");

    const ownerPassword = check(`${selfHost},${fixture("app-gets-owner-password")}`);
    expect(ownerPassword.status).toBe(1);
    expect(ownerPassword.stderr).toContain("app: [app-secrets] receives owner_database_password");
  });

  it("passes the real self-host file, the only stack it checks by default", () => {
    const run = check();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual([
      "deploy/compose.yaml: only caddy publishes ports; the app receives only its own secrets.",
    ]);
  });
});
