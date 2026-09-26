// The worker role with probe jobs, run as its own process by worker-role.test.ts, so the test can send it
// SIGTERM as Docker does and read everything the process prints. The slow probe prints its id when it starts
// and, unless PROBE_FINISH is set, runs until the worker gives it up. The failing probe mirrors a message into
// a tracker that refuses it: it reads the message's text, holds a token, and fails with both in its error.
import process from "node:process";
import { defineJobType, type RunningJob, type WorkerServices } from "@tiehall/commands";
import { readConfig } from "../../src/config.ts";
import { runWorkerRole } from "../../src/worker-role.ts";

export const probeSlow = defineJobType<{ requestId: string }>("probe.slow", 1, {
  retryLimit: 2,
  retryDelaySeconds: 0,
  retryBackoff: false,
  expireInSeconds: 60,
});

export const probeFailing = defineJobType<{ messageId: string }>("probe.mirror_message", 1, {
  retryLimit: 0,
  retryDelaySeconds: 0,
  retryBackoff: false,
  expireInSeconds: 60,
});

async function mirrorIntoRefusingTracker(job: RunningJob<{ messageId: string }>, { database }: WorkerServices) {
  const { rows } = await database.$client.query<{ body: string }>("SELECT body FROM probe_messages WHERE id = $1", [
    job.data.messageId,
  ]);
  const text = rows[0]?.body ?? "";
  const token = process.env["PROBE_TOKEN"] ?? "";
  const request = {
    url: `https://acme.atlassian.net/rest/api/3/issue?token=${token}`,
    headers: { authorization: `Bearer ${token}`, cookie: `session=${token}` },
    body: JSON.stringify({ summary: text }),
  };
  const refusal = new Error(`Jira answered 400 to ${request.url}: ${text}`);
  throw Object.assign(new Error(`Could not mirror "${text}" with ${token}`, { cause: refusal }), { request });
}

if (import.meta.main) {
  await runWorkerRole(readConfig(process.env), {
    jobs: [
      {
        type: probeSlow,
        handle: async (job: RunningJob<{ requestId: string }>) => {
          process.stdout.write(`probe: started ${job.id}\n`);
          if (process.env["PROBE_FINISH"] === undefined) {
            await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
          }
        },
      },
      { type: probeFailing, handle: mirrorIntoRefusingTracker },
    ],
    stopTimeoutMs: 1000,
    pollingIntervalSeconds: 0.5,
  });
}
