import { describe, expect, it } from "vitest";
import { mirrorRequest, processGitHubDelivery, reconcileGitHub, syncGitHubInstallations } from "../src/index.ts";

// A failing integration job moves to the dead-letter queue after 5 attempts
// over about an hour (design.md, Decisions this change rests on: D28 #83).
// The queue's backoff would spread the attempts at random, carrying the fifth
// one up to two hours past the first, so each next attempt comes a fixed 14
// minutes after the one before failed: the fifth comes 56 minutes after the
// first when each attempt fails at once, as the mirror job's do (mirror-jobs.ts).

describe("the integration jobs' attempts", () => {
  it.each([
    ["processing a GitHub delivery", processGitHubDelivery.type.settings],
    ["reconciling GitHub", reconcileGitHub.type.settings],
    ["syncing GitHub installations", syncGitHubInstallations.type.settings],
    ["a mirror job", mirrorRequest.settings],
  ])("are 5 for %s, a fixed 14 minutes apart", (_job, settings) => {
    expect(settings.retryLimit + 1).toBe(5);
    expect(settings.retryBackoff).toBe(false);
    expect(settings.retryDelaySeconds).toBe(14 * 60);
  });
});
