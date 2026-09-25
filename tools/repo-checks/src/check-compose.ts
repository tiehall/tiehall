// CI check for the self-host Compose file (self-host-install: Tiehall's
// containers are confined; self-host-install: Only the migrate step holds the
// database owner's credentials): only Caddy publishes ports, and the app
// receives only its own secrets. It reads each stack the way Docker Compose
// runs it, with Caddy's profile on. By default it checks deploy/compose.yaml.
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
    console.log(`${label}: only caddy publishes ports; the app receives only its own secrets.`);
  }
  for (const { service, rule, detail } of violations) console.error(`${label}: ${service}: [${rule}] ${detail}`);
  failed ||= violations.length > 0;
}

if (failed) {
  console.error(
    "\nOnly the reverse proxy may publish ports, and the app (the web and worker roles) may receive only " +
      "the app database password.",
  );
  process.exitCode = 1;
}
