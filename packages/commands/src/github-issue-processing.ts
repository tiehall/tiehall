import { recordTrackerChange } from "@tiehall/catalog";
import { githubApp, mirrors } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { GitHubEventProcessor } from "./github-delivery-processing.ts";
import { createGitHubIssues, MirrorPlaceUnavailableError } from "./github-issues.ts";
import type { TrackerAccount } from "./mirrors.ts";
import { withOrg } from "./with-org.ts";

// The processor of `issues` deliveries (tracker-mirrors: Mirror writes are
// idempotent and never echo; tracker-mirrors: Inbound tracker changes are
// recorded, not applied; tracker-mirrors: Tracker comments are not imported;
// design.md, Technical decisions: T16). A delivery about an issue of a
// connected installation's repository counts only when the issue is the mirror
// issue of a request, which Tiehall's mirrors name by the repository's id and
// the issue's number; every other issue is none of Tiehall's, and its delivery
// changes nothing. As for every delivery, Tiehall does not act on what the
// payload says happened: it reads the mirror issue from GitHub, with the token
// of the installation that covers its repository now, and records what the
// issue shows (mirrors.record_tracker_change), as the integration event from
// GitHub, acting for the member whose GitHub account made the change, while
// that account is a member's, and for no user otherwise (agent-access: Six
// kinds of caller; github-layer-hardening: design.md, Technical decisions:
// T7): for a close, the one GitHub names as having closed the issue; for a
// reopen or a change of the assignees, the sender of the delivery about that
// change; nobody for a change a delivery about another change shows, or one
// read without a delivery. When the read's state and its assignees were made
// by different accounts, each part is recorded on its own, for its account.
// What Tiehall wrote itself, or is writing, comes back this way too, as the
// App's bot: a label added or taken off, a close, the issue's opening. The
// read then shows what Tiehall knows the issue shows, or what its write under
// way will leave it showing, and nothing is added to the request; but a close
// or reopen GitHub says another account made, such as a person's close of an
// open issue, is never taken for Tiehall's own (a change of the close reason
// alone still names whoever closed the issue, so it is not told apart that
// way). Edits of an issue's title or body, and comments, which
// Tiehall's App does not even subscribe to, show nothing Tiehall reads back,
// so they change nothing either. The count of the mirror's state writes is
// taken before the issue is read, so a read that a write of Tiehall's overtook
// is told apart (tracker-changes.ts). A mirror issue whose repository no
// connected installation covers now is not read.

const ACCOUNT = z.looseObject({ id: z.number().int().positive(), login: z.string().min(1).max(100) });

const PAYLOAD = z.looseObject({
  repository: z.looseObject({ id: z.number().int().positive() }),
  issue: z.looseObject({ number: z.number().int().positive(), pull_request: z.unknown().optional() }),
  sender: ACCOUNT.optional(),
});

export const processIssuesEvent: GitHubEventProcessor = async (event, context) => {
  const payload = PAYLOAD.safeParse(event.payload);
  if (!payload.success || payload.data.issue.pull_request !== undefined) return;
  const target = String(payload.data.repository.id);
  const issue = String(payload.data.issue.number);
  const mirror = await withOrg(
    context.database,
    async ({ tx, orgId }) => {
      const [row] = await tx
        .select({ id: mirrors.id, stateWrites: mirrors.stateWrites })
        .from(mirrors)
        .where(and(eq(mirrors.orgId, orgId), eq(mirrors.tracker, "github"), eq(mirrors.target, target), eq(mirrors.issue, issue)));
      if (row === undefined) return undefined;
      const [app] = await tx.select({ slug: githubApp.slug }).from(githubApp).where(eq(githubApp.orgId, orgId));
      // The account GitHub shows the App's own writes as made by.
      return { ...row, bot: app === undefined ? undefined : `${app.slug}[bot]`.toLowerCase() };
    },
    { readOnly: true },
  );
  if (mirror === undefined) return;
  let now;
  try {
    now = await createGitHubIssues({ app: context.app, database: context.database }).readIssue(target, issue);
  } catch (error) {
    if (error instanceof MirrorPlaceUnavailableError) return;
    throw error;
  }
  // An issue GitHub no longer has shows nothing to record.
  if (now === undefined) return;
  const sender: TrackerAccount | null = payload.data.sender === undefined ? null : { id: String(payload.data.sender.id), login: payload.data.sender.login };
  // Who made each change the read can show, as GitHub names them: for a close, the account GitHub names as having closed
  // the issue; for a reopen, or a change of the assignees, the sender of the delivery about that change; nobody for a
  // change the delivery is not about, or one read without a delivery.
  const stateBy = now.open ? (event.action === "reopened" ? sender : null) : (now.closedBy ?? (event.action === "closed" ? sender : null));
  const assigneesBy = event.action === "assigned" || event.action === "unassigned" ? sender : null;
  // A state GitHub says another account made is no echo of a write of Tiehall's, even one GitHub never applied, when it
  // closes or reopens the issue (tracker-changes.ts).
  const stateByOther = stateBy !== null && mirror.bot !== undefined && stateBy.login.toLowerCase() !== mirror.bot;
  const record = (by: TrackerAccount | null, only?: "state" | "assignees") =>
    context.runAs(by === null ? undefined : { id: Number(by.id) }, recordTrackerChange.id, {
      mirrorId: mirror.id,
      issue: now,
      by,
      writesSeen: mirror.stateWrites,
      stateByOther,
      ...(only === undefined ? {} : { only }),
    });
  if (stateBy?.id === assigneesBy?.id) {
    await record(stateBy);
  } else {
    // Each part for the account that made it, the issue's state first.
    await record(stateBy, "state");
    await record(assigneesBy, "assignees");
  }
};
