import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runActionWith, type Npx, type RunOptions } from "./support/runner.ts";

// The comment on the provider PR when the provider team is the requester
// (contract-changes: The provider PR's author is the requester; design.md,
// Decisions this change rests on: D28 #75, #76; design.md, Design rules:
// Contract changes). When Tiehall answers a report that the provider team
// alone requests its changes, because the pull request's author is no member
// of the install, the contract Action comments on the pull request with the
// workflow's own GITHUB_TOKEN, once per pull request, and updates that comment
// in place on later runs, so the pull request keeps exactly one such comment,
// which shows the latest run for each API the workflow checks. Here GitHub's API is a fake that keeps
// the pull request's comments, and the CLI a stand-in that answers as the
// install does.

const scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-comment-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TOKEN = "ghs_workflow-token-1";
const COMMENTS = "https://api.github.com/repos/acme/payments/issues/310/comments";

interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

/**
 * GitHub's API for the pull request's comments: it keeps them, and records every call with its token. It writes a
 * comment as the token's account: GitHub Actions' bot unless a test names another, such as a person's, whose token
 * GET /user answers for, or another App's bot, whose installation token it does not.
 */
function fakeGitHub(
  comments: FakeComment[],
  calls: { method: string; url: string; authorization: string | null }[],
  refuse = false,
  author: { login: string; type: string } = { login: "github-actions[bot]", type: "Bot" },
) {
  let next = 9000;
  return async (request: Request): Promise<Response> => {
    calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
    if (refuse) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    if (request.method === "GET" && request.url === "https://api.github.com/user") {
      return author.type === "User" ? Response.json({ login: author.login, type: "User" }) : Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    if (request.method === "GET" && request.url.startsWith(COMMENTS)) return Response.json(comments);
    if (request.method === "POST" && request.url === COMMENTS) {
      const { body } = (await request.json()) as { body: string };
      const comment = { id: (next += 1), body, user: author };
      comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    const patched = /^https:\/\/api\.github\.com\/repos\/acme\/payments\/issues\/comments\/(\d+)$/.exec(request.url);
    if (request.method === "PATCH" && patched !== null) {
      const comment = comments.find(({ id }) => id === Number(patched[1]));
      if (comment === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      comment.body = ((await request.json()) as { body: string }).body;
      return Response.json(comment);
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

/** The CLI's stand-in, answering that this requests the changes. */
const answering = (kind: "author" | "team"): Npx => async (args) => ({
  status: 0,
  stdout: JSON.stringify({ id: "4f9c1d3e-8b7a-4c2d-9e1f-0a2b3c4d5e6f", api: args[args.indexOf("--api") + 1], receivedAt: "2026-10-02T09:00:00.000Z", requester: { kind, team: "PAY" } }),
  stderr: "",
});

/** A run of the Action, on this run of the workflow, with GitHub's API faked. */
function runWith(options: RunOptions & { runId: string; github: (request: Request) => Promise<Response> }) {
  return runActionWith(scratch, {
    ...options,
    inputs: { "github-token": TOKEN, ...options.inputs },
    env: { GITHUB_API_URL: "https://api.github.com", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: options.runId, GITHUB_RUN_ATTEMPT: "1", ...options.env },
    fetch: options.github,
  });
}

describe("a report whose requester is the provider team", () => {
  it("makes the Action comment on the pull request once, with the workflow's GITHUB_TOKEN, naming the provider team", async () => {
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    const run = await runWith({ npx: answering("team"), runId: "7001", github: fakeGitHub(comments, calls) });

    expect(run.code).toBe(0);
    expect(comments).toHaveLength(1);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(calls.every(({ authorization }) => authorization === `Bearer ${TOKEN}`)).toBe(true);
    const [comment] = comments;
    expect(comment?.body).toContain("PAY");
    expect(comment?.body).toContain("https://tiehall.example.com");
    expect(comment?.body).toContain("https://github.com/acme/payments/actions/runs/7001");
  });

  it("updates that comment in place on a later run: the pull request has exactly one comment of the Action, which shows the latest run", async () => {
    const comments: FakeComment[] = [{ id: 1, body: "Looks good to me.", user: { login: "omar", type: "User" } }];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    const github = fakeGitHub(comments, calls);

    await runWith({ npx: answering("team"), runId: "7001", github });
    const second = await runWith({ npx: answering("team"), runId: "7002", action: "synchronize", github });

    expect(second.code).toBe(0);
    const ours = comments.filter(({ user }) => user.login === "github-actions[bot]");
    expect(ours).toHaveLength(1);
    expect(ours[0]?.body).toContain("https://github.com/acme/payments/actions/runs/7002");
    expect(ours[0]?.body).not.toContain("actions/runs/7001");
    expect(comments[0]).toEqual({ id: 1, body: "Looks good to me.", user: { login: "omar", type: "User" } });
    expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  });

  it("keeps one comment on the pull request for every API the workflow checks, each API's part showing its latest run", async () => {
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    const github = fakeGitHub(comments, calls);

    await runWith({ npx: answering("team"), runId: "7011", github });
    await runWith({ npx: answering("team"), runId: "7012", inputs: { api: "billing-api" }, github });
    await runWith({ npx: answering("team"), runId: "7013", action: "synchronize", github });

    const ours = comments.filter(({ user }) => user.login === "github-actions[bot]");
    expect(ours).toHaveLength(1);
    const body = ours[0]?.body ?? "";
    expect(body).toContain("Tiehall contract check: payments-api");
    expect(body).toContain("Tiehall contract check: billing-api");
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7012");
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7013");
    expect(body).not.toContain("actions/runs/7011");
  });

  it("leaves a comment that someone else wrote with the Action's marker alone, and comments itself", async () => {
    const marker = "<!-- tiehall-contract-action -->";
    const comments: FakeComment[] = [{ id: 2, body: `${marker} spoofed`, user: { login: "mallory", type: "User" } }];
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    await runWith({ npx: answering("team"), runId: "7003", github: fakeGitHub(comments, calls) });

    expect(comments[0]?.body).toBe(`${marker} spoofed`);
    expect(comments.filter(({ user }) => user.login === "github-actions[bot]")).toHaveLength(1);
  });

  // A job may give the Action a token of its own in github-token, such as a person's token or an App's installation
  // token: its comment is the one that account wrote, which a later run updates in place.
  it.each([
    ["a person's token", { login: "release-manager", type: "User" }],
    ["another App's installation token", { login: "acme-ci[bot]", type: "Bot" }],
  ])("updates in place the comment it posted with %s, rather than posting another each run", async (_token, author) => {
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    await runWith({ npx: answering("team"), runId: "7101", github: fakeGitHub(comments, calls, false, author) });
    await runWith({ npx: answering("team"), runId: "7102", github: fakeGitHub(comments, calls, false, author) });

    expect(comments).toHaveLength(1);
    expect(comments[0]?.user).toEqual(author);
    expect(comments[0]?.body).toContain("https://github.com/acme/payments/actions/runs/7102");
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  });

  it("leaves a comment with the Action's marker that another person wrote alone, with a person's token too", async () => {
    const marker = "<!-- tiehall-contract-action -->";
    const comments: FakeComment[] = [{ id: 3, body: `${marker} spoofed`, user: { login: "mallory", type: "User" } }];
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    await runWith({ npx: answering("team"), runId: "7103", github: fakeGitHub(comments, calls, false, { login: "release-manager", type: "User" }) });

    expect(comments[0]?.body).toBe(`${marker} spoofed`);
    expect(comments.filter(({ user }) => user.login === "release-manager")).toHaveLength(1);
  });

  it("lets the job succeed with a warning when GitHub refuses the comment, such as without pull-requests: write", async () => {
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    const run = await runWith({ npx: answering("team"), runId: "7004", github: fakeGitHub([], calls, true) });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Comment not posted::.*pull-requests: write/m);
  });
});

describe("no comment", () => {
  it("is posted when the pull request's author is the requester", async () => {
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    const run = await runWith({ npx: answering("author"), runId: "7005", github: fakeGitHub([], calls) });

    expect(run.code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("is posted when the report was not delivered", async () => {
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    const run = await runWith({ npx: async () => ({ status: 1, stdout: "", stderr: "Tiehall at https://tiehall.example.com could not be reached.\n" }), runId: "7006", github: fakeGitHub([], calls) });

    expect(run.code).toBe(0);
    expect(calls).toEqual([]);
  });
});
