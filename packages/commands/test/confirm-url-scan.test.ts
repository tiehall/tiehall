import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentTokenCheck, createRequestUrlRoute, type RequestUrlRoute } from "../src/index.ts";
import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";
import { acknowledgeEverything, realSleep, signedInCli, type CliMachine } from "./support/cli.ts";
import {
  AGENT_OUTPUTS,
  ConfirmUrlInAgentOutput,
  scanApiAnswer,
  scanForConfirmUrl,
  scanMcpAnswer,
  scannedOutputs,
  scanUrlAnswer,
} from "./support/confirm-url-scan.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { connectMcp, LEGACY, mcpPerson, MODERN, textOf, type McpPerson } from "./support/mcp.ts";
import { openRequestInTheWebUi } from "./support/requests.ts";

// The confirm URL never reaches the model (agent-safety: The confirm URL never
// reaches the model; public-api: Commitments over the API answer 202 with a
// proposal; agent-surfaces: Clients without URL-mode elicitation are pointed
// to the web inbox; design.md, Decisions this change rests on: D28 #36;
// design.md, Self-hosting decisions: S7). The shared test support scans every
// output agents read as the end-to-end suites produce it
// (support/confirm-url-scan.ts): each answer of /mcp, a tool result's text and
// structured content included and only a URL-mode elicitation's own URL left
// out; everything the CLI prints, its hooks' output and `tiehall watch`'s
// included; every answer of /api/v1, the wait answer and the 202 answer to a
// commitment included; and the markdown and JSON of request URLs and intake
// pages. An output that holds a confirm URL fails the test that produced it,
// so every suite that runs those paths runs the scan. Here, the scan is shown
// to find a confirm URL in each kind of output, and to find none in each kind
// of output a request's life gives an agent while proposals on it wait: its
// tools on both protocol versions, with and without URL-mode elicitation and
// its retry, its CLI commands and hooks, the REST 202 and wait answers, and its
// URL's markdown and JSON.

const PROPOSAL = "5b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CONFIRM_URLS = [`${URL_OF_INSTALL}/confirm/${PROPOSAL}`, `/confirm/${PROPOSAL}/undo`, "/confirm/members.change_role?input=%7B%7D"];

