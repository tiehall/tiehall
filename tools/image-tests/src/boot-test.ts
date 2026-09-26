// The self-host boot test (self-host-install: Compose runs Tiehall and
// Postgres). It boots deploy/compose.yaml, the file a self-hosting company
// runs, from a .env printed by the image's own init role, with the image in
// the all-in-one role against stock Postgres 17, waits until every service is
// up and healthy, and then asks /healthz itself. It exits 0 when the stack
// came up healthy and 1 when it did not, printing the stack's state and logs.
// It always tears the stack down.
// Usage: TIEHALL_IMAGE=<image> node tools/image-tests/src/boot-test.ts [override.yaml]...
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const folder = mkdtempSync(join(tmpdir(), "tiehall-boot-"));
const envFile = join(folder, ".env");

// The .env an operator writes: `docker run --rm <image> init --url <url> > .env`, unedited.
const init = spawnSync("docker", ["run", "--rm", "--network", "none", image, "init", "--url", "http://localhost:3000"], {
  encoding: "utf8",
  timeout: 120_000,
});
if (init.error) throw init.error;
if (init.status !== 0) {
  console.error(`init failed:\n${init.stderr}`);
  rmSync(folder, { recursive: true, force: true });
  process.exit(1);
}
writeFileSync(envFile, init.stdout, { mode: 0o600 });
console.log("Wrote .env with the image's init role, for http://localhost:3000.");

// Only the image under test, and a free host port for the app, override the .env; no other setting of the
// shell running the test reaches the stack.
const env: Record<string, string> = { TIEHALL_IMAGE: image, TIEHALL_HTTP_BIND: "127.0.0.1:0" };
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined && !name.startsWith("TIEHALL_") && !name.startsWith("COMPOSE_")) env[name] ??= value;
}
const files = [composeFile, ...overrides].flatMap((file) => ["--file", file]);

function compose(args: string[], options: { quiet?: boolean; timeoutSeconds?: number } = {}) {
  const run = spawnSync("docker", ["compose", "--project-name", project, "--env-file", envFile, ...files, ...args], {
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
    // The app's one published port, on the host's loopback address (self-host-install: `TIEHALL_URL` and TLS).
    const published = compose(["port", "app", "3000"], { quiet: true }).stdout.trim();
    const fromHost = /^127\.0\.0\.1:\d+$/.test(published)
      ? await fetch(`http://${published}/healthz`).then(
          async (response) => `${response.status} ${await response.text()}`,
          (error: unknown) => `no answer (${error instanceof Error ? error.message : String(error)})`,
        )
      : `not published on 127.0.0.1 (${published || "no port"})`;
    console.log(`migrate exited ${migrate}; /healthz answered ${answer}; on the host, ${published} answered ${fromHost}`);
    healthy = migrate === "0" && answer === '200 {"status":"up"}' && fromHost === '200 {"status":"up"}';
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
  rmSync(folder, { recursive: true, force: true });
}
process.exitCode = healthy ? 0 : 1;
