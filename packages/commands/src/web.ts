import { CATALOG, OPENAPI_JSON } from "@tiehall/catalog";
import { openAppDatabase } from "./database.ts";
import { createExecute, type Execute } from "./execute.ts";
import { HANDLERS } from "./handlers.ts";
import { openJobQueue, type JobQueue } from "./job-queue.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { createRestHandler, type RestHandler } from "./rest.ts";
import { readAppDatabase, type Environment } from "./settings.ts";
import { createWebCommands, type WebCommands } from "./web-commands.ts";

export type { WebResult } from "./web-commands.ts";
import { WORKER_JOBS } from "./worker-jobs.ts";

// What the web role's routes, server actions and server components run
// (design.md, Technical decisions: T1 and T3): the real catalog and its
// handlers, through one execute() per process, as the app role. REST and the
// web UI share it, so both take the same authorization path. The web process
// sends the jobs its writes start, and opens the job queue only when a write
// first sends one; it works no queue, which the worker does.

let services: { execute: Execute; logger: Logger } | undefined;
let rest: RestHandler | undefined;
let web: WebCommands | undefined;

/** The process's one execute(), built from the install's settings on first use. */
function servicesOf(env: Environment): { execute: Execute; logger: Logger } {
  if (services !== undefined) return services;
  const logger = createLogger().child({ role: "web" });
  const connection = readAppDatabase(env);
  const database = openAppDatabase(connection, { applicationName: "tiehall web", logger, role: "web" });
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
  services = { execute: createExecute({ catalog: CATALOG, handlers: HANDLERS, store: { database, jobs } }), logger };
  return services;
}

/** The REST route under /api/v1, built once per process from the install's settings. */
export function restRoute(env: Environment): RestHandler {
  if (rest !== undefined) return rest;
  const { execute, logger } = servicesOf(env);
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

/**
 * What the web UI's server actions and server components run operations
 * through, as the signed-in user's web session, built once per process.
 */
export function webCommands(env: Environment): WebCommands {
  if (web !== undefined) return web;
  const { execute, logger } = servicesOf(env);
  web = createWebCommands({
    execute,
    // Sessions come with sign-in (group 7); until then nobody is signed in.
    session: async () => undefined,
    logger,
  });
  return web;
}
