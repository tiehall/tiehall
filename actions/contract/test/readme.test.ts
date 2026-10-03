import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Action's documentation (contract-changes: The Action reports to the
// install its workflow names; contract-changes: The contract Action; design.md,
// Self-hosting decisions: S9). It says where the runner must be: a workflow on
// a GitHub-hosted runner needs an install reachable from the internet, and a
// workflow for an install reachable only inside the company network runs on a
// self-hosted runner inside it. Its example pins the Action by commit SHA with
// the release as a comment, so dependency-update tools can bump it, and gives
// the job the OIDC token permission.

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The README's example workflow: its first yaml code block. */
const example = /```yaml\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";

describe("the Action's README", () => {
  it("says that a GitHub-hosted runner needs an install reachable from the internet", () => {
    expect(readme).toMatch(/GitHub-hosted runner[^.]*needs an install[^.]*reachable from the internet/);
  });

  it("says that a self-hosted runner inside the network reaches an install reachable only there", () => {
    expect(readme).toMatch(/reachable only inside[^.]*network[^.]*self-hosted runner inside/);
  });

  it("shows the Action pinned by a full commit SHA with the release as a comment", () => {
    expect(example).toMatch(/uses: [\w.-]+\/[\w.-]+\/actions\/contract@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(example).not.toMatch(/uses: [^\n]*actions\/contract@(?![0-9a-f]{40}\b)/);
  });

  it("runs on the pull_request types the Action reports, with the OIDC token permission and the install's URL", () => {
    expect(example).toMatch(/types: \[opened, synchronize, reopened, ready_for_review\]/);
    expect(example).toMatch(/id-token: write/);
    expect(example).toMatch(/install-url: https:\/\//);
    expect(example).toMatch(/fetch-depth: 0/);
  });

  // Runs of the Action for one API on one pull request write the same part of its comment: the newer push's run
  // cancels the older one rather than racing it (contract-changes: The provider PR's author is the requester).
  it("gives its example's job a concurrency group for the API on the pull request, which cancels the older run", () => {
    expect(example).toMatch(/\n {4}concurrency:\n {6}group: [^\n]*payments-api[^\n]*\$\{\{ github\.event\.pull_request\.number \}\}[^\n]*\n {6}cancel-in-progress: true\n/);
    expect(readme).toMatch(/concurrency group of its own on the pull request/);
  });

  it("pins every action of its example by commit SHA", () => {
    for (const [, uses] of example.matchAll(/uses: (\S+)/g)) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });
});
