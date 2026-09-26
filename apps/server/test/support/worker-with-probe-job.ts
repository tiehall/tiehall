// The worker role with one probe job, run as its own process by worker-role.test.ts, so the test can send it
// SIGTERM as Docker does. The probe job prints its id when it starts and, unless PROBE_FINISH is set, runs
// until the worker gives it up.
import process from "node:process";
import { defineJobType, type RunningJob } from "@tiehall/commands";
import { readConfig } from "../../src/config.ts";
import { runWorkerRole } from "../../src/worker-role.ts";

export const probeSlow = defineJobType<{ requestId: string }>("probe.slow", 1, {
  retryLimit: 2,
  retryDelaySeconds: 0,
  retryBackoff: false,
  expireInSeconds: 60,
});

if (import.meta.main) {
  await runWorkerRole(readConfig(process.env), {
    jobs: [
      {
        type: probeSlow,
        handle: async (job: RunningJob<{ requestId: string }>) => {
          console.log(`probe: started ${job.id}`);
          if (process.env["PROBE_FINISH"] === undefined) {
            await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
          }
        },
      },
    ],
    stopTimeoutMs: 1000,
    pollingIntervalSeconds: 0.5,
  });
}
