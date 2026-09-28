import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  accountJson,
  installationJson,
  issueJson,
  orgJson,
  pullRequestJson,
  repoJson,
  repoSummaryJson,
  type Urls,
} from "./json.ts";
import { makeGuid } from "./tokens.ts";
import type { GitHubWorld, StubAccount, StubApp, StubInstallation, StubIssue, StubOrg, StubPullRequest, StubRepo, StubUser } from "./world.ts";

// Webhook deliveries, as GitHub makes them for an App with an active webhook:
// signed with the App's webhook secret, logged in the App's delivery log
// whether they reached the hook or not, and redelivered on request. A test
// decides for each change whether GitHub sends its delivery ("send", the
// default), tries and fails ("drop": logged as failed, never sent, and
// redeliverable), or sends nothing at all ("none"). An App without a webhook,
// or with an inactive one, gets no delivery and no log (spike 1.6).
//
// The stub never reaches the network outside the test: it sends a delivery
// only to the address its hook router gives for the hook URL, which by default
// is the URL itself on loopback and nothing elsewhere; a hook URL with no
// address fails as GitHub's delivery to an unreachable install would.

export type DeliveryMode = "send" | "drop" | "none";

export interface DeliveryOptions {
  /** Whether GitHub sends the delivery this change causes: "send" by default. */
  delivery?: DeliveryMode;
}

export interface StubDelivery {
  readonly id: number;
  readonly guid: string;
  readonly appId: number;
  readonly hookId: number;
  readonly event: string;
  readonly action: string | null;
  readonly installationId: number | null;
  readonly repositoryId: number | null;
  readonly deliveredAt: string;
  readonly redelivery: boolean;
  duration: number;
  status: string;
  statusCode: number;
  readonly url: string;
  readonly request: { headers: Record<string, string>; payload: unknown };
  response: { headers: Record<string, string>; payload: string | null };
}

/**
 * How the log shows a delivery that did not reach the hook. The spike could
 * not record GitHub's words for it (spike 1.6 left "how a failed delivery
 * shows" open), so a failure is only certain to have a status code outside
 * 200-299.
 */
export const FAILED_DELIVERY = { status: "failed to connect to host", statusCode: 0 } as const;

/** The events every App with a webhook receives without subscribing to them. */
const ALWAYS_DELIVERED = new Set(["ping", "installation", "installation_repositories"]);

export function signBody(secret: string, body: string | Buffer): { sha256: string; sha1: string } {
  return {
    sha256: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    sha1: `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`,
  };
}

export class Deliveries {
  readonly log: StubDelivery[] = [];
  /** False plays an install GitHub cannot reach: every delivery fails. */
  hookReachable = true;
  private readonly inFlight = new Set<Promise<unknown>>();
  private nextId = 90_000_000;
  private readonly world: GitHubWorld;
  private readonly urls: () => Urls;
  /** The address to send a delivery for a hook URL to, or undefined when GitHub cannot reach it. */
  route: (url: URL) => string | undefined;

  constructor(world: GitHubWorld, urls: () => Urls, route: (url: URL) => string | undefined) {
    this.world = world;
    this.urls = urls;
    this.route = route;
  }

  /** Sends one event to the App's webhook, and waits for the delivery to be logged. */
  send(app: StubApp, event: string, payload: Record<string, unknown>, mode: DeliveryMode = "send"): Promise<StubDelivery | undefined> {
    if (mode === "none" || app.hook === null || !app.hook.active) return Promise.resolve(undefined);
    if (!ALWAYS_DELIVERED.has(event) && !app.events.includes(event)) return Promise.resolve(undefined);
    return this.track(this.attempt(app, event, payload, makeGuid(), false, mode === "drop"));
  }

  /** Sends a logged delivery again, with its guid, as GitHub's redelivery does. */
  redeliver(app: StubApp, delivery: StubDelivery): Promise<StubDelivery | undefined> {
    if (app.hook === null) return Promise.resolve(undefined);
    return this.track(this.attempt(app, delivery.event, delivery.request.payload as Record<string, unknown>, delivery.guid, true, false));
  }

