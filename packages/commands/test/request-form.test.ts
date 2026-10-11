import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNewRequestRoute, csrfTokenFor, NEW_REQUEST_PATH, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, tokenOf } from "./support/requests.ts";

// The web form that opens a request (agent-surfaces: Admins set a team's
// intake notes and required fields; requests: A request is addressed to a
// team of the install; requests: The requester picks the requesting team;
// public-api: One definition per operation, the same on every surface;
// design.md, Technical decisions: T3). A member picks the team the request is
// addressed to and the team of theirs it comes from, and writes its title and
// its packet: the need, and, if they give them, the acceptance criteria and
// code refs one per line, links one per line, and a due date. The form's POST
// passes the web UI's write checks and runs requests.create through
// execute(), as the member's web session, and leads to the new request's
// page at its URL; a refusal is a page that lists what failed and leads back
// to the form. A browser without a session is sent to sign in first.

let install: TestInstall;
let dana: WebSessionCaller;
let nola: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall();
  dana = { kind: "web_session", userId: await addUser(install.owner, { login: "dana" }), sessionId: randomUUID() };
  nola = { kind: "web_session", userId: await addUser(install.owner, { login: "nola" }), sessionId: randomUUID() };
  const fe = await addTeam(install.owner, "FE");
  const be = await addTeam(install.owner, "BE");
  await addTeam(install.owner, "QA");
  await joinTeams(install.owner, dana.userId, be, fe);
});

afterAll(async () => {
  await install?.close();
});

const route = (session: WebSessionCaller | undefined) =>
  createNewRequestRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

const get = (session: WebSessionCaller | undefined, query = "") =>
  route(session)(new Request(`${URL_OF_INSTALL}${NEW_REQUEST_PATH}${query}`, { headers: { accept: "text/html" } }));

/** The form, posted as the session from the install's own page, with its CSRF token. */
function post(session: WebSessionCaller, fields: Record<string, string>): Promise<Response> {
  return route(session)(
    new Request(`${URL_OF_INSTALL}${NEW_REQUEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ csrf: csrfTokenFor(install.authSecret, session.sessionId), ...fields }).toString(),
    }),
  );
}

describe("the web form that opens a request", () => {
  it("offers every team of the install to address, and the member's own teams to open it from", async () => {
    const answer = await get(dana);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await answer.text();
    const select = (id: string) => /<select id="([^"]+)"[^>]*>(.*?)<\/select>/gs.exec(html.slice(html.indexOf(`<select id="${id}"`)))?.[2] ?? "";
    expect([...select("targetTeam").matchAll(/<option value="([^"]+)"/g)].map(([, key]) => key)).toEqual(["BE", "FE", "QA"]);
    expect([...select("requestingTeam").matchAll(/<option value="([^"]+)"/g)].map(([, key]) => key)).toEqual(["BE", "FE"]);
    for (const label of ["To team", "From team", "Title", "What you need", "Acceptance criteria", "Code refs", "Links", "Due date"]) expect(html).toContain(`>${label}`);
    expect(html).toContain('<button type="submit">Open the request</button>');
  });

  it("opens the request with its packet, as the member's web session, and leads to its page", async () => {
    const answer = await post(dana, {
      targetTeam: "FE",
      requestingTeam: "BE",
      title: "Add a dark mode",
      need: "The settings page should follow the system's dark mode.",
      acceptanceCriteria: "It follows the system setting.\n\nA toggle overrides it.\n",
      codeRefs: "acme/web src/settings main\nacme/design",
      links: "https://design.example.com/dark Dark mode spec\nhttps://example.com/notes",
      dueDate: "2026-11-02",
    });
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/FE-1");
    const read = await callApi(install, tokenOf(dana.userId), "GET", "/api/v1/requests/FE-1");
    expect(read.body).toMatchObject({ key: "FE-1", state: "open", requester: { user: { id: dana.userId }, team: { key: "BE" } }, untrusted: { title: "Add a dark mode" } });
    const packet = await callApi(install, tokenOf(dana.userId), "GET", "/api/v1/requests/FE-1/packet");
    expect(packet.body.packet).toEqual({
      schema_version: "1-beta",
      kind: "request",
      due_date: "2026-11-02",
      untrusted: {
        need: "The settings page should follow the system's dark mode.",
        acceptance_criteria: ["It follows the system setting.", "A toggle overrides it."],
        code_refs: [{ repository: "acme/web", path: "src/settings", ref: "main" }, { repository: "acme/design" }],
        links: [{ url: "https://design.example.com/dark", title: "Dark mode spec" }, { url: "https://example.com/notes" }],
      },
    });
    const { rows } = await install.owner.query("SELECT actor_kind, surface FROM events WHERE type = 'request.opened' ORDER BY number DESC LIMIT 1");
    expect(rows).toEqual([{ actor_kind: "web_session", surface: "web" }]);
  });

  it("opens a request with only a title and a need, from the member's only team when they name none", async () => {
    const solo: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { login: "solo" }), sessionId: randomUUID() };
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'QA'");
    await joinTeams(install.owner, solo.userId, rows[0]!.id);
    const answer = await post(solo, { targetTeam: "FE", title: "Fix the footer", need: "The footer overlaps the content on phones." });
    expect(answer.status).toBe(303);
    const read = await callApi(install, tokenOf(solo.userId), "GET", answer.headers.get("location")!.replace("/", "/api/v1/requests/"));
    expect(read.body).toMatchObject({ requester: { team: { key: "QA" } } });
  });

  it("refuses a form without a title with 400, as the form again with the title's error beside it, and opens nothing", async () => {
    const before = await install.owner.query("SELECT count(*)::int AS n FROM requests");
    const answer = await post(dana, { targetTeam: "FE", requestingTeam: "BE", title: "", need: "Something." });
    expect(answer.status).toBe(400);
    const html = await answer.text();
    expect(html).toContain('<div role="alert">');
    expect(html).toMatch(/<p class="field-error" id="title-error">[^<]+<\/p>/);
    expect(html).toContain(`action="${NEW_REQUEST_PATH}"`);
    expect((await install.owner.query("SELECT count(*)::int AS n FROM requests")).rows).toEqual(before.rows);
  });

  it("tells a member of no team that they cannot open a request, and refuses their form with 403", async () => {
    const html = await (await get(nola)).text();
    expect(html).toContain("You belong to no team");
    // No form of the page's own: the shell holds the sign-out form (web-ui: The page shell and its navigation).
    expect(/<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "").not.toContain("<form");
    expect((await post(nola, { targetTeam: "FE", title: "Hello", need: "Something." })).status).toBe(403);
  });

  it("refuses a form from another origin, or without the CSRF token, with 403, and opens nothing", async () => {
    const before = await install.owner.query("SELECT count(*)::int AS n FROM requests");
    expect((await post(dana, { targetTeam: "FE", title: "Hello", need: "Something.", csrf: "" })).status).toBe(403);
    const crossSite = await route(dana)(
      new Request(`${URL_OF_INSTALL}${NEW_REQUEST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: new URLSearchParams({ csrf: csrfTokenFor(install.authSecret, dana.sessionId), targetTeam: "FE", title: "Hello", need: "Something." }).toString(),
      }),
    );
    expect(crossSite.status).toBe(403);
    expect((await install.owner.query("SELECT count(*)::int AS n FROM requests")).rows).toEqual(before.rows);
  });

  it("sends a browser without a session to sign in first", async () => {
    const answer = await get(undefined);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(NEW_REQUEST_PATH)}`);
  });
});
