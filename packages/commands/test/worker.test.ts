import { describe, expect, it } from "vitest";
import { startWorker } from "../src/worker.ts";

// The worker role's entry point. Task 3.7 adds pg-boss; until then the worker
// only holds the process open until it is stopped.

describe("startWorker", () => {
  it("reports that it started, holds the process open, and stops on request", async () => {
    const lines: string[] = [];
    const before = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
    const worker = startWorker((line) => lines.push(line));
    expect(lines).toEqual(["worker: started, with no queues yet"]);
    expect(process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length).toBe(before + 1);

    await worker.stop();
    expect(lines).toEqual(["worker: started, with no queues yet", "worker: stopped"]);
    expect(process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length).toBe(before);
  });
});
