import { githubConnectedInstallations, githubDeliveries, githubInstallations, type Database } from "@tiehall/db";
import { and, eq, isNull } from "drizzle-orm";
import type { IntegrationEventCaller } from "./caller.ts";
import type { Execute } from "./execute.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { readInstallations } from "./github-installations.ts";
import { memberOfGitHubAccount } from "./github-users.ts";
import type { InstallGitHub } from "./install-github.ts";
import { processIssuesEvent } from "./github-issue-processing.ts";
import { createLogger, type Logger } from "./log.ts";
import { processOrganizationEvent } from "./organization-departures.ts";
import { processPullRequestEvent } from "./pull-request-processing.ts";
import { withOrg } from "./with-org.ts";

// Processing a stored GitHub delivery, in the worker (agent-access: Six kinds
// of caller; tracker-mirrors: Admins connect GitHub installations with the
// confirmation step; tracker-mirrors: GitHub webhooks are verified,
// deduplicated and processed in the background; github-app-reachability:
// design.md, Design rules: Finding installations; design.md, Technical
// decisions: T16).
// - A delivery about an installation, `installation` or
//   `installation_repositories`, is a hint: Tiehall lists the App's
//   installations again at once, with the App's own token, and reads the
//   repositories of the installation it names when that one is connected. It
//   does so whatever the installation, because the admin page lists every
//   installation of the App; nothing else changes for one that is not
//   connected.
// - Any other delivery counts only when it comes from a connected
//   installation, through the table of connected installations: one from an
//   installation that no admin connected changes nothing. From a connected
//   one, it goes to the processor of its event, which later tasks add (pull
//   requests, issues, organization membership). A processor runs its changes
//   as the integration-event caller, acting for the Tiehall user of the
//   delivery's sender only while that user is a member of the install, and
//   for no user otherwise, whether the user was removed, was never admitted
//   or does not exist, through execute(), which lets that caller run only
//   internal commands, records what it runs as an integration from GitHub,
//   and checks again in the call's transaction that the user is still a
//   member (agent-access: Six kinds of caller; github-layer-hardening:
//   design.md, Technical decisions: T7). A change the poll stores names no
//   sender, so it acts for no user. A change that is the system's own action
//   whoever made the change on GitHub, such as the system withdrawal of a
//   contract-change request whose provider pull request closed without
//   merging, runs instead as Tiehall's own job from GitHub, which acts for no
//   user and is recorded with the actor kind system and the surface github.
// A delivery is processed once: it is marked processed when its processing
// ends, and a job that runs again for it afterwards does nothing. The poll of
// polling mode stores each change it finds in the same form, less the
// delivery's action, and feeds it to the same processing (github-polling.ts),
// so a processor reads the state of what changed, not the action.
//
// Every delivery is a hint, and processing is level-triggered (design.md,
// Technical decisions: T16). GitHub's signature covers only a delivery's body,
// not its X-GitHub-Delivery or X-GitHub-Event, so a captured signed body can
// come back under a new delivery id and be stored again; GitHub also
// redelivers, and may deliver late or out of order. So no processor acts on
// what a payload says happened: before it changes anything, it reads the
// current state from GitHub with an installation token, and acts on that. The
// organization processor asks whether the member is still in the
// organization (organization-departures.ts); the pull request processor reads
// the pull request again (pull-request-processing.ts), and the issues
// processor the mirror issue (github-issue-processing.ts), and each acts on
// its state now. A replay, a redelivery and an out-of-order
// delivery then change nothing that the current state does not call for.
// Deliveries are not deduplicated by a digest of their body: two genuine
// deliveries can be byte for byte the same, such as two reports of one person
// leaving an organization, whose payload carries no time.

/** A delivery from a connected installation, as its event's processor gets it. */
export interface GitHubEvent {
  deliveryId: string;
  /** GitHub's X-GitHub-Event, such as pull_request. */
  event: string;
  /** The payload's action, such as opened, when it names one. */
  action: string | undefined;
  payload: Readonly<Record<string, unknown>>;
  /** The connected installation it came from: Tiehall's id, and GitHub's. */
  installation: { id: string; installationId: number };
}

/** What an event's processor works with. */
export interface GitHubEventContext {
  /** The caller the event's changes run as: an integration event from GitHub, acting for the sender's Tiehall user if that user is a member. */
  readonly caller: IntegrationEventCaller;
  /** Runs an operation as that caller, through execute(), which lets it run only internal commands. */
  run(commandId: string, input: unknown): Promise<unknown>;
  /**
   * Runs an internal system command as Tiehall's own job from GitHub, acting
   * for no user, for a change that is the system's action whoever made the
   * change on GitHub, such as the system withdrawal of a contract-change
   * request whose provider pull request closed without merging.
   */
  runAsSystem(commandId: string, input: unknown): Promise<unknown>;
  /** The install's App, with a client that calls GitHub as it. */
  readonly app: GitHubAppAccess;
  readonly database: Database;
  readonly logger: Logger;
}

