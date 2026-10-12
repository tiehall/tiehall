import { describe, expect, it } from "vitest";
import { createActionsOidc, GITHUB_ACTIONS_ISSUER, type ActionsRun } from "../src/oidc.ts";

// The test issuer of GitHub Actions OIDC tokens (decisions-from-groups-15-28,
// D55 (61); design.md, Technical decisions: T8). It issues the pairs of `ref`
// and `job_workflow_ref` that GitHub issues: a push runs the workflow from the
// branch it pushed to, and a run for a pull request runs it from the pull
// request's merge ref, which both claims name.

const run: ActionsRun = { audience: "https://tiehall.example.com", repository: "acme/payments", repositoryId: 7001, repositoryOwnerId: 7000 };

/** The claims of a token, as its payload carries them. */
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("the test issuer of GitHub Actions OIDC tokens", () => {
  it("issues, by default, the claims of a push to main that runs contract.yml", () => {
    expect(claimsOf(createActionsOidc().token(run))).toMatchObject({
      iss: GITHUB_ACTIONS_ISSUER,
      sub: "repo:acme/payments:ref:refs/heads/main",
      event_name: "push",
      ref: "refs/heads/main",
      job_workflow_ref: "acme/payments/.github/workflows/contract.yml@refs/heads/main",
      workflow_ref: "acme/payments/.github/workflows/contract.yml@refs/heads/main",
    });
  });

  it("issues, for a run for a pull request, its merge ref in both ref and job_workflow_ref", () => {
    expect(claimsOf(createActionsOidc().token({ ...run, pullRequest: 310 }))).toMatchObject({
      sub: "repo:acme/payments:pull_request",
      event_name: "pull_request",
      ref: "refs/pull/310/merge",
      job_workflow_ref: "acme/payments/.github/workflows/contract.yml@refs/pull/310/merge",
      workflow_ref: "acme/payments/.github/workflows/contract.yml@refs/pull/310/merge",
    });
  });

  it("names the workflow file a run gives, and the ref of a job_workflow_ref given whole", () => {
    const oidc = createActionsOidc();
    expect(claimsOf(oidc.token({ ...run, workflow: ".github/workflows/nightly.yml" }))).toMatchObject({
      job_workflow_ref: "acme/payments/.github/workflows/nightly.yml@refs/heads/main",
    });
    expect(claimsOf(oidc.token({ ...run, jobWorkflowRef: "acme/payments/.github/workflows/release.yml@refs/tags/v1.4.0" }))).toMatchObject({
      ref: "refs/tags/v1.4.0",
      job_workflow_ref: "acme/payments/.github/workflows/release.yml@refs/tags/v1.4.0",
    });
  });
});
