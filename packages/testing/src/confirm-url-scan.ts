// The confirm URL scan of the end-to-end suites (agent-safety: The confirm
// URL never reaches the model; public-api: Commitments over the API answer
// 202 with a proposal; design.md, Decisions this change rests on: D28 #36;
// design.md, Self-hosting decisions: S7). The URL of a proposal's confirm
// page, or of any review page of the confirmation step, lies under /confirm/
// on the install. It reaches people only through the web inbox, email and
// URL-mode elicitation, never anything an agent reads. The shared test
// support scans every such output as the suites produce it: each MCP tool
// result over /mcp, its text and its structured content, with only the URL of
// a URL-mode elicitation left out, since that is the elicitation; everything
// the CLI prints, its hooks' output included; the answers of /api/v1, the
// long-poll wait answer and the 202 answer to a commitment included; and the
// markdown and JSON of request URLs and intake pages. An output that holds a
// confirm URL fails the test that produced it, wherever it ran: the suites of
// packages/commands, and the image's It works test, against a whole install.

/** The kinds of output agents read. */
export const AGENT_OUTPUTS = ["tool result", "CLI output", "hook output", "URL markdown", "URL JSON", "wait answer", "REST answer"] as const;
export type AgentOutput = (typeof AGENT_OUTPUTS)[number];

/** How many outputs of each kind this test file has scanned, so a test can show the scan saw what it ran. */
export const scannedOutputs: Record<AgentOutput, number> = Object.fromEntries(AGENT_OUTPUTS.map((kind) => [kind, 0])) as Record<AgentOutput, number>;

/** A confirm URL: a path under /confirm/, on the install or as a path alone. */
const CONFIRM_URL = /\/confirm\//i;

/** An agent-read output that holds a confirm URL. */
export class ConfirmUrlInAgentOutput extends Error {
  override name = "ConfirmUrlInAgentOutput";
}

/** Scans one output agents read; throws when it holds a confirm URL. */
export function scanForConfirmUrl(kind: AgentOutput, text: string, where: string): void {
  scannedOutputs[kind] += 1;
  const found = CONFIRM_URL.exec(text);
  if (found !== null) {
    const around = text.slice(Math.max(0, found.index - 80), found.index + 80);
    throw new ConfirmUrlInAgentOutput(`${where}: the ${kind} holds a confirm URL, which never reaches an agent: …${around}…`);
  }
}

/**
 * A JSON-RPC message from /mcp as an agent reads it: a URL-mode elicitation's
 * URL is left out, since the client opens it for its user and the agent never
 * reads it; everything else stays, a tool result's content and structured
 * content included.
 */
function withoutElicitationUrls(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return message;
  const copy = structuredClone(message) as { method?: unknown; params?: { mode?: unknown; url?: unknown }; result?: { inputRequests?: Record<string, { method?: unknown; params?: { mode?: unknown; url?: unknown } }> } };
  // A server's request for an elicitation, as an older connection gets one.
  if (copy.method === "elicitation/create" && copy.params?.mode === "url") delete copy.params.url;
  // An input-required result, which carries the elicitations of a 2026-07-28 call.
  for (const request of Object.values(copy.result?.inputRequests ?? {})) {
    if (request.method === "elicitation/create" && request.params?.mode === "url") delete request.params.url;
  }
  return copy;
}

/** The JSON-RPC messages of an /mcp answer's body: one JSON value, a batch, or the data lines of an event stream. */
function rpcMessages(body: string, contentType: string): unknown[] {
  const parse = (text: string): unknown[] => {
    try {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value) ? value : [value];
    } catch {
      return [text];
    }
  };
  if (contentType.startsWith("text/event-stream")) {
    return body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .flatMap((line) => parse(line.slice("data:".length).trim()));
  }
  return body === "" ? [] : parse(body);
}

/** Scans an answer of /mcp, as its client reads it; the answer is read from a clone, so the client still reads it whole. */
export async function scanMcpAnswer(response: Response, where: string): Promise<void> {
  const body = await response.clone().text();
  for (const message of rpcMessages(body, response.headers.get("content-type") ?? "")) {
    scanForConfirmUrl("tool result", typeof message === "string" ? message : JSON.stringify(withoutElicitationUrls(message)), where);
  }
}

/** Scans an answer of /api/v1 as an agent or the CLI reads it: the wait answer, a 202 or any other. */
export async function scanApiAnswer(request: Request, response: Response): Promise<void> {
  const { pathname } = new URL(request.url);
  const kind: AgentOutput = pathname === "/api/v1/events/wait" ? "wait answer" : "REST answer";
  scanForConfirmUrl(kind, await response.clone().text(), `${request.method} ${pathname} (${response.status})`);
}

/** Scans an answer of a request URL or an intake page that an agent negotiated: its markdown or its JSON; an HTML page is a person's. */
export function scanUrlAnswer(path: string, contentType: string | undefined, body: string): void {
  const type = (contentType ?? "").split(";")[0]?.trim() ?? "";
  if (type === "text/markdown") scanForConfirmUrl("URL markdown", body, `GET ${path}`);
  else if (type === "application/json" || type === "application/problem+json") scanForConfirmUrl("URL JSON", body, `GET ${path}`);
}

/** Wraps an /api/v1 handler so that every answer it gives is scanned. */
export function scanningApi<T extends (request: Request) => Promise<Response>>(handler: T): T {
  return (async (request: Request) => {
    const response = await handler(request);
    await scanApiAnswer(request, response);
    return response;
  }) as T;
}