describe("the scan", () => {
  it("finds a confirm URL in every kind of output agents read: a proposal's page, absolute or as a path, its undo page and a review page", () => {
    for (const kind of AGENT_OUTPUTS) {
      for (const url of CONFIRM_URLS) {
        expect(() => scanForConfirmUrl(kind, `Proposal ${PROPOSAL}: confirm it at ${url} now.`, "a fixture"), `${kind}: ${url}`).toThrow(ConfirmUrlInAgentOutput);
      }
      expect(() => scanForConfirmUrl(kind, `Proposal ${PROPOSAL} waits in dana-fe's web inbox.`, "a fixture")).not.toThrow();
    }
  });

  it("finds one in a tool result's text and in its structured content, as JSON or as an event stream, and leaves out only a URL-mode elicitation's own URL", async () => {
    const answer = (message: unknown, eventStream = false) =>
      new Response(eventStream ? `event: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message), {
        headers: { "content-type": eventStream ? "text/event-stream" : "application/json" },
      });
    const inText = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `Confirm at ${CONFIRM_URLS[0]}.` }] } };
    const inStructured = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Proposal made." }], structuredContent: { proposal: { page: CONFIRM_URLS[1] } } } };
    for (const message of [inText, inStructured]) {
      await expect(scanMcpAnswer(answer(message), "a fixture")).rejects.toThrow(ConfirmUrlInAgentOutput);
      await expect(scanMcpAnswer(answer(message, true), "a fixture")).rejects.toThrow(ConfirmUrlInAgentOutput);
    }
    const elicitation = (message: string) => ({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "input_required", inputRequests: { confirm: { method: "elicitation/create", params: { mode: "url", url: CONFIRM_URLS[0], message } } }, requestState: "state" },
    });
    await expect(scanMcpAnswer(answer(elicitation("Open Tiehall to confirm or reject the proposal to decline FE-142.")), "a fixture")).resolves.toBeUndefined();
    await expect(scanMcpAnswer(answer(elicitation(`Open ${CONFIRM_URLS[0]}.`)), "a fixture")).rejects.toThrow(ConfirmUrlInAgentOutput);
  });

  it("finds one in a REST answer, a wait answer and a request URL's markdown or JSON, and reads no person's HTML page", async () => {
    const body = JSON.stringify({ proposal: { id: PROPOSAL, page: CONFIRM_URLS[0] } });
    await expect(scanApiAnswer(new Request(`${URL_OF_INSTALL}/api/v1/requests/FE-142/status`, { method: "POST" }), new Response(body, { status: 202 }))).rejects.toThrow(ConfirmUrlInAgentOutput);
    await expect(scanApiAnswer(new Request(`${URL_OF_INSTALL}/api/v1/events/wait`), new Response(body))).rejects.toThrow(/wait answer/);
    expect(() => scanUrlAnswer("/FE-142.md", "text/markdown; charset=utf-8", `See ${CONFIRM_URLS[1]}.`)).toThrow(ConfirmUrlInAgentOutput);
    expect(() => scanUrlAnswer("/FE-142.json", "application/json", body)).toThrow(ConfirmUrlInAgentOutput);
    expect(() => scanUrlAnswer("/FE-142", "text/html; charset=utf-8", `<a href="${CONFIRM_URLS[1]}">Review</a>`)).not.toThrow();
  });
});

describe("every output a request's life gives agents while proposals on it wait", () => {
  let harness: AgentAccessHarness;
  let sam: McpPerson;
  let dana: McpPerson;
  let samCli: CliMachine;
  let danaCli: CliMachine;
  let urls: RequestUrlRoute;
  /** The outputs this file scanned before the request's life began. */
  let before: Record<string, number>;

  beforeAll(async () => {
    before = { ...scannedOutputs };
    harness = await startAgentAccess({ wait: { holdMs: 1_000 } });
    sam = await mcpPerson(harness, "sam-qa", { teams: ["QA"] });
    dana = await mcpPerson(harness, "dana-fe", { teams: ["FE"] });
    samCli = await signedInCli(harness, sam);
    danaCli = await signedInCli(harness, dana);
    urls = createRequestUrlRoute({
      execute: harness.install.execute,
      session: async () => undefined,
      authenticate: createAgentTokenCheck({ url: URL_OF_INSTALL, signingKeys: () => harness.signIn.service.signingKeys(), now: harness.clock.now, database: harness.install.db }),
      url: URL_OF_INSTALL,
    });
  }, 120_000);

  afterAll(async () => {
    samCli?.close();
    danaCli?.close();
    await harness?.close();
  });

  /** A request QA opens to FE in the web UI, which dana claims. */
  async function claimedRequest(): Promise<{ key: string }> {
    const request = await openRequestInTheWebUi<{ key: string }>(harness.install, sam.userId, { targetTeam: "FE", requestingTeam: "QA" });
    await harness.install.execute("requests.claim", dana.session, { key: request.key });
    return request;
  }

  it("holds none in the tools' results, on both protocol versions, with or without URL-mode elicitation, and in a retry", async () => {
    for (const [version, capabilities] of [
      [LEGACY, {}],
      [MODERN, {}],
      [MODERN, { elicitation: { url: {} } }],
    ] as const) {
      const request = await claimedRequest();
      const client: Client = await connectMcp(harness, { token: dana.token, version, capabilities });
      try {
        await client.listTools();
        const declined = (await client.request({ method: "tools/call", params: { name: "set_status", arguments: { key: request.key, state: "declined" } } }, { allowInputRequired: true })) as {
          resultType?: string;
          requestState?: string;
        };
        if (declined.resultType === "input_required") {
          // The retry with the elicitation's state answers with the proposal waiting.
          const retried = await client.request(
            { method: "tools/call", params: { name: "set_status", arguments: { key: request.key, state: "declined" }, requestState: declined.requestState } },
            { allowInputRequired: true },
          );
          expect(JSON.stringify(retried)).toContain("waiting for confirmation");
        }
        for (const [name, args] of [
          ["get_request", { request: request.key }],
          ["whats_new", {}],
          ["list_inbox", {}],
        ] as const) {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError ?? false, name).toBe(false);
          expect(textOf(result)).not.toContain("/confirm/");
        }
      } finally {
        await client.close();
      }
    }
  });

  it("holds none in the CLI's output: a commitment, a read, the updates and both hooks", async () => {
    const request = await claimedRequest();
    await acknowledgeEverything(samCli);
    const declined = await danaCli.run(["status", request.key, "declined"]);
    expect(declined.code).toBe(0);
    expect(declined.stdout).toContain("waits in dana-fe's web inbox");
    expect((await danaCli.run(["get", request.key])).code).toBe(0);
    expect((await danaCli.run(["updates"])).code).toBe(0);
    const digest = await samCli.run(["hook", "session-start"], { stdin: JSON.stringify({ session_id: "scan", hook_event_name: "SessionStart", source: "startup" }), sleep: realSleep });
    expect(digest.stdout).toContain(`${request.key} proposal.created (team FE)`);
    // The waiter wakes for dana's next message on the request.
    const waits = () => samCli.calls.filter(({ url }) => new URL(url).pathname === "/api/v1/events/wait").length;
    const calls = waits();
    const ended = samCli.run(["hook", "wait"], { stdin: JSON.stringify({ session_id: "scan-wait", hook_event_name: "Stop" }), sleep: realSleep });
    const until = Date.now() + 30_000;
    while (waits() === calls && Date.now() < until) await realSleep(20);
    const posted = await harness.install.web(dana.session).write("messages.post", { key: request.key, kind: "comment", body: "Declining: this is FE's call." }, harness.install.fromThePage(dana.session));
    expect(posted.ok).toBe(true);
    const wait = await ended;
    expect(wait.code).toBe(2);
    expect(wait.stderr).toContain(`${request.key} request.message_posted (team FE)`);
  }, 60_000);

  it("holds none in the REST 202 answer to a commitment, nor in the wait answer that reports it", async () => {
    const request = await claimedRequest();
    // A wait from the newest event on, which the commitment's event ends.
    const newest = Number((await harness.install.owner.query<{ number: string }>("SELECT coalesce(max(number), 0) AS number FROM events")).rows[0]?.number ?? 0);
    const wait = harness.handle(new Request(`${URL_OF_INSTALL}/api/v1/events/wait?cursor=${newest}`, { headers: { authorization: `Bearer ${sam.token}` } }));
    const declined = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/v1/requests/${request.key}/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${dana.token}`, "content-type": "application/json" },
        body: JSON.stringify({ state: "declined" }),
      }),
    );
    expect(declined.status).toBe(202);
    expect(((await declined.json()) as { proposal: { id: string } }).proposal.id).toMatch(/^[0-9a-f-]{36}$/);
    const waited = await wait;
    expect(waited.status).toBe(200);
    expect(JSON.stringify(await waited.json())).toContain(request.key);
  });

  // agent-safety: The confirm URL never reaches the model, "A request's markdown holds no confirm URL".
  it("shows the waiting proposal's id, and holds no confirm URL, in a request URL's markdown and JSON", async () => {
    const request = await claimedRequest();
    const declined = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/v1/requests/${request.key}/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${dana.token}`, "content-type": "application/json" },
        body: JSON.stringify({ state: "declined" }),
      }),
    );
    expect(declined.status).toBe(202);
    const proposalId = ((await declined.json()) as { proposal: { id: string } }).proposal.id;
    for (const suffix of [".md", ".json"]) {
      const answer = await urls(new Request(`${URL_OF_INSTALL}/${request.key}${suffix}`, { headers: { authorization: `Bearer ${sam.token}` } }));
      if (answer === undefined || !("response" in answer)) throw new Error(`/${request.key}${suffix} gave no answer of its own.`);
      expect(answer.response.status).toBe(200);
      const body = await answer.response.text();
      scanUrlAnswer(`/${request.key}${suffix}`, answer.response.headers.get("content-type") ?? undefined, body);
      expect(body, suffix).not.toMatch(/\/confirm\//);
      if (suffix === ".md") expect(body).toContain(`Proposal ${proposalId}: decline ${request.key}. It is pending.`);
      else expect((JSON.parse(body) as { pendingProposals: { id: string }[] }).pendingProposals.map(({ id }) => id)).toEqual([proposalId]);
    }
  });

  it("scanned outputs of every kind on the way", () => {
    for (const kind of AGENT_OUTPUTS) expect(scannedOutputs[kind] - (before[kind] ?? 0), kind).toBeGreaterThan(0);
  });
});
