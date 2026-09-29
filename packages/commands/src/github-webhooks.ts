import { createHmac, timingSafeEqual } from "node:crypto";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { githubApp, githubDeliveries, orgs, type Database } from "@tiehall/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { GITHUB_WEBHOOK_BODY_LIMIT, readBoundedBody } from "./body-limit.ts";
import { changeKeyOf } from "./github-changes.ts";
import { processDelivery } from "./github-delivery-processing.ts";
import { readSecret } from "./integration-secrets.ts";
import { defineJobType, type JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import type { SecretBox } from "./secret-box.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// GitHub's webhook deliveries at /webhooks/github (tracker-mirrors: GitHub
// webhooks are verified, deduplicated and processed in the background;
// self-host-install: The setup code guards the setup screen; design.md,
// Technical decisions: T16; github-app-reachability: design.md, Design rules:
// An App without a webhook).
//
// A delivery's body is read up to 25 MiB, which covers GitHub's own maximum of
// 25 MB, and a larger one is refused with the error model's 413 before more
// of it is read (public-api: Request bodies have a size limit; body-limit.ts);
// the web role's request guard refuses it first where it is installed. The
// delivery is then verified, against the webhook secret read in a short
// read-only query, before any write transaction opens: its
// X-Hub-Signature-256 must be the HMAC-SHA256 of its body under the App's
// webhook secret. One that does not verify gets 401 and is neither stored nor
// processed, and takes no lock, so a flood of unsigned posts holds up nothing. While no webhook secret is stored,
// as for an App created without a webhook until an admin stores one, every
// delivery fails verification, whatever it carries. A verified delivery is
// stored once by its delivery id, which GitHub keeps on a redelivery, and
// answered with 202; a delivery id seen before gets 202 again and nothing
// more. Its processing job is sent in the transaction that stores it, so the
// job runs, in the background, only for a delivery that was stored.
//
// The setup gate serves this route from the moment the setup screen has stored
// the App's credentials, before setup completes, so the delivery for the
// installation made during setup is not lost. A delivery about a change that
// the poll of polling mode stored already, such as a pull request in the same
// state, is answered with 202 and not stored again (github-changes.ts), so the
// change is handled once. A delivery that arrives before
// setup completes is stored and held, with no job; once setup completes, a job
// that runs every minute sends a processing job for each held delivery. The
// row lock the route takes on the org keeps the two apart: a delivery either
// sees setup complete and gets its job at once, or is held and committed
// before setup can complete, so the next run finds it.
//
// A delivery that verifies and is stored shows that GitHub's webhook reaches
// the install, so it clears a delivery the redelivery job gave up, and with it
// the banner about GitHub's webhook (tracker-mirrors: Broken integrations are
// surfaced; github-layer-hardening: design.md, Technical decisions: T8).
//
// The job processes the delivery through the table of connected
// installations, as the integration-event caller (github-delivery-
// processing.ts).

/** The route's answer to one request. */
export type GitHubWebhookRoute = (request: Request) => Promise<Response>;

export interface GitHubWebhookRouteOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** Opens the stored webhook secret: TIEHALL_SECRET_KEY's box, opened when first needed. */
  secrets: () => SecretBox;
  /** Sends a delivery's processing job inside the transaction that stores it. */
  jobs: JobSender;
  logger?: Logger;
}

/** A job that processes one stored delivery. */
export const processGitHubDelivery: WorkerJob<{ deliveryId: string }> = {
  // Five attempts over about an hour, then the dead-letter queue, as for every integration job (design.md, Decisions this change rests on: D28 #83).
  type: defineJobType<{ deliveryId: string }>("github.process_delivery", 1, {
    retryLimit: 4,
    retryDelaySeconds: 240,
    retryBackoff: true,
    expireInSeconds: 300,
  }),
  concurrency: 4,
  async handle(job, { database, now, github, execute }) {
    if (github === undefined || execute === undefined) {
      throw new Error("The worker gives this job no GitHub App or execute() to process the delivery with.");
    }
    await processDelivery({ database, github, execute, now }, job.data.deliveryId);
  },
};

/**
 * Sends a processing job for every delivery held while setup was incomplete,
 * in the caller's transaction, and returns how many; setup must be complete.
 * The job that runs every minute calls it, and the sign-in that completes
 * setup can call it too, so the held deliveries need not wait for that job.
 */
export async function releaseHeldDeliveries({ tx, orgId }: OrgContext, jobs: JobSender): Promise<number> {
  const released = await tx
    .update(githubDeliveries)
    .set({ enqueuedAt: sql`now()` })
    .where(and(eq(githubDeliveries.orgId, orgId), isNull(githubDeliveries.enqueuedAt)))
    .returning({ deliveryId: githubDeliveries.deliveryId });
  for (const { deliveryId } of released) await jobs.send(tx, processGitHubDelivery.type.queue, { deliveryId });
  return released.length;
}

