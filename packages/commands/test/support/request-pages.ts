import { expect } from "vitest";
import type { GitHubStub } from "@tiehall/testing/github";
import { addInstallation } from "./apis.ts";
import type { TestInstall } from "./install.ts";
import { addUser } from "./members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, sessionOf, tokenOf } from "./requests.ts";

// What the tests of the request pages' look show (web-ui: A request's state
// looks the same everywhere; web-ui: The request page shows who works on it
// and what happened; design.md, Design: The page families; D57 (1), (15)):
// the teams BE (Backend), FE (Frontend), which says how it wants requests filed
// and requires acceptance criteria, and PAY (Payments), which provides an API
// that FE declared it consumes; Pia, an admin in FE, Alice in BE and Mert in
// FE; the agent client Example Agent, known by its metadata document; FE-1,
// with a full packet and a due date, which Mert's agent claimed, asked a
// blocking question on that Alice answered in the web UI, and started work on
// a moment ago; and FE-2, which agents flagged needs_human, with Pia's
// proposal to decline it waiting for its confirmation.

export const EXAMPLE_AGENT = "https://client.example.com/tiehall.json";

export interface RequestPagesSeed {
  pia: string;
  alice: string;
  mert: string;
  /** The id of Pia's proposal to decline FE-2. */
  decline: string;
}

export async function seedRequestPages(install: TestInstall, stub: GitHubStub): Promise<RequestPagesSeed> {
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  const pay = await addTeam(install.owner, "PAY");
  await install.owner.query(
    "UPDATE teams SET name = CASE key WHEN 'BE' THEN 'Backend' WHEN 'FE' THEN 'Frontend' ELSE 'Payments' END, intake_notes = CASE key WHEN 'FE' THEN 'Link the design file, and say which screens change.' ELSE '' END, required_fields = CASE key WHEN 'FE' THEN ARRAY['acceptance_criteria'] ELSE ARRAY[]::text[] END",
  );
  const pia = await addUser(install.owner, { login: "pia", role: "admin", githubAccountId: stub.addUser({ login: "pia" }).id });
  const alice = await addUser(install.owner, { login: "alice", githubAccountId: stub.addUser({ login: "alice" }).id });
  const mert = await addUser(install.owner, { login: "mert", githubAccountId: stub.addUser({ login: "mert" }).id });
  await joinTeams(install.owner, pia, fe);
  await joinTeams(install.owner, alice, be);
  await joinTeams(install.owner, mert, fe);
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, 'Example Agent', 'cimd', ARRAY['https://client.example.com/callback'] FROM orgs",
    [EXAMPLE_AGENT],
  );
  // PAY provides payments-api, which FE declares it consumes.
  await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] });
  expect((await install.confirm(sessionOf(pia), "apis.register", { name: "payments-api", team: pay, repository: "acme/payments" })).status).toBe(200);
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM apis WHERE name = 'payments-api'");
  const piaSession = sessionOf(pia);
  const declared = await install.web(piaSession).write("apis.declare_consumer", { api: rows[0]?.id ?? "", team: fe }, install.fromThePage(piaSession));
  expect(declared).toMatchObject({ ok: true });

  await openRequest(install, tokenOf(alice), {
    targetTeam: "FE",
    title: 'Add a "Forgot password" link to the sign-in page',
    packet: {
      schema_version: "1-beta",
      kind: "request",
      due_date: "2026-11-02",
      untrusted: {
        need: "Add the link under the sign-in form.",
        acceptance_criteria: ["The link shows under the sign-in form", "It opens /password-reset"],
        code_refs: [{ repository: "acme/web", path: "src/pages/login", ref: "main" }],
        links: [{ url: "https://design.example.com/login", title: "Sign-in design" }],
      },
    },
  });
  const agent = oauthTokenOf(mert, EXAMPLE_AGENT, "mcp");
  expect((await callApi(install, agent, "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  const question = await callApi(install, agent, "POST", "/api/v1/requests/FE-1/messages", { kind: "question", body: "Should the link text be English or Turkish?", blocking: true });
  expect(question.status).toBe(200);
  const aliceSession = sessionOf(alice);
  const answered = await install.web(aliceSession).write("messages.post", { key: "FE-1", kind: "answer", body: "Turkish: Şifremi unuttum.", questionId: question.body.message.id }, install.fromThePage(aliceSession));
  expect(answered).toMatchObject({ ok: true });
  expect((await callApi(install, agent, "POST", "/api/v1/requests/FE-1/status", { state: "in_progress" })).status).toBe(200);
  // Work started 40 seconds ago, as the owner sets it past the append-only trigger.
  await install.owner.query("BEGIN; SET LOCAL session_replication_role = replica");
  await install.owner.query("UPDATE events SET occurred_at = now() - interval '40 seconds' WHERE type = 'request.started'");
  await install.owner.query("COMMIT");

  await openRequest(install, tokenOf(alice), {
    targetTeam: "FE",
    title: "Move the banner",
    packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "Move the banner below the header.", acceptance_criteria: ["The banner sits below the header"] } },
  });
  const declined = await callApi(install, tokenOf(pia), "POST", "/api/v1/requests/FE-2/status", { state: "declined" });
  expect(declined.status).toBe(202);
  await install.owner.query("UPDATE requests SET needs_human = true WHERE number = 2");
  return { pia, alice, mert, decline: declined.body.proposal.id };
}
