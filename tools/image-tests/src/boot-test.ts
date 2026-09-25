// The self-host boot test (operations: Production runs the self-host Compose
// file and image). It boots deploy/compose.yaml, the file a self-hosting
// customer runs, with the image in the all-in-one role against stock Postgres
// 17, waits until every service is up and healthy, and then asks /healthz
// itself. It exits 0 when the stack came up healthy and 1 when it did not,
// printing the stack's state and logs. It always tears the stack down.
// Usage: TIEHALL_IMAGE=<image> node tools/image-tests/src/boot-test.ts [override.yaml]...
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const composeFile = fileURLToPath(new URL("../../../deploy/compose.yaml", import.meta.url));
const image = process.env["TIEHALL_IMAGE"];
if (image === undefined || image === "") {
  console.error("Set TIEHALL_IMAGE to the image to boot.");
  process.exit(2);
}

const overrides = process.argv.slice(2).map((file) => resolve(file));
const project = `tiehall-boot-${randomBytes(4).toString("hex")}`;
const secrets = mkdtempSync(join(tmpdir(), "tiehall-boot-"));
// A fresh password for this run only; the containers read it as a file.
writeFileSync(join(secrets, "app_database_password"), `${randomBytes(24).toString("hex")}\n`);
chmodSync(join(secrets, "app_database_password"), 0o644);
chmodSync(secrets, 0o755);

const env = { ...process.env, TIEHALL_IMAGE: image, TIEHALL_SECRETS_DIR: secrets };
const files = [composeFile, ...overrides].flatMap((file) => ["--file", file]);

function compose(args: string[], options: { quiet?: boolean; timeoutSeconds?: number } = {}) {
  const run = spawnSync("docker", ["compose", "--project-name", project, ...files, ...args], {
    env,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : ["ignore", "inherit", "inherit"],
    timeout: (options.timeoutSeconds ?? 120) * 1000,
  });
  if (run.error) throw run.error;
  return run;
}

let healthy = false;
try {
  console.log(`Booting ${composeFile} (${project}) with ${image}`);
  const up = compose(["up", "--detach", "--wait", "--wait-timeout", "240"], { timeoutSeconds: 300 });
  if (up.status === 0) {
    const migrate = compose(["ps", "--all", "--format", "{{.ExitCode}}", "migrate"], { quiet: true }).stdout.trim();
    const probe = compose(
      [
        "exec",
        "-T",
        "app",
        "node",
        "--eval",
        'fetch("http://127.0.0.1:3000/healthz").then(async (r) => console.log(r.status, await r.text()))',
      ],
      { quiet: true },
    );
    const answer = probe.stdout.trim();
    console.log(`migrate exited ${migrate}; /healthz answered ${answer}`);
    healthy = migrate === "0" && answer === '200 {"status":"up"}';
  }
  if (!healthy) {
    compose(["ps", "--all"]);
    compose(["logs", "--no-color"]);
    console.error("\nThe self-host stack did not come up healthy.");
  } else {
    console.log("The self-host stack came up healthy.");
  }
} finally {
  compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], { quiet: true });
  rmSync(secrets, { recursive: true, force: true });
}
process.exitCode = healthy ? 0 : 1;
