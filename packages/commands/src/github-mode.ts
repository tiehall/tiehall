import { integrationSecrets } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// GitHub's mode (tracker-mirrors: GitHub and Jira each run in webhook mode or
// polling mode; design.md, Self-hosting decisions: S9). In webhook mode,
// changes reach Tiehall as deliveries to /webhooks/github, and failed
// deliveries are redelivered; in polling mode, Tiehall polls GitHub every 60
// seconds. The 15-minute reconciliation runs in both.

export const GITHUB_MODES = ["webhook", "polling"] as const;
export type GitHubMode = (typeof GITHUB_MODES)[number];

/**
 * GitHub's mode, read in the caller's transaction. Until the mode is kept as
 * a setting of its own, with the check of the App's delivery log and an
 * admin's switch, GitHub runs in webhook mode exactly when the App has a
 * webhook secret to verify deliveries with, and in polling mode otherwise.
 */
export async function githubModeOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<GitHubMode> {
  const [secret] = await tx
    .select({ name: integrationSecrets.name })
    .from(integrationSecrets)
    .where(and(eq(integrationSecrets.orgId, orgId), eq(integrationSecrets.name, "github_app.webhook_secret")));
  return secret === undefined ? "polling" : "webhook";
}
