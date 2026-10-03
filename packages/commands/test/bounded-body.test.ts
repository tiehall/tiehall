import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand } from "@tiehall/catalog";
import { httpProblem, PROBLEM_TYPE_BASE, Refusal } from "@tiehall/core";
import {
  BODY_LIMIT,
  bodyLimitFor,
  CONTRACT_REPORT_BODY_LIMIT,
  GITHUB_WEBHOOK_BODY_LIMIT,
  payloadTooLarge,
  readBoundedBody,
  WEBHOOKS_GITHUB_PATH,
} from "../src/index.ts";

// The limits on request bodies and the bounded reader that applies them
// (public-api: Request bodies have a size limit; request-body-limit's
// design.md, Technical decisions: T1). One module holds both limits: 2 MiB for
// every body, and 16 MiB for the method and path of the catalog's
// contract.report, read from the catalog rather than written twice. The
// reader refuses a declared length above the limit before it reads a byte, and
// otherwise counts the bytes it reads, refusing at the first byte past the
// limit and cancelling the stream, so a body over the limit is never held
// whole.

const MiB = 1024 * 1024;

/** A catalog with a contract.report, as the main change's task 22.5 defines one. */
const withReport = defineCatalog([
  defineCommand({
    id: "contract.report",
    summary: "Report the classified changes of a provider pull request.",
    input: z.object({ api: z.string() }),
    output: z.object({ changeSetId: z.string() }),
    method: "POST",
    path: "/api/v1/contract/reports",
    scopes: [],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "cli"],
    cli: [{ command: "contract report" }],
    stability: "stable",
  }),
]);

describe("the limits", () => {
  it("are 2 MiB and 16 MiB, where a MiB is 1,048,576 bytes", () => {
    expect(BODY_LIMIT).toBe(2_097_152);
    expect(CONTRACT_REPORT_BODY_LIMIT).toBe(16_777_216);
  });

  it("give 2 MiB to every body under /api/v1 and /mcp, to the web UI's forms and to every other path", () => {
    for (const [method, path] of [
      ["POST", "/api/v1/requests"],
      ["POST", "/api/v1/requests/FE-142/packet/revisions"],
      ["DELETE", "/api/v1/requests/FE-142/watchers"],
      ["POST", "/mcp"],
      ["POST", "/setup"],
      ["POST", "/confirm/members.change_role"],
      ["POST", "/no/such/route"],
    ] as const) {
      expect(bodyLimitFor(method, path), `${method} ${path}`).toBe(BODY_LIMIT);
    }
  });

  it("give the GitHub webhook 25 MiB, which covers GitHub's own maximum of 25 MB under either reading of MB", () => {
    expect(WEBHOOKS_GITHUB_PATH).toBe("/webhooks/github");
    expect(GITHUB_WEBHOOK_BODY_LIMIT).toBe(26_214_400);
    expect(GITHUB_WEBHOOK_BODY_LIMIT).toBeGreaterThanOrEqual(25_000_000);
    expect(bodyLimitFor("POST", "/webhooks/github")).toBe(GITHUB_WEBHOOK_BODY_LIMIT);
    expect(bodyLimitFor("POST", "/webhooks/github/more")).toBe(BODY_LIMIT);
  });

  it("give 16 MiB to the method and path of the catalog's contract.report, and 2 MiB to any other", () => {
    expect(bodyLimitFor("POST", "/api/v1/contract/reports", withReport)).toBe(CONTRACT_REPORT_BODY_LIMIT);
    expect(bodyLimitFor("PUT", "/api/v1/contract/reports", withReport)).toBe(BODY_LIMIT);
    expect(bodyLimitFor("POST", "/api/v1/contract/reports/1", withReport)).toBe(BODY_LIMIT);
    expect(bodyLimitFor("POST", "/api/v1/requests", withReport)).toBe(BODY_LIMIT);
    expect(bodyLimitFor("POST", "/api/v1/contract/reports", defineCatalog([]))).toBe(BODY_LIMIT);
  });

  it("read contract.report's path from the real catalog, where it gets 16 MiB once it is defined", () => {
    const report = CATALOG.get("contract.report");
    if (report?.method !== undefined && report.path !== undefined) {
      expect(bodyLimitFor(report.method, report.path)).toBe(CONTRACT_REPORT_BODY_LIMIT);
    }
    expect(bodyLimitFor("POST", "/api/v1/requests")).toBe(BODY_LIMIT);
  });
});

