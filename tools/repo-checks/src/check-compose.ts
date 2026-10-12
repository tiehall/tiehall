// CI check for the self-host Compose file (self-host-install: Tiehall's
// containers are confined; self-host-install: Only the migrate step holds the
// database owner's credentials; self-host-install: `TIEHALL_URL` and TLS):
// Postgres publishes no port, the app only one on 127.0.0.1 and only the
// caddy profile 80 and 443; only migrate receives the database owner's
// credentials; migrate and the app run confined, each with a memory limit and
// a process limit. It reads each stack the way
// Docker Compose runs it, with Caddy's profile on and stand-ins for the
// owner's credentials. By default it checks deploy/compose.yaml.
// Usage: node tools/repo-checks/src/check-compose.ts [--stack file1,file2,...]...
import { resolve } from "node:path";
import process from "node:process";
import { composeConfig } from "./compose.ts";
import { checkComposePolicy } from "./compose-policy.ts";

const DEFAULT_STACKS = [["deploy/compose.yaml"]];

const stacks: string[][] = [];
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument !== "--stack" || value === undefined) {
    console.error("Usage: check-compose.ts [--stack file1,file2,...]...");
    process.exit(2);
  }
  stacks.push(value.split(","));
  index++;
}

let failed = false;
for (const files of stacks.length > 0 ? stacks : DEFAULT_STACKS) {
  const label = files.join(" + ");
  const result = composeConfig(files.map((file) => resolve(file)), { profiles: ["caddy"] });
  if (result.model === undefined) {
    console.error(`${label}: docker compose config failed:\n${result.stderr}`);
    failed = true;
    continue;
  }
  const violations = checkComposePolicy(result.model);
  if (violations.length === 0) {
    console.log(
      `${label}: Postgres publishes no port, the app one port on 127.0.0.1 and only the caddy profile 80 and 443; ` +
        "only migrate receives the database owner's credentials; migrate and app run confined, with memory and process limits.",
    );
  }
  for (const { service, rule, detail } of violations) console.error(`${label}: ${service}: [${rule}] ${detail}`);
  failed ||= violations.length > 0;
}

if (failed) {
  console.error(
    "\nPostgres and migrate publish no port, the app publishes only on 127.0.0.1, and only the caddy profile " +
      "publishes 80 and 443. Only migrate may receive the database owner's credentials. migrate and the app run " +
      "as a non-root user, read-only, with a tmpfs /tmp, no capabilities and no-new-privileges, and each has a memory " +
      "limit and a process limit.",
  );
  process.exitCode = 1;
}
