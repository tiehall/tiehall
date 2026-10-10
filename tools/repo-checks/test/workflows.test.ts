import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWorkflows, jobPermissions, type Violation } from "../src/workflows.ts";

// The CI check for self-host-install: Release pipeline integrity. It runs the
// same script as the CI job against committed fixture repositories and the
// real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-workflows.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/workflows/${name}/`, import.meta.url));

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

/** The violations of one rule, as "file#job: detail" lines. */
function violationsOf(violations: Violation[], rule: Violation["rule"]): string[] {
  return violations
    .filter((violation) => violation.rule === rule)
    .map(({ file, job, detail }) => `${file}${job === undefined ? "" : `#${job}`}: ${detail}`);
}

describe("the workflow check", () => {
  it("fails a workflow that references an action by tag", () => {
    const run = check(fixture("action-by-tag"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("actions/checkout@v7.0.1");
    expect(violationsOf(checkWorkflows(fixture("action-by-tag")), "action-not-pinned")).toEqual([
      "ci.yml#test: actions/checkout@v7.0.1",
      "ci.yml#test: actions/setup-node@v7",
    ]);
  });

  it("fails a workflow that references an action by branch, or by no ref at all", () => {
    expect(check(fixture("action-by-branch")).status).toBe(1);
    expect(violationsOf(checkWorkflows(fixture("action-by-branch")), "action-not-pinned")).toEqual([
      "ci.yml#test: actions/checkout@main",
      "ci.yml#test: actions/setup-node",
    ]);
  });

  it("fails an abbreviated commit SHA, a Docker action by tag and a reusable workflow by tag", () => {
    for (const [name, reference] of [
      ["abbreviated-sha", "actions/checkout@3d3c42e"],
      ["docker-by-tag", "docker://alpine:3.22"],
      ["reusable-by-tag", "octo-org/shared/.github/workflows/check.yml@v1"],
    ] as const) {
      expect(check(fixture(name)).status, name).toBe(1);
      expect(violationsOf(checkWorkflows(fixture(name)), "action-not-pinned").map((line) => line.split(": ")[1])).toEqual([
        reference,
      ]);
    }
  });

  it("fails a workflow and a job that do not declare their permissions", () => {
    const run = check(fixture("missing-permissions"));
    expect(run.status).toBe(1);
    const violations = checkWorkflows(fixture("missing-permissions"));
    expect(violationsOf(violations, "workflow-permissions")).toEqual([
      "ci.yml: declares no top-level permissions, so its jobs would get the repository default",
    ]);
    expect(violationsOf(violations, "job-permissions")).toEqual(["ci.yml#undeclared: declares no permissions"]);
  });

  it("fails write permissions that the pipeline policy does not list, and the write-all shorthand", () => {
    const run = check(fixture("write-permissions"));
    expect(run.status).toBe(1);
    const violations = checkWorkflows(fixture("write-permissions"));
    expect(violationsOf(violations, "workflow-permissions")).toEqual(["ci.yml: grants contents: write to every job"]);
    expect(violationsOf(violations, "job-permissions")).toEqual([
      'ci.yml#everything: uses the "write-all" shorthand instead of listing each permission',
    ]);
    expect(violationsOf(violations, "unlisted-write-permission")).toEqual([
      "ci.yml#build: id-token: write",
      "ci.yml#build: packages: write",
    ]);
  });

  it("fails a secret used by a job that the pipeline policy does not list, and inherited secrets", () => {
    const run = check(fixture("unlisted-secrets"));
    expect(run.status).toBe(1);
    expect(violationsOf(checkWorkflows(fixture("unlisted-secrets")), "unlisted-secret")).toEqual([
      "ci.yml#reuse: secrets: inherit",
      "ci.yml#scan: secrets.SCANNER_API_KEY",
    ]);
  });

  it("fails installs without the frozen lockfile, npm installs that run scripts, and packages run outside the lockfile", () => {
    const run = check(fixture("unsafe-installs"));
    expect(run.status).toBe(1);
    expect(violationsOf(checkWorkflows(fixture("unsafe-installs")), "unsafe-install")).toEqual([
      "ci.yml#test: npm install --global pnpm@12.6.0 (npm installs must pass --ignore-scripts)",
      "ci.yml#test: pnpm install (pnpm installs must pass --frozen-lockfile)",
      "ci.yml#test: pnpm i --prefer-offline (pnpm installs must pass --frozen-lockfile)",
      "ci.yml#test: npx renovate-config-validator (runs a package from outside the lockfile)",
      "ci.yml#test: pnpm dlx cowsay hi (runs a package from outside the lockfile)",
      "ci.yml#test: npm ci (npm installs must pass --ignore-scripts)",
    ]);
  });

  it("fails a pnpm configuration that lets every dependency run its install scripts", () => {
    const run = check(fixture("allow-all-builds"));
    expect(run.status).toBe(1);
    expect(violationsOf(checkWorkflows(fixture("allow-all-builds")), "install-scripts")).toEqual([
      "pnpm-workspace.yaml: dangerouslyAllowAllBuilds must not be true",
      "pnpm-workspace.yaml: strictDepBuilds must not be false",
    ]);
  });

  it("fails a job that holds a write permission and runs an action that is not GitHub's own or the repository's, a package manager, downloaded code or a container", () => {
    const run = check(fixture("third-party-in-write-job"));
    expect(run.status).toBe(1);
    const packages = "runs a package manager, and with it packages' code, in a job that can write";
    const downloads = "runs code it downloads in a job that can write";
    const builds = "builds an image from outside the repository's checkout, or with the job's secrets, host or privileges, in a job that can write";
    expect(violationsOf(checkWorkflows(fixture("third-party-in-write-job")), "third-party-in-write-job")).toEqual([
      "release.yml#docker: docker://alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "release.yml#in-container: container node:24.21.0-trixie-slim (runs the job's steps in a container in a job that can write)",
      "release.yml#in-container: service db, postgres:17 (runs a service container in a job that can write)",
      `release.yml#notes: npm install --global --ignore-scripts pnpm@12.6.0 (${packages})`,
      `release.yml#notes: pnpm install --frozen-lockfile --filter "@acme/release-tools..." (${packages})`,
      `release.yml#notes: version="$(pnpm --silent exec semver 1.3.0)" (${packages})`,
      `release.yml#notes: npm publish --provenance (${packages})`,
      "release.yml#notes: docker run --rm alpine:3.22 cat /etc/os-release (runs a container in a job that can write)",
      `release.yml#notes: sudo pip install awscli==1.40.0 (${packages})`,
      `release.yml#notes: bash -c "pnpm install --frozen-lockfile" (${packages})`,
      `release.yml#notes: sh -c 'npm ci --ignore-scripts' (${packages})`,
      `release.yml#notes: xargs npx --yes cowsay (${packages})`,
      "release.yml#notes: node_modules/.bin/semver 1.0.0 (runs a package's code from node_modules in a job that can write)",
      "release.yml#notes: node --import tsx tools/notes.ts (loads a package's module into node in a job that can write)",
      `release.yml#notes: NODE_OPTIONS="--require=ts-node/register" node tools/notes.ts (loads a package's module into node in a job that can write)`,
      "release.yml#notes: bash -c 'docker run --rm alpine:3.22 true' (runs a container in a job that can write)",
      `release.yml#notes: go run golang.org/x/tools/cmd/stringer@v0.30.0 -type=Kind (${packages})`,
      `release.yml#notes: cargo install ripgrep --locked (${packages})`,
      `release.yml#notes: gem install bundler:2.6.0 (${packages})`,
      `release.yml#notes: deno run npm:cowsay@1.6.0 hello (${packages})`,
      `release.yml#notes: curl -fsSL https://example.com/install.sh | bash (${downloads})`,
      `release.yml#notes: wget -qO- https://example.com/install.sh | sudo -E sh (${downloads})`,
      `release.yml#notes: bash -c "$(wget -qO- https://example.com/install.sh)" (${downloads})`,
      "release.yml#notes: docker exec tools-db psql -c 'select 1' (runs a container in a job that can write)",
      `release.yml#notes: docker build https://github.com/acme/tools.git (${builds})`,
      `release.yml#notes: docker buildx build --secret id=token,env=GITHUB_TOKEN --tag tools . (${builds})`,
      `release.yml#notes: buildx build -f - . (${builds})`,
      `release.yml#notes: docker --context remote build . (${builds})`,
      `release.yml#notes: pnpm install --frozen-lockfile (${packages})`,
      `release.yml#notes: pnpm install --frozen-lockfile (${packages})`,
      `release.yml#notes: pnpm install --frozen-lockfile (${packages})`,
      "release.yml#publish: docker/login-action@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "release.yml#reuse: octo-org/shared/.github/workflows/push.yml@3d3c42e5aac5ba805825da76410c181273ba90b1",
    ]);
    expect(run.stderr).toContain(`release.yml#notes: [third-party-in-write-job] pnpm install --frozen-lockfile --filter "@acme/release-tools..." (${packages})`);
  });

  it("passes pinned actions, declared permissions, listed writes and secrets, and safe installs", () => {
    expect(checkWorkflows(fixture("clean"))).toEqual([]);
    const run = check(fixture("clean"));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // The permission table shows which job holds which write permission.
    expect(run.stdout).toMatch(/ci\.yml#publish\s+contents: read, packages: write/);
    expect(run.stdout).toMatch(/called\.yml#called\s+\(none\)/);
  });

  it("passes on the real tree, where every job declares its permissions", () => {
    expect(checkWorkflows(repoRoot)).toEqual([]);
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ci.yml#test");
  });

  it("leaves packages: write to the build job, the release's writes to its push and release jobs, the OIDC token to the packet's publish job, and no write permission to any other job", () => {
    const writes = jobPermissions(repoRoot).flatMap(({ job, permissions }) =>
      Object.entries((permissions ?? {}) as Record<string, string>)
        .filter(([, level]) => level === "write")
        .map(([scope]) => `${job}: ${scope}`)
        .sort(),
    );
    expect(writes).toEqual([
      "build.yml#build: packages",
      "packet-package.yml#publish: id-token",
      "release.yml#push: attestations",
      "release.yml#push: id-token",
      "release.yml#push: packages",
      "release.yml#release: contents",
    ]);
  });
});
