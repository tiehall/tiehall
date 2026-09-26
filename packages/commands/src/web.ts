import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { openDatabase } from "@tiehall/db";
import { createExecute } from "./execute.ts";
import { HANDLERS } from "./handlers.ts";
import { openJobQueue, type JobQueue } from "./job-queue.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger } from "./log.ts";
import { createRestHandler, type RestHandler } from "./rest.ts";
import { readAppDatabase, type Environment } from "./settings.ts";
import { WORKER_JOBS } from "./worker-jobs.ts";

// What the web role's routes run (design.md, Technical decisions: T1 and T3):
// the REST route over the real catalog and its handlers, through one execute()
// per process, as the app role. The web process sends the jobs its writes
// start, and opens the job queue only when a write first sends one; it works
// no queue, which the worker does.

let rest: RestHandler | undefined;

/** The REST route under /api/v1, built once per process from the install's settings. */
export function restRoute(env: Environment): RestHandler {
  if (rest !== undefined) return rest;
  const logger = createLogger().child({ role: "web" });
  const connection = readAppDatabase(env);
  const database = openDatabase(connection, { applicationName: "tiehall web" });
  let queue: Promise<JobQueue> | undefined;
  const jobs: JobSender = {
    async send(tx, name, data) {
      queue ??= openJobQueue({
        connection,
        jobTypes: WORKER_JOBS.map(({ type }) => type),
        applicationName: "tiehall web",
        logger,
      }).catch((error: unknown) => {
        queue = undefined;
        throw error;
      });
      await (await queue).send(tx, name, data);
    },
  };
  const execute = createExecute({ catalog: CATALOG, handlers: HANDLERS, store: { database, jobs } });
  rest = createRestHandler({
    catalog: CATALOG,
    document: OPENAPI_JSON,
    execute,
    // Tokens are checked from group 15 on (agent-access); until then no call carries valid credentials.
    authenticate: async () => undefined,
    logger,
  });
  return rest;
}
