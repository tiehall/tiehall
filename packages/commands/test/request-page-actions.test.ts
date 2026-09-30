import { describe, expect, it } from "vitest";
import { requestPageWrite as plan, runRequestPageAction, type RequestPageCalls } from "../src/index.ts";

// What each form of a request's page runs (public-api: One definition per
// operation, the same on every surface; requests: Thread messages and
// blocking questions): the operation and the input an agent would send over
// /api/v1. A form that names no action the page has is refused with 400 and
// runs nothing. The actions against a running web app are tested in
// request-page-actions-browser.test.ts.

const form = (fields: Record<string, string>) => new URLSearchParams({ key: "FE-1", csrf: "a-token", ...fields });

/** A read that is not expected: only a packet change reads. */
const noRead: RequestPageCalls["read"] = async () => {
  throw new Error("read");
};

const requestPageWrite = (fields: URLSearchParams) => plan(fields, noRead);

describe("the forms of a request's page", () => {
  it("claim, start and release run requests.claim and requests.set_status", async () => {
    expect(await requestPageWrite(form({ action: "claim" }))).toEqual({ action: "claim", commandId: "requests.claim", input: { key: "FE-1" } });
    expect(await requestPageWrite(form({ action: "start" }))).toEqual({ action: "start", commandId: "requests.set_status", input: { key: "FE-1", state: "in_progress" } });
    expect(await requestPageWrite(form({ action: "release" }))).toEqual({ action: "release", commandId: "requests.set_status", input: { key: "FE-1", state: "open" } });
  });

  it("post sends a comment's text alone, a question's blocking box, and an answer's question", async () => {
    const fields = { action: "post", body: "Hello", blocking: "on", questionId: "a-question" };
    expect((await requestPageWrite(form({ ...fields, kind: "comment" }))).input).toEqual({ key: "FE-1", kind: "comment", body: "Hello" });
    expect((await requestPageWrite(form({ ...fields, kind: "question" }))).input).toEqual({ key: "FE-1", kind: "question", body: "Hello", blocking: true });
    expect((await requestPageWrite(form({ action: "post", kind: "question", body: "Hello" }))).input).toEqual({ key: "FE-1", kind: "question", body: "Hello", blocking: false });
    expect((await requestPageWrite(form({ ...fields, kind: "answer" }))).input).toEqual({ key: "FE-1", kind: "answer", body: "Hello", questionId: "a-question" });
  });

  it("decline, done, reassign and withdraw run the operations that propose them", async () => {
    expect(await requestPageWrite(form({ action: "decline" }))).toMatchObject({ commandId: "requests.set_status", input: { key: "FE-1", state: "declined" } });
    expect(await requestPageWrite(form({ action: "done" }))).toMatchObject({ commandId: "requests.set_status", input: { key: "FE-1", state: "done" } });
    expect(await requestPageWrite(form({ action: "reassign", team: "QA" }))).toMatchObject({ commandId: "requests.propose", input: { kind: "reassign", key: "FE-1", team: "QA" } });
    expect(await requestPageWrite(form({ action: "withdraw" }))).toMatchObject({ commandId: "requests.propose", input: { kind: "withdraw", key: "FE-1" } });
  });

  it("proposes a due date or its removal, naming the revision the page showed", async () => {
    expect((await requestPageWrite(form({ action: "due_date", dueDate: "2026-12-01", revision: "3" }))).input).toEqual({ kind: "due_date", key: "FE-1", dueDate: "2026-12-01", expectedRevision: 3 });
    expect((await requestPageWrite(form({ action: "remove_due_date", revision: "3" }))).input).toEqual({ kind: "due_date", key: "FE-1", dueDate: null, expectedRevision: 3 });
    // A form that names no revision names none, which the operation refuses as /api/v1 refuses a missing If-Match.
    expect((await requestPageWrite(form({ action: "due_date", dueDate: "2026-12-01", revision: "three" }))).input).toEqual({ kind: "due_date", key: "FE-1", dueDate: "2026-12-01" });
  });

  it("changes the packet's text fields and keeps the rest of the packet as it is", async () => {
    const current = {
      schema_version: "1-beta",
      kind: "contract_change",
      due_date: "2026-11-02",
      untrusted: {
        need: "Old need.",
        acceptance_criteria: ["Old."],
        links: [{ url: "https://example.com/old" }],
        contract: { api: "billing" },
        extensions: { "com.example": { a: 1 } },
      },
    };
    const reads: unknown[] = [];
    const planned = await plan(form({ action: "change_packet", revision: "2", need: "New need.", acceptanceCriteria: "One.\nTwo.", codeRefs: "acme/web src main" }), async (commandId, input) => {
      reads.push([commandId, input]);
      return { ok: true, output: { revision: 2, packet: current } };
    });
    expect(reads).toEqual([["packets.get", { key: "FE-1" }]]);
    expect(planned).toEqual({
      action: "change_packet",
      commandId: "proposals.propose",
      input: {
        kind: "scope",
        key: "FE-1",
        expectedRevision: 2,
        packet: {
          schema_version: "1-beta",
          kind: "contract_change",
          due_date: "2026-11-02",
          untrusted: {
            need: "New need.",
            acceptance_criteria: ["One.", "Two."],
            code_refs: [{ repository: "acme/web", path: "src", ref: "main" }],
            contract: { api: "billing" },
            extensions: { "com.example": { a: 1 } },
          },
        },
      },
    });
  });

  it("gives back the refusal of the packet's read, and writes nothing", async () => {
    const problem = { type: "https://tiehall.com/problems/record-not-found", title: "Not found", status: 404, detail: "There is no such request." };
    const writes: string[] = [];
    const state = await runRequestPageAction(form({ action: "change_packet", revision: "1", need: "New." }), {
      read: async () => ({ ok: false, problem }),
      write: async (commandId) => {
        writes.push(commandId);
        return { ok: true, output: {} };
      },
    });
    expect(state).toEqual({ ok: false, problem });
    expect(writes).toEqual([]);
  });

  it("refuses a form that names no action of the page with 400, and writes nothing", async () => {
    const writes: string[] = [];
    const state = await runRequestPageAction(form({ action: "members.remove" }), {
      read: noRead,
      write: async (commandId) => {
        writes.push(commandId);
        return { ok: true, output: {} };
      },
    });
    expect(state).toMatchObject({ ok: false, problem: { status: 400, errors: [{ path: ["action"] }] } });
    expect(writes).toEqual([]);
  });

  it("hands the write the form's CSRF token, and gives back its refusal or that it ran", async () => {
    const seen: unknown[] = [];
    const refused = await runRequestPageAction(form({ action: "claim" }), {
      read: noRead,
      write: async (commandId, input, csrf) => {
        seen.push([commandId, input, csrf]);
        return { ok: false, problem: { type: "https://tiehall.com/problems/conflict", title: "Conflict", status: 409, detail: "The request is already claimed." } };
      },
    });
    expect(seen).toEqual([["requests.claim", { key: "FE-1" }, "a-token"]]);
    expect(refused).toEqual({ ok: false, action: "claim", problem: { type: "https://tiehall.com/problems/conflict", title: "Conflict", status: 409, detail: "The request is already claimed." } });
    expect(await runRequestPageAction(form({ action: "claim" }), { read: noRead, write: async () => ({ ok: true, output: { key: "FE-1" } }) })).toEqual({ ok: true, action: "claim" });
    expect(await runRequestPageAction(form({ action: "decline" }), { read: noRead, write: async () => ({ ok: true, output: { proposal: { id: "p-1" } } }) })).toEqual({
      ok: true,
      action: "decline",
      proposal: { id: "p-1" },
    });
  });
});
