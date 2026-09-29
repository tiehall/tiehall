import { createHash } from "node:crypto";
import { z } from "zod";

// The changes GitHub reports, as deliveries and polls name them alike
// (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// design.md, Self-hosting decisions: S9; design.md, Technical decisions: T16).
// A change can reach Tiehall twice: by a delivery and by the poll of polling
// mode, such as a delivery that arrives while GitHub runs in polling mode
// after a failed one, or a poll that runs just after an admin switched the
// mode. Both store the change with the same key, and the store keeps one row
// per key, so the change is handled once. A pull request's change is the pull
// request in a given state: its repository and number, and a digest of what
// Tiehall's processing reads of it (its state, merge and close times, title,
// body, branches, head commit, draft flag and update time). A delivery about a
// pull request in the state the poll finds it in is the same change; a
// delivery that carries a state the poll never saw is another one, handled on
// its own. The processing reads a pull request's state, not a delivery's
// action, which a change the poll found does not carry.

const PULL_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  state: z.string(),
  draft: z.boolean().optional(),
  title: z.string(),
  body: z.string().nullable().optional(),
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  updated_at: z.string(),
});

const REPOSITORY = z.looseObject({ id: z.number().int().positive() });

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The key of the change a pull request in this state is, or undefined when GitHub gave it in another form. */
export function pullRequestChangeKey(repositoryId: number, pullRequest: unknown): string | undefined {
  const parsed = PULL_REQUEST.safeParse(pullRequest);
  if (!parsed.success) return undefined;
  const pr = parsed.data;
  const state = [pr.state, pr.draft ?? false, pr.title, pr.body ?? null, pr.head.ref, pr.head.sha, pr.base.ref, pr.merged_at ?? null, pr.closed_at ?? null, pr.updated_at];
  return `pull_request:${repositoryId}:${pr.number}:${digest(JSON.stringify(state)).slice(0, 32)}`;
}

/** The key of the change a delivery reports, or undefined for a delivery whose change Tiehall does not compare, such as one about an installation. */
export function changeKeyOf(event: string, payload: Readonly<Record<string, unknown>>): string | undefined {
  if (event !== "pull_request") return undefined;
  const repository = REPOSITORY.safeParse(payload["repository"]);
  return repository.success ? pullRequestChangeKey(repository.data.id, payload["pull_request"]) : undefined;
}

/** The delivery id a poll stores a change it found under: the same for the same change, in the form of GitHub's delivery ids. */
export function polledDeliveryId(changeKey: string): string {
  return `poll-${digest(changeKey).slice(0, 48)}`;
}