  /** Waits until every delivery started so far is logged. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  of(app: StubApp): StubDelivery[] {
    return this.log.filter((delivery) => delivery.appId === app.id);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
    return promise;
  }

  private async attempt(
    app: StubApp,
    event: string,
    payload: Record<string, unknown>,
    guid: string,
    redelivery: boolean,
    drop: boolean,
  ): Promise<StubDelivery> {
    const hook = app.hook!;
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      accept: "*/*",
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/stub",
      "x-github-delivery": guid,
      "x-github-event": event,
      "x-github-hook-id": String(hook.id),
      "x-github-hook-installation-target-id": String(app.id),
      "x-github-hook-installation-target-type": "integration",
    };
    if (app.webhookSecret !== null) {
      const signature = signBody(app.webhookSecret, body);
      headers["x-hub-signature"] = signature.sha1;
      headers["x-hub-signature-256"] = signature.sha256;
    }
    const installation = payload["installation"] as { id?: number } | undefined;
    const repository = payload["repository"] as { id?: number } | undefined;
    const delivery: StubDelivery = {
      id: (this.nextId += 1),
      guid,
      appId: app.id,
      hookId: hook.id,
      event,
      action: typeof payload["action"] === "string" ? payload["action"] : null,
      installationId: installation?.id ?? null,
      repositoryId: repository?.id ?? null,
      deliveredAt: this.world.timestamp(),
      redelivery,
      duration: 0,
      status: FAILED_DELIVERY.status,
      statusCode: FAILED_DELIVERY.statusCode,
      url: hook.url,
      request: { headers, payload },
      response: { headers: {}, payload: null },
    };
    this.log.push(delivery);
    const started = performance.now();
    const target = drop || !this.hookReachable ? undefined : this.route(new URL(hook.url));
    if (target !== undefined) {
      try {
        const response = await fetch(target, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        delivery.statusCode = response.status;
        delivery.status = response.status >= 200 && response.status < 300 ? "OK" : `Invalid HTTP Response: ${response.status}`;
        delivery.response = { headers: Object.fromEntries(response.headers), payload: (await response.text()).slice(0, 8_192) };
      } catch {
        delivery.status = FAILED_DELIVERY.status;
        delivery.statusCode = FAILED_DELIVERY.statusCode;
      }
    }
    delivery.duration = Math.round(performance.now() - started) / 1000;
    return delivery;
  }

  // What GitHub sends for each change, and to whom.

  ping(app: StubApp): Promise<StubDelivery | undefined> {
    if (app.hook === null) return Promise.resolve(undefined);
    const urls = this.urls();
    return this.send(app, "ping", {
      zen: "Keep it logically awesome.",
      hook_id: app.hook.id,
      hook: {
        type: "App",
        id: app.hook.id,
        name: "web",
        active: app.hook.active,
        events: [...app.events],
        config: { content_type: "json", insecure_ssl: "0", url: app.hook.url },
        updated_at: app.updatedAt,
        created_at: app.createdAt,
        app_id: app.id,
        deliveries_url: `${urls.api}/app/hook/deliveries`,
      },
    });
  }

  installation(installation: StubInstallation, action: string, sender: StubUser, mode?: DeliveryMode): Promise<StubDelivery | undefined> {
    const app = this.world.apps.get(installation.appId)!;
    const urls = this.urls();
    const payload: Record<string, unknown> = {
      action,
      installation: installationJson(urls, this.world, installation),
      sender: accountJson(urls, sender),
    };
    if (action === "created" || action === "deleted") payload["repositories"] = this.world.coveredRepos(installation).map(repoSummaryJson);
    return this.send(app, "installation", payload, mode);
  }

  installationRepositories(
    installation: StubInstallation,
    change: { added: StubRepo[]; removed: StubRepo[] },
    sender: StubUser,
    mode?: DeliveryMode,
  ): Promise<StubDelivery | undefined> {
    const app = this.world.apps.get(installation.appId)!;
    const urls = this.urls();
    return this.send(
      app,
      "installation_repositories",
      {
        action: change.added.length > 0 ? "added" : "removed",
        installation: installationJson(urls, this.world, installation),
        repository_selection: installation.selection,
        repositories_added: change.added.map(repoSummaryJson),
        repositories_removed: change.removed.map(repoSummaryJson),
        requester: null,
        sender: accountJson(urls, sender),
      },
      mode,
    );
  }

  /** A repository event, to the App of every installation that reaches the repository and subscribes to the event. */
  async repository(
    repo: StubRepo,
    event: "pull_request" | "issues" | "issue_comment",
    body: (urls: Urls) => Record<string, unknown>,
    sender: StubAccount | StubApp,
    mode?: DeliveryMode,
  ): Promise<StubDelivery[]> {
    const urls = this.urls();
    const sent = await Promise.all(
      this.world.installationsReaching(repo).map((installation) =>
        this.send(
          this.world.apps.get(installation.appId)!,
          event,
          {
            ...body(urls),
            repository: repoJson(urls, repo),
            ...(repo.owner.type === "Organization" ? { organization: orgJson(urls, repo.owner) } : {}),
            installation: { id: installation.id, node_id: `MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u${installation.id}` },
            sender: "botId" in sender ? { login: `${sender.slug}[bot]`, id: sender.botId, type: "Bot" } : accountJson(urls, sender),
          },
          mode,
        ),
      ),
    );
    return sent.filter((delivery): delivery is StubDelivery => delivery !== undefined);
  }

  pullRequest(action: string, pr: StubPullRequest, sender: StubUser, mode?: DeliveryMode): Promise<StubDelivery[]> {
    return this.repository(pr.repo, "pull_request", (urls) => ({ action, number: pr.number, pull_request: pullRequestJson(urls, pr) }), sender, mode);
  }

  issue(action: string, issue: StubIssue, sender: StubAccount | StubApp, mode?: DeliveryMode, extra: Record<string, unknown> = {}): Promise<StubDelivery[]> {
    return this.repository(issue.repo, "issues", (urls) => ({ action, issue: issueJson(urls, this.world, issue), ...extra }), sender, mode);
  }

  /** An organization event, to the App of every live installation on the organization that subscribes to it. */
  async organization(org: StubOrg, action: string, user: StubUser, role: string, sender: StubUser, mode?: DeliveryMode): Promise<StubDelivery[]> {
    const urls = this.urls();
    const installations = [...this.world.installations.values()].filter(
      (installation) => installation.account.id === org.id && !installation.deleted && installation.suspendedAt === null,
    );
    const sent = await Promise.all(
      installations.map((installation) =>
        this.send(
          this.world.apps.get(installation.appId)!,
          "organization",
          {
            action,
            membership: {
              url: `${urls.api}/orgs/${org.login}/memberships/${user.login}`,
              state: action === "member_removed" ? "inactive" : "active",
              role,
              organization_url: `${urls.api}/orgs/${org.login}`,
              user: accountJson(urls, user),
            },
            organization: orgJson(urls, org),
            installation: { id: installation.id, node_id: `MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u${installation.id}` },
            sender: accountJson(urls, sender),
          },
          mode,
        ),
      ),
    );
    return sent.filter((delivery): delivery is StubDelivery => delivery !== undefined);
  }
}

/** The delivery log's summary of a delivery, as GET /app/hook/deliveries lists it. */
export function deliverySummaryJson(delivery: StubDelivery): Record<string, unknown> {
  return {
    id: delivery.id,
    guid: delivery.guid,
    delivered_at: delivery.deliveredAt,
    redelivery: delivery.redelivery,
    duration: delivery.duration,
    status: delivery.status,
    status_code: delivery.statusCode,
    event: delivery.event,
    action: delivery.action,
    installation_id: delivery.installationId,
    repository_id: delivery.repositoryId,
    throttled_at: null,
  };
}

/** One delivery with its request and response, as GET /app/hook/deliveries/{id} answers. */
export function deliveryJson(delivery: StubDelivery): Record<string, unknown> {
  return {
    ...deliverySummaryJson(delivery),
    url: delivery.url,
    request: delivery.request,
    response: delivery.response,
  };
}
