import { z } from "zod";
import { GitHubUnavailableError, pagesOf, type GitHubClient } from "./github-client.ts";
import { createLogger, type Logger } from "./log.ts";

// The App's webhook delivery log (tracker-mirrors: Failed GitHub deliveries
// are redelivered; tracker-mirrors: GitHub and Jira each run in webhook mode
// or polling mode; design.md, Self-hosting decisions: S9; design.md, Technical
// decisions: T16). GitHub lists every attempt to deliver an event to the App's
// webhook, newest first, to the App's own token (GET /app/hook/deliveries,
// paged by a cursor that GitHub's Link header carries): the attempt's own id,
// the delivery id that every attempt of one delivery shares, when GitHub made
// it, to the second, whether it was a redelivery, and the HTTP status GitHub
// got back. An attempt whose status is outside 200-299 failed: GitHub asks a
// receiver for a 2xx answer, and its own failures to connect carry a status
// outside that range too; spike 1.6 could not record their exact words. An App
// without a webhook has no delivery log, and GitHub answers a request for it
// with 404 (spike 1.6). GitHub redelivers an attempt on request (POST
// /app/hook/deliveries/{id}/attempts), keeping its delivery id, and answers at
// once, making the redelivery afterwards.

/** One attempt of a delivery, as GitHub's delivery log shows it. */
export interface DeliveryAttempt {
  /** GitHub's id of this attempt, which a redelivery is asked for by. */
  id: number;
  /** GitHub's X-GitHub-Delivery, the same on every attempt of one delivery. */
  deliveryId: string;
  /** When GitHub made the attempt, to the second. */
  deliveredAt: Date;
  redelivery: boolean;
  /** The HTTP status GitHub got back. */
  statusCode: number;
  /** GitHub's X-GitHub-Event, such as installation or pull_request. */
  event: string;
}

const ATTEMPT = z.looseObject({
  id: z.number().int().positive(),
  guid: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  delivered_at: z.iso.datetime({ offset: true }),
  redelivery: z.boolean(),
  status_code: z.number().int(),
  event: z.string(),
});

/** Whether an attempt failed: GitHub got back no 2xx status. */
export function attemptFailed(attempt: Pick<DeliveryAttempt, "statusCode">): boolean {
  return attempt.statusCode < 200 || attempt.statusCode > 299;
}

/**
 * Whether an attempt was made after the moment given, such as when the App's
 * credentials were stored. GitHub logs the time to the second, so an attempt
 * logged in the second of that moment may have come just before it, and is not
 * counted as after it.
 */
export function madeAfter(attempt: Pick<DeliveryAttempt, "deliveredAt">, moment: Date): boolean {
  return attempt.deliveredAt.getTime() >= moment.getTime();
}

/** How many attempts GitHub gives per page at most, which the reads ask for. */
const PER_PAGE = 100;

/** The HTTP status of a failed call to GitHub, or undefined when GitHub gave none. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * The attempts GitHub logged from `since` on, newest first, read page by page
 * until the log reaches older ones; undefined when the App has no delivery
 * log, as an App without a webhook has none. It throws GitHubUnavailableError
 * when a page GitHub answers with is not a list, such as a page a proxy
 * serves for GitHub, which says nothing of which deliveries failed.
 */
export async function readDeliveryLog(client: GitHubClient, since: Date, logger: Logger = createLogger()): Promise<DeliveryAttempt[] | undefined> {
  const attempts: DeliveryAttempt[] = [];
  try {
    for await (const page of pagesOf(client.app(), "GET /app/hook/deliveries", { per_page: PER_PAGE })) {
      if (!Array.isArray(page)) throw new GitHubUnavailableError("GitHub's answer to the read of the App's delivery log is not a list.");
      let older = false;
      for (const item of page) {
        const parsed = ATTEMPT.safeParse(item);
        if (!parsed.success) {
          logger.warn("github: an attempt in the App's delivery log is not in the form GitHub documents, so it is left out");
          continue;
        }
        const attempt: DeliveryAttempt = {
          id: parsed.data.id,
          deliveryId: parsed.data.guid,
          deliveredAt: new Date(parsed.data.delivered_at),
          redelivery: parsed.data.redelivery,
          statusCode: parsed.data.status_code,
          event: parsed.data.event,
        };
        if (attempt.deliveredAt.getTime() < since.getTime()) {
          older = true;
          continue;
        }
        attempts.push(attempt);
      }
      // The log runs newest first, so once it reaches older attempts, the rest are older too.
      if (older) break;
    }
  } catch (error) {
    if (statusOf(error) === 404) return undefined;
    throw error;
  }
  return attempts;
}

/** Asks GitHub to redeliver one attempt of a delivery; GitHub makes the redelivery afterwards, with the same delivery id. */
export async function askRedelivery(client: GitHubClient, attemptId: number): Promise<void> {
  await client.app().request("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: attemptId });
}
