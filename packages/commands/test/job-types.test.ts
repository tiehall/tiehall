import { describe, expect, it } from "vitest";
import { defineJobType, JobTypeError, WORKER_JOBS } from "../src/index.ts";

// Kinds of job and their queues (self-host-install: Migrations expand, then
// contract; design.md, Technical decisions: T6). A queue's name carries the
// version of its jobs' data shape, so a release that changes the shape sends
// to a new queue, which a worker of the previous release never works. Each
// queue has its own dead-letter queue, where a job goes once its attempts are
// used up.

const settings = { retryLimit: 4, retryDelaySeconds: 60, retryBackoff: true, expireInSeconds: 300 };

describe("a job type", () => {
  it("names its queue and its dead-letter queue with the version of its data shape", () => {
    const mirror = defineJobType<{ requestId: string }>("mirror.create_issue", 2, settings);
    expect(mirror).toEqual({
      name: "mirror.create_issue",
      version: 2,
      queue: "mirror.create_issue.v2",
      deadLetterQueue: "mirror.create_issue.v2.dead_letter",
      settings,
    });
  });

  it("refuses a name that is not dotted lower case, or that carries a version of its own", () => {
    expect(() => defineJobType("Mirror Create", 1, settings)).toThrow(
      new JobTypeError('The job type "Mirror Create" is not a dotted lower-case name, such as "mirror.create_issue".'),
    );
    expect(() => defineJobType("mirror.create.v1", 1, settings)).toThrow(
      new JobTypeError('The job type "mirror.create.v1" carries a version in its name; give the version apart, as a number.'),
    );
  });

  it("refuses a version that is not a whole number from 1, and settings out of range", () => {
    expect(() => defineJobType("mirror.create_issue", 0, settings)).toThrow(
      new JobTypeError("The version of mirror.create_issue must be a whole number from 1, not 0."),
    );
    expect(() => defineJobType("mirror.create_issue", 1.5, settings)).toThrow(
      new JobTypeError("The version of mirror.create_issue must be a whole number from 1, not 1.5."),
    );
    expect(() => defineJobType("mirror.create_issue", 1, { ...settings, retryLimit: -1 })).toThrow(
      new JobTypeError("mirror.create_issue: retryLimit must be a whole number from 0, not -1."),
    );
    expect(() => defineJobType("mirror.create_issue", 1, { ...settings, expireInSeconds: 0 })).toThrow(
      new JobTypeError("mirror.create_issue: expireInSeconds must be a whole number from 1, not 0."),
    );
  });
});

describe("a job type that runs one key at a time", () => {
  it("keeps its policy with its settings, and refuses a policy pg-boss would apply differently", () => {
    expect(defineJobType("mirror.sync", 1, { ...settings, policy: "key_strict_fifo" }).settings.policy).toBe("key_strict_fifo");
    expect(() => defineJobType("mirror.sync", 1, { ...settings, policy: "exclusive" as never })).toThrow(
      new JobTypeError("mirror.sync: the policy exclusive is not one a job type may have; key_strict_fifo is."),
    );
  });
});

describe("the worker's jobs", () => {
  it("use each queue once", () => {
    const queues = WORKER_JOBS.map(({ type }) => type.queue);
    expect(new Set(queues).size).toBe(queues.length);
  });
});
