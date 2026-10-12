import { randomUUID } from "node:crypto";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHomeRoute,
  createInstallGitHub,
  createMirrorRetryRoute,
  MIRROR_RETRY_PATH,
  mirrorGoneText,
  mirrorRequest,
  mirrorRequests,
  type Banner,
  type InstallGitHub,
  type JobSender,
  type WebSessionCaller,
} from "../src/index.ts";
import { providerOnStub, type StubProvider } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf, tokenOf } from "./support/requests.ts";
import { shellReader } from "./support/shell.ts";

// Failed mirror jobs (tracker-mirrors: Failed mirror jobs are shown with a
// Retry button; design.md, Decisions this change rests on: D28 #41, #83). A
// mirror job is tried 5 times, a fixed 14 minutes apart, so its fifth attempt
// comes between 50 and 70 minutes after its first however long each attempt
// runs, up to its limit; when the fifth fails too, it moves to the dead-letter
// queue, which the worker works to record it. A recorded job is a banner in
// the web UI, with a Retry button, for the install's admins and the members
// of the team the request is to, and for no one else. Retry runs the job
// again, and the banner goes once a mirror job of the request succeeds. The
// whole path through the real job queue is in mirror-dead-letters.test.ts,
// with a newer job of the request that supersedes a failed one
// (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (76)). A mirror issue GitHub answers with 404 or 410, as for one
// someone deleted, is marked gone: the job writes to it no more, adds one
// notice to the request, and succeeds, so its banner goes (D55 (79)).

let install: TestInstall;
let stub: GitHubStub;
let provider: StubProvider;
let ada: WebSessionCaller;
let ayse: WebSessionCaller;
let mo: WebSessionCaller;
let alice: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  provider = await providerOnStub(install, stub, ["ayse"], { repositories: ["acme/fe-intake"] });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
  ayse = sessionOf(await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") }));
  mo = sessionOf(await addUser(install.owner, { login: "mo" }));
  alice = sessionOf(await addUser(install.owner, { login: "alice" }));
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const mobile = await addTeam(install.owner, "MOBILE");
  await joinTeams(install.owner, alice.userId, be);
  await joinTeams(install.owner, ayse.userId, fe);
  await joinTeams(install.owner, mo.userId, mobile);
  await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  install.sentJobs.splice(0);
  await install.owner.query("DELETE FROM mirror_failures");
});

/** Runs the request's mirror job as the worker does, reaching GitHub as this App. */
async function runMirrorJob(requestId: string, github: InstallGitHub = provider.github): Promise<void> {
  await mirrorRequests.handle(
    { id: randomUUID(), queue: mirrorRequest.queue, data: { requestId }, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github, installUrl: URL_OF_INSTALL },
  );
}

/** What the worker does with the request's mirror job once it reached the dead-letter queue, with the worker's job queue when given. */
async function deadLetter(requestId: string, jobs?: JobSender): Promise<void> {
  await mirrorRequests.deadLetter!(
    { id: randomUUID(), queue: mirrorRequest.deadLetterQueue, data: { requestId }, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), ...(jobs === undefined ? {} : { jobs }) },
  );
}

/** A request Alice opens to FE, which Ayşe claims; its key and id. */
async function claimedRequest(): Promise<{ key: string; id: string }> {
  const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice.userId, { targetTeam: "FE" });
  await install.execute("requests.claim", ayse, { key: request.key });
  install.sentJobs.splice(0);
  return request;
}

async function bannersOf(session: WebSessionCaller): Promise<Banner[]> {
  return ((await install.execute("install.get_banners", session, {}, { readOnly: true })) as { banners: Banner[] }).banners;
}

