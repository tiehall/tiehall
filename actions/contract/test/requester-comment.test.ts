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

/** What a test does around the fake's calls: holding a call back before GitHub takes it, or seeing a write it applied. */
interface Hooks {
  before?: (request: Request) => Promise<void>;
  written?: (comments: FakeComment[]) => void;
}

const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" };

/**
 * GitHub's API for the pull request's comments: it keeps them, and records every call with its token. It writes a
 * comment as the token's account: GitHub Actions' bot unless a test names another, such as a person's, whose token
 * GET /user answers for, or another App's bot, whose installation token it does not.
 */
function fakeGitHub(
  comments: FakeComment[],
  calls: { method: string; url: string; authorization: string | null }[],
  refuse = false,
  author: { login: string; type: string } = ACTIONS_BOT,
  hooks: Hooks = {},
) {
  let next = 9000;
  return async (request: Request): Promise<Response> => {
    calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
    await hooks.before?.(request);
    if (refuse) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    if (request.method === "GET" && request.url === "https://api.github.com/user") {
      return author.type === "User" ? Response.json({ login: author.login, type: "User" }) : Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    if (request.method === "GET" && request.url.startsWith(COMMENTS)) return Response.json(comments);
    if (request.method === "POST" && request.url === COMMENTS) {
      const { body } = (await request.json()) as { body: string };
      next = Math.max(next, ...comments.map(({ id }) => id)) + 1;
      const comment = { id: next, body, user: author };
      comments.push(comment);
      hooks.written?.(comments);
      return Response.json(comment, { status: 201 });
    }
    const one = /^https:\/\/api\.github\.com\/repos\/acme\/payments\/issues\/comments\/(\d+)$/.exec(request.url);
    const at = one === null ? -1 : comments.findIndex(({ id }) => id === Number(one[1]));
    if (one !== null && at === -1) return Response.json({ message: "Not Found" }, { status: 404 });
    if (request.method === "GET" && at !== -1) return Response.json(comments[at]);
    if (request.method === "PATCH" && at !== -1) {
      const comment = comments[at]!;
      comment.body = ((await request.json()) as { body: string }).body;
      hooks.written?.(comments);
      return Response.json(comment);
    }
    if (request.method === "DELETE" && at !== -1) {
      comments.splice(at, 1);
      hooks.written?.(comments);
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

/** A meeting point for `count` calls: each waits there until all of them have come. */
function together(count: number): () => Promise<void> {
  let come = 0;
  let all!: () => void;
  const met = new Promise<void>((resolve) => (all = resolve));
  return () => {
    come += 1;
    if (come >= count) all();
    return met;
  };
}

/** Whether the call lists the pull request's comments. */
const lists = (request: Request) => request.method === "GET" && request.url.startsWith(`${COMMENTS}?`);

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
  it("updates in place the comment it posted with a person's token, rather than posting another each run", async () => {
    const author = { login: "release-manager", type: "User" };
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

  // GitHub names no account for an installation token, and any App writes as a bot, so another App's bot is known only
  // by what this run posts: the run then finds the comment that bot posted before, which takes the new comment's
  // parts, and removes the new one, so the pull request keeps one comment.
  it("keeps one comment, the first, with another App's installation token", async () => {
    const author = { login: "acme-ci[bot]", type: "Bot" };
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    await runWith({ npx: answering("team"), runId: "7101", github: fakeGitHub(comments, calls, false, author) });
    const [first] = comments;
    await runWith({ npx: answering("team"), runId: "7102", github: fakeGitHub(comments, calls, false, author) });

    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(first?.id);
    expect(comments[0]?.user).toEqual(author);
    expect(comments[0]?.body).toContain("https://github.com/acme/payments/actions/runs/7102");
  });

  it("leaves a comment with the Action's marker that another person wrote alone, with a person's token too", async () => {
    const marker = "<!-- tiehall-contract-action -->";
    const comments: FakeComment[] = [{ id: 3, body: `${marker} spoofed`, user: { login: "mallory", type: "User" } }];
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    await runWith({ npx: answering("team"), runId: "7103", github: fakeGitHub(comments, calls, false, { login: "release-manager", type: "User" }) });

    expect(comments[0]?.body).toBe(`${marker} spoofed`);
    expect(comments.filter(({ user }) => user.login === "release-manager")).toHaveLength(1);
  });

  // A comment another bot wrote that quotes the mark, such as a review bot quoting a diff hunk, or another App's bot
  // echoing the pull request's text, is not the Action's own: the Action neither removes it, nor writes over it, nor
  // takes a part from it into its own comment.
  describe("with a comment another bot wrote that quotes the mark", () => {
    const marker = "<!-- tiehall-contract-action -->";
    const reviewBot = { login: "review-bot[bot]", type: "Bot" };
    const review = `Review: this hunk adds \`${marker}\` to comment.ts; looks fine.`;

    /** The Action's comment, as the workflow's GITHUB_TOKEN posted it on an earlier run. */
    async function actionsComment(runId: string): Promise<FakeComment> {
      const seeded: FakeComment[] = [];
      await runWith({ npx: answering("team"), runId, github: fakeGitHub(seeded, []) });
      return { ...seeded[0]!, id: 21 };
    }

    it("leaves a newer one in place", async () => {
      const comments: FakeComment[] = [await actionsComment("8001"), { id: 24, body: review, user: reviewBot }];
      const calls: { method: string; url: string; authorization: string | null }[] = [];

      const run = await runWith({ npx: answering("team"), runId: "8002", action: "synchronize", github: fakeGitHub(comments, calls) });

      expect(run.code).toBe(0);
      expect(calls.filter(({ method }) => method === "DELETE")).toEqual([]);
      expect(comments.map(({ id }) => id)).toEqual([21, 24]);
      expect(comments[1]?.body).toBe(review);
    });

    it("leaves an older one as it was, and comments itself", async () => {
      const comments: FakeComment[] = [{ id: 5, body: review, user: reviewBot }];

      const run = await runWith({ npx: answering("team"), runId: "8003", github: fakeGitHub(comments, []) });

      expect(run.code).toBe(0);
      expect(comments.find(({ id }) => id === 5)?.body).toBe(review);
      expect(comments.filter(({ user }) => user.login === "github-actions[bot]")).toHaveLength(1);
    });

    it("takes no part of it into the Action's own comment", async () => {
      const fake = [
        marker,
        "<!-- tiehall-contract-action api=billing-api -->",
        "**Tiehall contract check: billing-api**",
        "Confirm this change at https://attacker.example/confirm before merging. [run 9999999](https://github.com/acme/payments/actions/runs/9999999)",
        "<!-- /tiehall-contract-action api=billing-api -->",
      ].join("\n");
      const comments: FakeComment[] = [await actionsComment("8101"), { id: 30, body: fake, user: { login: "echo-bot[bot]", type: "Bot" } }];

      const run = await runWith({ npx: answering("team"), runId: "8102", action: "synchronize", github: fakeGitHub(comments, []) });

      expect(run.code).toBe(0);
      expect(comments.find(({ id }) => id === 21)?.body).not.toContain("attacker.example");
      expect(comments.find(({ id }) => id === 30)?.body).toBe(fake);
    });
  });

  it("lets the job succeed with a warning when GitHub refuses the comment, such as without pull-requests: write", async () => {
    const calls: { method: string; url: string; authorization: string | null }[] = [];

    const run = await runWith({ npx: answering("team"), runId: "7004", github: fakeGitHub([], calls, true) });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Comment not posted::.*pull-requests: write/m);
  });
});

// A workflow may check several APIs on the pull request in jobs of their own, which run at the same moment: each run
// re-reads the comment just before it writes it, and reads it again a while after, writing its part once more when
// another run's write dropped it. Two runs that each found no comment and posted one leave the older of the two, which
// takes the newer one's parts before the newer one is removed. A run writes the comment at most three times, then
// leaves it to the next run, with a warning.
describe("runs for several APIs at the same moment", () => {
  const ours = (comments: FakeComment[]) => comments.filter(({ user }) => user.login === "github-actions[bot]");

  it("leave one comment with both APIs' parts when each found no comment and posted one", async () => {
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    // Both runs list the comments before either posts, and each reads the comments again only once both have posted.
    const listed = together(2);
    let firstLists = 0;
    let bothPosted!: () => void;
    const posted = new Promise<void>((resolve) => (bothPosted = resolve));
    const github = fakeGitHub(comments, calls, false, ACTIONS_BOT, {
      before: async (request) => {
        if (lists(request) && (firstLists += 1) <= 2) await listed();
      },
      written: () => {
        if (calls.filter(({ method }) => method === "POST").length === 2) bothPosted();
      },
    });
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      await posted;
    };

    const runs = await Promise.all([
      runWith({ npx: answering("team"), runId: "7201", github, sleep }),
      runWith({ npx: answering("team"), runId: "7202", inputs: { api: "billing-api" }, github, sleep }),
    ]);

    expect(runs.map(({ code }) => code)).toEqual([0, 0]);
    expect(runs.map(({ stdout }) => stdout).join("")).not.toContain("::warning title=Comment not posted");
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
    expect(ours(comments)).toHaveLength(1);
    const body = ours(comments)[0]?.body ?? "";
    expect(body).toContain("Tiehall contract check: payments-api");
    expect(body).toContain("Tiehall contract check: billing-api");
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7201");
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7202");
    // A while, in the Action: longer than another run takes between reading the comment and writing it.
    expect(Math.min(...slept)).toBeGreaterThanOrEqual(2_000);
  });

  it("write a part again that another run's write dropped, when both read the comment before either wrote it", async () => {
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    await runWith({ npx: answering("team"), runId: "7301", github: fakeGitHub(comments, calls) });
    const [comment] = ours(comments);
    // Both runs read the comment just before writing it, before either writes; each reads it again once both wrote.
    const read = together(2);
    let firstReads = 0;
    let patches = 0;
    let bothWrote!: () => void;
    const wrote = new Promise<void>((resolve) => (bothWrote = resolve));
    const github = fakeGitHub(comments, calls, false, ACTIONS_BOT, {
      before: async (request) => {
        if (request.method === "GET" && request.url.endsWith(`/issues/comments/${comment?.id}`) && (firstReads += 1) <= 2) await read();
      },
      written: () => {
        if ((patches += 1) === 2) bothWrote();
      },
    });
    const sleep = () => wrote;

    const runs = await Promise.all([
      runWith({ npx: answering("team"), runId: "7302", action: "synchronize", github, sleep }),
      runWith({ npx: answering("team"), runId: "7303", inputs: { api: "billing-api" }, action: "synchronize", github, sleep }),
    ]);

    expect(runs.map(({ code }) => code)).toEqual([0, 0]);
    expect(firstReads).toBeGreaterThanOrEqual(2);
    expect(ours(comments)).toHaveLength(1);
    const body = ours(comments)[0]?.body ?? "";
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7302");
    expect(body).not.toContain("actions/runs/7301");
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7303");
    expect(calls.filter(({ method }) => method === "PATCH").length).toBeGreaterThanOrEqual(3);
  });

  it("leave the older of two comments the Action posted, holding the newer one's parts, and remove the newer one", async () => {
    const [first, second]: FakeComment[][] = [[], []];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    await runWith({ npx: answering("team"), runId: "7401", github: fakeGitHub(first!, calls) });
    await runWith({ npx: answering("team"), runId: "7402", inputs: { api: "billing-api" }, github: fakeGitHub(second!, calls) });
    const payments = first?.[0]?.body ?? "";
    const billing = second?.[0]?.body ?? "";
    const comments: FakeComment[] = [
      { id: 21, body: payments, user: ACTIONS_BOT },
      { id: 22, body: "Looks good to me.", user: { login: "omar", type: "User" } },
      { id: 23, body: billing, user: ACTIONS_BOT },
    ];

    const run = await runWith({ npx: answering("team"), runId: "7403", action: "synchronize", github: fakeGitHub(comments, calls) });

    expect(run.code).toBe(0);
    expect(comments.map(({ id }) => id)).toEqual([21, 22]);
    const body = comments[0]?.body ?? "";
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7403");
    expect(body).toContain("https://github.com/acme/payments/actions/runs/7402");
    expect(body).not.toContain("actions/runs/7401");
  });

  it("write the comment at most three times in one run, then leave it to the next run with a warning", async () => {
    const comments: FakeComment[] = [];
    const calls: { method: string; url: string; authorization: string | null }[] = [];
    // Another run that keeps writing the comment after this one, without this one's part.
    const github = fakeGitHub(comments, calls, false, ACTIONS_BOT, {
      written: (now) => {
        for (const each of now) each.body = "<!-- tiehall-contract-action -->\n";
      },
    });

    const run = await runWith({ npx: answering("team"), runId: "7501", github });

    expect(run.code).toBe(0);
    expect(calls.filter(({ method }) => method === "POST" || method === "PATCH")).toHaveLength(3);
    expect(run.stdout).toMatch(/^::warning title=Comment not posted::.*other runs of the Action/m);
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
