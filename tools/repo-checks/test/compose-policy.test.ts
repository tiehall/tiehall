import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The CI Compose policy check (tasks 2.9, 3.1 and 5.4; self-host-install:
// Tiehall's containers are confined; self-host-install: Only the migrate step
// holds the database owner's credentials). It runs the same script as the CI
// job against the real Compose file, alone and with fixture overrides layered
// on top, each of which breaks one rule.

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

/** The violations the check reports for the real file with one fixture on top. */
function violations(name: string): string[] {
  const run = check(`${selfHost},${fixture(name)}`);
  expect(run.status, name).toBe(1);
  return run.stderr
    .split("\n")
    .filter((line) => line.startsWith(`${selfHost} + `))
    .map((line) => line.slice(line.indexOf(": ") + 2));
}

describe("the Compose policy check", () => {
  it("fails a stack where the database publishes its port", () => {
    expect(violations("publishes-database-port")).toEqual(["postgres: [ports] publishes 5432:5432; it may publish no port"]);
  });

  it("fails an app port on every interface instead of 127.0.0.1", () => {
    expect(violations("app-port-on-all-interfaces")).toEqual([
      "app: [ports] publishes 0.0.0.0:3000:3000; the app may publish only a port bound to 127.0.0.1",
    ]);
  });

  it("fails a service other than the caddy profile's that publishes 80 or 443, and a proxy outside its profile", () => {
    expect(violations("app-publishes-https")).toEqual([
      "app: [ports] publishes 127.0.0.1:443:3000; only the caddy profile publishes 80 and 443",
    ]);
    expect(violations("caddy-outside-its-profile")).toEqual([
      "caddy: [ports] publishes 80:80, 443:443 and 443:443/udp outside the caddy profile",
    ]);
  });

  it("fails an app on the host network", () => {
    expect(violations("app-uses-host-network")).toEqual(["app: [ports] uses the host network"]);
  });

  it("fails the owner's password given to the app, under any name or as a secret file", () => {
    expect(violations("app-gets-owner-password")).toEqual([
      "app: [owner-secrets] receives the database owner's password or URL; only migrate may",
    ]);
    expect(violations("app-gets-owner-secret-file")).toEqual([
      "app: [owner-secrets] receives the secret owner_database_password; only migrate may",
    ]);
  });

  it("fails an app that keeps its capabilities, and a migrate step that runs as root, writable and able to gain privileges", () => {
    expect(violations("app-keeps-capabilities")).toEqual(["app: [confined] does not drop every capability (cap_drop: ALL)"]);
    expect(violations("migrate-runs-as-root")).toEqual([
      "migrate: [confined] runs as root; set user to the image's unprivileged uid",
      "migrate: [confined] has a writable root filesystem (read_only: true)",
      "migrate: [confined] can gain privileges (security_opt: no-new-privileges:true)",
    ]);
  });

  it("passes the real self-host file, the only stack it checks by default", () => {
    const run = check();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual([
      "deploy/compose.yaml: Postgres publishes no port, the app one port on 127.0.0.1 and only the caddy profile 80 and 443; " +
        "only migrate receives the database owner's credentials; migrate and app run confined.",
    ]);
  });
});