describe("the refusal", () => {
  it("is the error model's payload-too-large, 413 with no Retry-After, whose detail names the limit in MiB", () => {
    const refusal = payloadTooLarge(BODY_LIMIT);
    expect(refusal).toBeInstanceOf(Refusal);
    expect(refusal.reason).toBe("payload-too-large");
    const { status, headers, body } = httpProblem(refusal);
    expect(status).toBe(413);
    expect(headers["retry-after"]).toBeUndefined();
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}payload-too-large`, status: 413, detail: expect.stringContaining("2 MiB") });
    expect(payloadTooLarge(CONTRACT_REPORT_BODY_LIMIT).message).toContain("16 MiB");
  });
});

/**
 * A body stream of chunks of this many bytes, which records what it gave: 100 chunks, far more than the limits
 * here, so a reader that read it all would still end.
 */
function longBody(chunkBytes: number) {
  const record = { given: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      record.given += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      if (record.given === 100 * chunkBytes) controller.close();
    },
    cancel() {
      record.cancelled = true;
    },
  });
  return { stream, record };
}

function post(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("https://tiehall.example.com/api/v1/requests", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

async function refusalOf(promise: Promise<unknown>): Promise<Refusal> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Refusal);
  return error as Refusal;
}

describe("the bounded reader", () => {
  const limit = 1000;

  it("reads a body of exactly the limit, and refuses one byte more", async () => {
    expect((await readBoundedBody(post("x".repeat(limit)), limit)).byteLength).toBe(limit);
    const refusal = await refusalOf(readBoundedBody(post("x".repeat(limit + 1)), limit));
    expect(refusal.reason).toBe("payload-too-large");
  });

  it("counts bytes, not characters", async () => {
    expect((await readBoundedBody(post("é".repeat(limit / 2)), limit)).byteLength).toBe(limit);
    expect((await refusalOf(readBoundedBody(post("é".repeat(limit / 2 + 1)), limit))).reason).toBe("payload-too-large");
  });

  it("refuses a declared length above the limit before it reads a byte of the body", async () => {
    const { stream, record } = longBody(100);
    const refusal = await refusalOf(readBoundedBody(post(stream, { "content-length": String(limit + 1) }), limit));
    expect(refusal.message).toBe(payloadTooLarge(limit).message);
    expect(record.cancelled).toBe(true);
    // A stream may fill its queue once when it starts; nothing of it was read.
    expect(record.given).toBeLessThanOrEqual(100);
  });

  it("counts a body with no declared length as it reads it, and at the byte past the limit refuses and cancels the stream", async () => {
    const { stream, record } = longBody(100);
    const refusal = await refusalOf(readBoundedBody(post(stream), limit));
    expect(refusal.reason).toBe("payload-too-large");
    expect(record.cancelled).toBe(true);
    expect(record.given).toBeLessThanOrEqual(limit + 2 * 100);
  });

  it("counts the bytes it receives, not a declared length under the limit", async () => {
    const { stream, record } = longBody(100);
    expect((await refusalOf(readBoundedBody(post(stream, { "content-length": "10" }), limit))).reason).toBe("payload-too-large");
    expect(record.cancelled).toBe(true);
  });

  it("reads a body with no limit whole, and a request without a body as empty", async () => {
    expect((await readBoundedBody(post("x".repeat(3 * MiB)), undefined)).byteLength).toBe(3 * MiB);
    expect((await readBoundedBody(new Request("https://tiehall.example.com/api/v1/requests"), limit)).byteLength).toBe(0);
  });
});
