import { describe, expect, it } from "vitest";
import { requestPageWrite, runRequestPageAction } from "../src/index.ts";

// What each form of a request's page runs (public-api: One definition per
// operation, the same on every surface; requests: Thread messages and
// blocking questions): the operation and the input an agent would send over
// /api/v1. A form that names no action the page has is refused with 400 and
// runs nothing. The actions against a running web app are tested in
// request-page-actions-browser.test.ts.

const form = (fields: Record<string, string>) => new URLSearchParams({ key: "FE-1", csrf: "a-token", ...fields });

describe("the forms of a request's page", () => {
  it("claim, start and release run requests.claim and requests.set_status", () => {
    expect(requestPageWrite(form({ action: "claim" }))).toEqual({ action: "claim", commandId: "requests.claim", input: { key: "FE-1" } });
    expect(requestPageWrite(form({ action: "start" }))).toEqual({ action: "start", commandId: "requests.set_status", input: { key: "FE-1", state: "in_progress" } });
    expect(requestPageWrite(form({ action: "release" }))).toEqual({ action: "release", commandId: "requests.set_status", input: { key: "FE-1", state: "open" } });
  });

  it("post sends a comment's text alone, a question's blocking box, and an answer's question", () => {
    const fields = { action: "post", body: "Hello", blocking: "on", questionId: "a-question" };
    expect(requestPageWrite(form({ ...fields, kind: "comment" })).input).toEqual({ key: "FE-1", kind: "comment", body: "Hello" });
    expect(requestPageWrite(form({ ...fields, kind: "question" })).input).toEqual({ key: "FE-1", kind: "question", body: "Hello", blocking: true });
    expect(requestPageWrite(form({ action: "post", kind: "question", body: "Hello" })).input).toEqual({ key: "FE-1", kind: "question", body: "Hello", blocking: false });
    expect(requestPageWrite(form({ ...fields, kind: "answer" })).input).toEqual({ key: "FE-1", kind: "answer", body: "Hello", questionId: "a-question" });
  });

  it("refuses a form that names no action of the page with 400, and writes nothing", async () => {
    const writes: string[] = [];
    const state = await runRequestPageAction(form({ action: "members.remove" }), async (commandId) => {
      writes.push(commandId);
      return { ok: true, output: {} };
    });
    expect(state).toMatchObject({ ok: false, problem: { status: 400, errors: [{ path: ["action"] }] } });
    expect(writes).toEqual([]);
  });

  it("hands the write the form's CSRF token, and gives back its refusal or that it ran", async () => {
    const seen: unknown[] = [];
    const refused = await runRequestPageAction(form({ action: "claim" }), async (commandId, input, csrf) => {
      seen.push([commandId, input, csrf]);
      return { ok: false, problem: { type: "https://tiehall.com/problems/conflict", title: "Conflict", status: 409, detail: "The request is already claimed." } };
    });
    expect(seen).toEqual([["requests.claim", { key: "FE-1" }, "a-token"]]);
    expect(refused).toEqual({ ok: false, action: "claim", problem: { type: "https://tiehall.com/problems/conflict", title: "Conflict", status: 409, detail: "The request is already claimed." } });
    expect(await runRequestPageAction(form({ action: "claim" }), async () => ({ ok: true, output: { key: "FE-1" } }))).toEqual({ ok: true, action: "claim" });
    expect(await runRequestPageAction(form({ action: "claim" }), async () => ({ ok: true, output: { proposal: { id: "p-1" } } }))).toEqual({ ok: true, action: "claim", proposal: { id: "p-1" } });
  });
});