function decoded(html: string): string {
  return html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

async function homePage(session: WebSessionCaller): Promise<string> {
  const route = createHomeRoute({
    session: async () => session,
    secret: () => install.authSecret,
    logger: install.logger,
    banners: (caller) => bannersOf(caller),
    shell: shellReader(install.execute),
  });
  const answer = await route(new Request(`${URL_OF_INSTALL}/`, { headers: { accept: "text/html" } }));
  expect(answer.status).toBe(200);
  return decoded(await answer.text());
}

/** Posts the banner's Retry form as the browser does, from a page of the install, with the session's CSRF token unless told otherwise. */
async function pressRetry(session: WebSessionCaller, requestId: string, options: { csrf?: string; back?: string } = {}): Promise<Response> {
  const route = createMirrorRetryRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
  const csrf = options.csrf ?? install.fromThePage(session).csrfToken ?? "";
  return route(
    new Request(`${URL_OF_INSTALL}${MIRROR_RETRY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", accept: "text/html" },
      body: new URLSearchParams({ csrf, requestId, back: options.back ?? "/" }).toString(),
    }),
  );
}

const MIRROR_BANNER = "could not update the mirror issue of";

describe("the mirror job's attempts", () => {
  it("are 5, a fixed 14 minutes apart, so the fifth comes between 50 and 70 minutes after the first however long each attempt runs, up to its limit", () => {
    const { retryLimit, retryDelaySeconds, retryBackoff, expireInSeconds } = mirrorRequest.settings;
    expect(retryLimit + 1).toBe(5);
    expect(retryBackoff).toBe(false);
    expect(retryDelaySeconds).toBe(14 * 60);
    // The fifth attempt starts after 4 waits and the 4 attempts before it, each of which runs for no time at the least, and until it expires at the most.
    expect(4 * retryDelaySeconds).toBeGreaterThanOrEqual(50 * 60);
    expect(4 * (retryDelaySeconds + expireInSeconds)).toBeLessThanOrEqual(70 * 60);
  });
});

describe("a mirror job in the dead-letter queue", () => {
  it("is a banner with a Retry button for the admins and the members of the request's target team, and for no one else", async () => {
    const request = await claimedRequest();

    await deadLetter(request.id);

    for (const session of [ada, ayse]) {
      const banners = await bannersOf(session);
      expect(banners).toEqual([
        {
          id: `mirror_failed:${request.id}`,
          text: expect.stringContaining(`Tiehall ${MIRROR_BANNER} ${request.key}`),
          link: { href: `/${request.key}`, text: `Open ${request.key}` },
          button: { label: "Retry", action: MIRROR_RETRY_PATH, fields: { requestId: request.id } },
        },
      ]);
      const home = await homePage(session);
      expect(home).toContain(`${MIRROR_BANNER} ${request.key}`);
      expect(home).toContain(`<form method="post" action="${MIRROR_RETRY_PATH}">`);
      expect(home).toContain(`<input type="hidden" name="requestId" value="${request.id}">`);
      expect(home).toContain(`<input type="hidden" name="csrf" value="${install.fromThePage(session).csrfToken}">`);
    }
    // A member of MOBILE who is not an admin, and the requester, who is not a member of FE, see nothing of it.
    for (const session of [mo, alice]) {
      expect(await bannersOf(session)).toEqual([]);
      expect(await homePage(session)).not.toContain(MIRROR_BANNER);
    }
  });

  it("is shown once however often it reaches the dead-letter queue, with the time of the latest failure", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    await deadLetter(request.id);
    expect((await bannersOf(ada)).filter(({ id }) => id.startsWith("mirror_failed:"))).toHaveLength(1);
  });

  it("is not shown when a newer job of the request took it out of the queue before the worker reached it, as that job records it", async () => {
    const request = await claimedRequest();
    // The queue holds no failed job of the request any more: a newer one superseded it (mirror-jobs.ts).
    const superseded: JobSender = { send: async () => {}, holdsFailed: async () => false };

    await deadLetter(request.id, superseded);

    expect(await bannersOf(ada)).toEqual([]);
    // Without a newer job, the failed job is in the queue still, and is shown.
    await deadLetter(request.id, { send: async () => {}, holdsFailed: async () => true });
    expect(await bannersOf(ada)).toHaveLength(1);
  });

  it("follows the request to its target team: a reassigned request's banner shows to the members of its new team", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'MOBILE'");
    await install.owner.query("UPDATE requests SET target_team_id = $2 WHERE id = $1", [request.id, rows[0]!.id]);
    try {
      expect(await bannersOf(ayse)).toEqual([]);
      expect(await bannersOf(mo)).toHaveLength(1);
    } finally {
      const { rows: fe } = await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'FE'");
      await install.owner.query("UPDATE requests SET target_team_id = $2 WHERE id = $1", [request.id, fe[0]!.id]);
    }
  });
});

describe("Retry", () => {
  it("runs the request's mirror job again, for a member of the request's target team, and leads back to the page", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);

    const answer = await pressRetry(ayse, request.id, { back: "/admin" });

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/admin");
    expect(install.sentJobs).toEqual([{ queue: mirrorRequest.queue, data: { requestId: request.id }, singletonKey: request.id }]);
    // The banner stays until the job succeeds, and says it is being tried again.
    const [banner] = await bannersOf(ada);
    expect(banner?.text).toContain("Tiehall is trying again");
  });

  it("runs it again for an admin", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    await expect(install.execute("mirrors.retry_job", ada, { requestId: request.id })).resolves.toEqual({ requestId: request.id });
    expect(install.sentJobs.map(({ queue }) => queue)).toEqual([mirrorRequest.queue]);
  });

  it("is refused with 403 for a member who does not see the banner, and changes nothing", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    for (const session of [mo, alice]) {
      await expect(install.execute("mirrors.retry_job", session, { requestId: request.id })).rejects.toMatchObject({ reason: "forbidden" });
      expect((await pressRetry(session, request.id)).status).toBe(403);
    }
    expect(install.sentJobs).toEqual([]);
    expect((await bannersOf(ada))[0]?.text).not.toContain("Tiehall is trying again");
  });

  it("is refused with 409 for a request whose mirror job has not failed", async () => {
    const request = await claimedRequest();
    await expect(install.execute("mirrors.retry_job", ayse, { requestId: request.id })).rejects.toMatchObject({ reason: "conflict" });
    expect(install.sentJobs).toEqual([]);
  });

  it("is refused without the web UI's write checks, and offered on no agent surface", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    expect((await pressRetry(ayse, request.id, { csrf: "forged" })).status).toBe(403);
    await expect(install.execute("mirrors.retry_job", tokenOf(ayse.userId), { requestId: request.id })).rejects.toMatchObject({ reason: "route-not-found" });
    expect(install.sentJobs).toEqual([]);
  });

  it("leads back only to a page of the install", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    const answer = await pressRetry(ayse, request.id, { back: "//elsewhere.example/" });
    expect(answer.headers.get("location")).toBe("/");
  });
});

describe("the banner", () => {
  it("goes once a mirror job of the request succeeds", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    await install.execute("mirrors.retry_job", ayse, { requestId: request.id });

    await runMirrorJob(request.id);

    expect(await bannersOf(ada)).toEqual([]);
    expect(await bannersOf(ayse)).toEqual([]);
    const { rows } = await install.owner.query("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
    expect(rows[0]?.issue).not.toBeNull();
  });

  it("stays while the job fails again", async () => {
    const request = await claimedRequest();
    await deadLetter(request.id);
    // No connected installation covers the intake repository: the job fails, and the banner stays.
    await install.owner.query("UPDATE github_installations SET suspended_at = now()");
    try {
      await expect(runMirrorJob(request.id)).rejects.toThrow();
      // Besides the banner about the suspended installation itself.
      expect((await bannersOf(ada)).filter(({ id }) => id.startsWith("mirror_failed:"))).toHaveLength(1);
    } finally {
      await install.owner.query("UPDATE github_installations SET suspended_at = NULL");
    }
  });
});

describe("a mirror issue GitHub no longer has", () => {
  /** The request's mirror issue, as its row records it: its number, and when it was marked gone. */
  async function mirrorOf(requestId: string): Promise<{ issue: number; goneAt: Date | null }> {
    const { rows } = await install.owner.query<{ issue: string; gone_at: Date | null }>("SELECT issue, gone_at FROM mirrors WHERE request_id = $1", [requestId]);
    expect(rows).toHaveLength(1);
    return { issue: Number(rows[0]!.issue), goneAt: rows[0]!.gone_at };
  }

  async function noticesOf(requestId: string): Promise<{ body: string; surface: string | null }[]> {
    const { rows } = await install.owner.query<{ body: string; surface: string | null }>(
      `SELECT v.body, m.surface FROM messages m JOIN message_versions v ON v.message_id = m.id
        WHERE m.request_id = $1 AND m.actor_kind = 'system' ORDER BY m.number`,
      [requestId],
    );
    return rows;
  }

  /** The calls Tiehall made to GitHub about the intake repository's issues since this point. */
  const issueCalls = (from: number) => stub.received.slice(from).filter(({ host, path }) => host === "api" && path.startsWith("/repos/acme/fe-intake/issues"));

  it("is marked gone at the job's next write, which adds one notice to the request and succeeds, so the job's banner goes", async () => {
    const request = await claimedRequest();
    await runMirrorJob(request.id);
    const { issue } = await mirrorOf(request.id);
    // Someone deletes the issue on GitHub, which then answers every call about it with 410; the request changes, and its job had failed.
    await stub.deleteIssue("acme/fe-intake", issue, { by: "ayse" });
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await deadLetter(request.id);
    expect(await bannersOf(ada)).toHaveLength(1);

    await runMirrorJob(request.id);

    expect((await mirrorOf(request.id)).goneAt).not.toBeNull();
    expect(await noticesOf(request.id)).toEqual([{ body: mirrorGoneText({ tracker: "github", mirroredKey: request.key, key: request.key }), surface: "github" }]);
    expect(await bannersOf(ada)).toEqual([]);
    expect(await bannersOf(ayse)).toEqual([]);
  });

  it("is written to no more, and not opened again, whatever the request does after: no call reaches GitHub, and no second notice is added", async () => {
    const request = await claimedRequest();
    await runMirrorJob(request.id);
    await stub.deleteIssue("acme/fe-intake", (await mirrorOf(request.id)).issue, { by: "ayse" });
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    await runMirrorJob(request.id);
    const from = stub.received.length;

    await install.execute("messages.post", ayse, { key: request.key, kind: "question", blocking: false, body: "Which currency?" });
    await install.execute("requests.set_status", ayse, { key: request.key, state: "done" });
    await runMirrorJob(request.id);

    expect(issueCalls(from)).toEqual([]);
    expect(await noticesOf(request.id)).toHaveLength(1);
    // Its row stays the request's one mirror: no issue is made in its place.
    expect((await mirrorOf(request.id)).goneAt).not.toBeNull();
  });

  it("is marked gone on GitHub's 404 too, as for an issue moved out of Tiehall's reach", async () => {
    const request = await claimedRequest();
    await runMirrorJob(request.id);
    const { issue } = await mirrorOf(request.id);
    await install.execute("requests.set_status", ayse, { key: request.key, state: "in_progress" });
    const movedAway: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith(`/repos/acme/fe-intake/issues/${issue}`)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return fetch(input, init);
    };

    await runMirrorJob(request.id, createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: movedAway, logger: install.logger }));

    expect((await mirrorOf(request.id)).goneAt).not.toBeNull();
    expect(await noticesOf(request.id)).toHaveLength(1);
  });
});