/** A job that runs every minute and, once setup is complete, releases the deliveries held until then. */
export const releaseHeldGitHubDeliveries: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("github.release_held_deliveries", 1, {
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 300,
  }),
  schedule: "* * * * *",
  async handle(_job, { database, jobs }) {
    if (jobs === undefined) throw new Error("The worker gives this job no job queue to send the held deliveries' jobs to.");
    try {
      await withOrg(database, (context) => releaseHeldDeliveries(context, jobs));
    } catch (error) {
      // Before setup completes, the deliveries stay held.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};

const NO_SUCH_ROUTE = httpProblem(new Refusal("route-not-found", "GitHub's webhooks are delivered here with POST."));

/**
 * The answer to a delivery that does not verify. RFC 9457's about:blank
 * problem: a failed signature is none of the error model's refusals, which
 * are those of Tiehall's own operations and pages.
 */
const NOT_VERIFIED: HttpProblem = {
  status: 401,
  headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
  body: {
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    detail: "The delivery's signature does not verify with the webhook secret stored for the install's GitHub App, or none is stored.",
  },
};

function invalid(path: string, message: string): HttpProblem {
  return httpProblem(new Refusal("invalid-input", message, { issues: [{ path: [path], message }] }));
}

const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;
const EVENT = /^[a-z_]{1,100}$/;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

/** Whether a delivery's X-Hub-Signature-256 is its body's HMAC-SHA256 under this secret. */
function verifies(secret: string, body: Buffer, header: string | null): boolean {
  if (header === null || !SIGNATURE.test(header)) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, "utf8");
  return timingSafeEqual(expected, Buffer.from(header, "utf8"));
}

export function createGitHubWebhookRoute(options: GitHubWebhookRouteOptions): GitHubWebhookRoute {
  const logger = options.logger ?? createLogger();
  return async function webhooks(request) {
    if (request.method !== "POST") return answer(NO_SUCH_ROUTE);
    try {
      let body: Buffer;
      try {
        body = Buffer.from(await readBoundedBody(request, GITHUB_WEBHOOK_BODY_LIMIT));
      } catch (error) {
        if (error instanceof Refusal) return answer(httpProblem(error));
        throw error;
      }
      // The secret, read in a short read-only query that locks nothing: a delivery that does not verify opens no write.
      const secret = await options.database.transaction(
        async (tx) => {
          const [org] = await tx.select({ id: orgs.id }).from(orgs).limit(1);
          return org === undefined ? undefined : readSecret({ tx, orgId: org.id }, options.secrets(), "github_app.webhook_secret");
        },
        { accessMode: "read only" },
      );
      if (secret === undefined || !verifies(secret, body, request.headers.get("x-hub-signature-256"))) return answer(NOT_VERIFIED);

      return await options.database.transaction(async (tx) => {
        // Shared with every other delivery; setup completing waits for it, and it for setup completing.
        const [org] = await tx.select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt }).from(orgs).limit(1).for("share");
        if (org === undefined) return answer(NOT_VERIFIED);

        const deliveryId = request.headers.get("x-github-delivery") ?? "";
        const event = request.headers.get("x-github-event") ?? "";
        if (!DELIVERY_ID.test(deliveryId)) return answer(invalid("X-GitHub-Delivery", "The delivery has no delivery id in the form GitHub gives."));
        if (!EVENT.test(event)) return answer(invalid("X-GitHub-Event", "The delivery names no event in the form GitHub gives."));
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          payload = undefined;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return answer(invalid("body", "The delivery's body is not a JSON object."));
        }

        const complete = org.setupCompletedAt !== null;
        const changeKey = changeKeyOf(event, payload as Record<string, unknown>);
        // A delivery id seen before, or a change a poll stored already, is not stored again.
        const stored = await tx
          .insert(githubDeliveries)
          .values({ orgId: org.id, deliveryId, event, payload, changeKey, ...(complete ? { enqueuedAt: sql`now()` } : {}) })
          .onConflictDoNothing()
          .returning({ deliveryId: githubDeliveries.deliveryId });
        if (stored.length > 0 && complete) await options.jobs.send(tx, processGitHubDelivery.type.queue, { deliveryId });
        // The webhook works again: a give-up is cleared. The update touches no row while none is recorded.
        if (stored.length > 0) {
          await tx
            .update(githubApp)
            .set({ webhookGivenUpAt: null })
            .where(and(eq(githubApp.orgId, org.id), isNotNull(githubApp.webhookGivenUpAt)));
        }
        return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
      });
    } catch (error) {
      logger.error("webhooks: a GitHub delivery could not be received", { error });
      return answer(internalErrorProblem());
    }
  };
}

function answer({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