export type GitHubEventProcessor = (event: GitHubEvent, context: GitHubEventContext) => Promise<void>;

/** The processors of the events deliveries carry, by the event's name. */
export type GitHubEventProcessors = Readonly<Record<string, GitHubEventProcessor>>;

/**
 * The processors of the events a connected installation's deliveries carry.
 * Each task that acts on an event adds its processor here: pull requests for
 * provider pull requests, PR links and close on merge
 * (pull-request-processing.ts), issues for the GitHub Issues mirror
 * (github-issue-processing.ts), and
 * organization for membership (organization-departures.ts). Each reads the
 * current state from GitHub before it acts, as the rule above says. An event
 * with no processor changes nothing.
 */
export const GITHUB_EVENT_PROCESSORS: GitHubEventProcessors = {
  issues: processIssuesEvent,
  organization: processOrganizationEvent,
  pull_request: processPullRequestEvent,
};

/** The job a processor's system actions run as: the processing of the delivery, which applies what GitHub reported. */
const PROCESSING_JOB = "github.process_delivery";

/** The events that are about the App's installations, which make Tiehall list them again. */
const INSTALLATION_EVENTS = new Set(["installation", "installation_repositories"]);

export interface DeliveryProcessingServices {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's GitHub App. */
  github: InstallGitHub;
  /** execute() of the worker, through which a processor's changes run. */
  execute: Execute;
  /** The processors of the events, GITHUB_EVENT_PROCESSORS unless a test gives others. */
  processors?: GitHubEventProcessors;
  /** The worker's clock. */
  now?: () => Date;
  logger?: Logger;
}

/** A positive whole number from a payload, such as an installation's id, or undefined. */
function idOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Processes one stored delivery, by its delivery id, once. */
export async function processDelivery(services: DeliveryProcessingServices, deliveryId: string): Promise<void> {
  const logger = (services.logger ?? createLogger()).child({ integration: "github" });
  const delivery = await withOrg(services.database, async ({ tx, orgId }) => {
    const [row] = await tx
      .select({ event: githubDeliveries.event, payload: githubDeliveries.payload, processedAt: githubDeliveries.processedAt })
      .from(githubDeliveries)
      .where(and(eq(githubDeliveries.orgId, orgId), eq(githubDeliveries.deliveryId, deliveryId)));
    return row;
  });
  if (delivery === undefined || delivery.processedAt !== null) return;
  const payload = objectOf(delivery.payload) ?? {};
  const installationId = idOf(objectOf(payload["installation"])?.["id"]);

  const app = await services.github.app();
  if (app === undefined) throw new Error("The install has no GitHub App stored, so a GitHub delivery cannot be processed.");

  if (INSTALLATION_EVENTS.has(delivery.event)) {
    // A hint: list the App's installations again, and read the repositories of the one it names if it is connected.
    await readInstallations({ database: services.database, app, repositoriesOf: installationId === undefined ? [] : [installationId], logger });
  } else if (installationId !== undefined) {
    const found = await withOrg(services.database, async (context) => {
      const [connected] = await context.tx
        .select({ id: githubInstallations.id })
        .from(githubInstallations)
        .innerJoin(
          githubConnectedInstallations,
          and(eq(githubConnectedInstallations.orgId, githubInstallations.orgId), eq(githubConnectedInstallations.installationId, githubInstallations.id)),
        )
        .where(and(eq(githubInstallations.orgId, context.orgId), eq(githubInstallations.installationId, installationId)));
      if (connected === undefined) return undefined;
      const sender = idOf(objectOf(payload["sender"])?.["id"]);
      const userId = sender === undefined ? undefined : await memberOfGitHubAccount(context, { id: sender });
      return { id: connected.id, userId };
    });
    const processor = (services.processors ?? GITHUB_EVENT_PROCESSORS)[delivery.event];
    if (found !== undefined && processor !== undefined) {
      const caller: IntegrationEventCaller = { kind: "integration_event", source: "github", ...(found.userId === undefined ? {} : { userId: found.userId }) };
      const action = payload["action"];
      await processor(
        {
          deliveryId,
          event: delivery.event,
          action: typeof action === "string" ? action : undefined,
          payload,
          installation: { id: found.id, installationId },
        },
        {
          caller,
          run: (commandId, input) => services.execute(commandId, caller, input),
          runAsSystem: (commandId, input) => services.execute(commandId, { kind: "system_job", job: PROCESSING_JOB, surface: "github" }, input),
          app,
          database: services.database,
          logger,
        },
      );
    }
  }

  await withOrg(services.database, async ({ tx, orgId }) => {
    await tx
      .update(githubDeliveries)
      .set({ processedAt: (services.now ?? (() => new Date()))() })
      .where(and(eq(githubDeliveries.orgId, orgId), eq(githubDeliveries.deliveryId, deliveryId), isNull(githubDeliveries.processedAt)));
  });
}
