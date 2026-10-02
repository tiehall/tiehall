import { openAppDatabase } from "./database.ts";
import { createGitHubWebhookRoute, processGitHubDelivery, type GitHubWebhookRoute } from "./github-webhooks.ts";
import { lazyJobSender, openJobQueue } from "./job-queue.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger } from "./log.ts";
import { openSecretBox, type SecretBox } from "./secret-box.ts";
import { readAppDatabase, readSecretKey, type Environment } from "./settings.ts";

// What the web role runs at /webhooks/github (tracker-mirrors: GitHub webhooks
// are verified, deduplicated and processed in the background): the route,
// built once per process from the install's settings, as the app role. It
// reads TIEHALL_SECRET_KEY, which opens the stored webhook secret, when a
// delivery first arrives, and opens the job queue when it first sends a
// delivery's processing job; it works no queue, which the worker does.

let route: GitHubWebhookRoute | undefined;

/** The route at /webhooks/github of this process. */
export function githubWebhookRoute(env: Environment): GitHubWebhookRoute {
  if (route !== undefined) return route;
  const logger = createLogger().child({ role: "web" });
  const connection = readAppDatabase(env);
  const database = openAppDatabase(connection, { applicationName: "tiehall web webhooks", logger, role: "web" });
  const jobs: JobSender = lazyJobSender(() => openJobQueue({ connection, jobTypes: [processGitHubDelivery.type], applicationName: "tiehall web webhooks", logger }));
  let box: SecretBox | undefined;
  route = createGitHubWebhookRoute({ database, secrets: () => (box ??= openSecretBox(readSecretKey(env))), jobs, logger });
  return route;
}
