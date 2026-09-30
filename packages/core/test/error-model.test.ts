import { describe, expect, it } from "vitest";
import { httpProblem, internalErrorProblem, PROBLEM_TYPE_BASE, Refusal, REFUSAL_REASONS, toolError, type RefusalReason } from "../src/index.ts";

// The error model (public-api: One error model for Tiehall's own refusals;
// public-api: Errors are RFC 9457 problem details). One module maps each
// reason Tiehall refuses a call for, a row of the public-api spec's table, to
// its HTTP status and its problem type, and gives the two forms a refusal
// takes: an RFC 9457 problem on every HTTP endpoint, and a tool error on the
// MCP tools, which names the same problem type.

/** The rows of the public-api spec's table, with the status each gives, and the refusals whose status a protocol sets. */
const TABLE: Record<RefusalReason, number> = {
  "route-not-found": 404,
  "record-not-found": 404,
  "setup-required": 503,
  "shutting-down": 503,
  "invalid-input": 400,
  "outside-settings": 400,
  "upgrade-required": 400,
  forbidden: 403,
  "sign-in-refused": 403,
  "personal-access-tokens-off": 403,
  "confirmation-required": 403,
  "removed-member": 403,
  "request-state-refused": 403,
  "invalid-token": 401,
  "ci-caller-refused": 403,
  "needs-human": 409,
  conflict: 409,
  "payload-too-large": 413,
  "if-match-required": 428,
  "rate-limited": 429,
  "integration-unavailable": 502,
  unauthenticated: 401,
  "insufficient-scope": 403,
  "precondition-failed": 412,
  "idempotency-key-reused": 422,
};

describe("the error model", () => {
  it("holds each row of the table with its status, and gives each its own problem type", () => {
    expect(Object.fromEntries(Object.entries(REFUSAL_REASONS).map(([reason, row]) => [reason, row.status]))).toEqual(TABLE);
    const types = Object.keys(REFUSAL_REASONS).map((reason) => new Refusal(reason as RefusalReason, "detail", { retryAfterSeconds: 1 }).type);
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) expect(type.startsWith(PROBLEM_TYPE_BASE)).toBe(true);
  });

  it("names the problem types the specs name", () => {
    expect(new Refusal("setup-required", "Setup is not complete.").type).toBe(`${PROBLEM_TYPE_BASE}setup-required`);
    expect(new Refusal("needs-human", "A person must act on FE-142 first.").type).toBe(`${PROBLEM_TYPE_BASE}needs-human`);
    expect(new Refusal("upgrade-required", "Upgrade the tiehall CLI.").type).toBe(`${PROBLEM_TYPE_BASE}upgrade-required`);
    expect(new Refusal("conflict", "FE-142 is already claimed.").type).not.toBe(`${PROBLEM_TYPE_BASE}needs-human`);
  });

  it("answers a route that is not there with 404", () => {
    expect(httpProblem(new Refusal("route-not-found", "There is no such operation here."))).toEqual({
      status: 404,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: {
        type: `${PROBLEM_TYPE_BASE}route-not-found`,
        title: "No such operation",
        status: 404,
        detail: "There is no such operation here.",
      },
    });
  });

  it("answers a record that does not exist with 404, under its own problem type", () => {
    const { status, body } = httpProblem(new Refusal("record-not-found", "There is no request FE-9999."));
    expect(status).toBe(404);
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}record-not-found`, status: 404, detail: "There is no request FE-9999." });
  });

  it("answers input that fails the schema with 400 and names where it fails", () => {
    const issues = [{ path: ["body"], message: "Invalid input: expected string, received number" }];
    const { status, body } = httpProblem(new Refusal("invalid-input", "The input does not match its schema.", { issues }));
    expect(status).toBe(400);
    expect(body).toEqual({
      type: `${PROBLEM_TYPE_BASE}invalid-input`,
      title: "Invalid input",
      status: 400,
      detail: "The input does not match its schema.",
      errors: issues,
    });
  });

  it("answers a state conflict with 409", () => {
    const { status, body } = httpProblem(new Refusal("conflict", "FE-142 is already claimed."));
    expect(status).toBe(409);
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}conflict`, status: 409 });
  });

  it("answers an exceeded limit with 429 and Retry-After, which it cannot leave out", () => {
    const { status, headers, body } = httpProblem(new Refusal("rate-limited", "Too many writes from this token.", { retryAfterSeconds: 42 }));
    expect(status).toBe(429);
    expect(headers["retry-after"]).toBe("42");
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}rate-limited`, status: 429 });
    expect(() => new Refusal("rate-limited", "Too many writes from this token.")).toThrow("names when to retry");
  });

  it("answers a call while the app shuts down with 503 and Retry-After: 0", () => {
    const { status, headers, body } = httpProblem(new Refusal("shutting-down", "Tiehall is shutting down."));
    expect(status).toBe(503);
    expect(headers["retry-after"]).toBe("0");
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}shutting-down`, status: 503 });
  });

  it("answers a call before setup is complete with 503 setup-required", () => {
    const { status, headers, body } = httpProblem(new Refusal("setup-required", "Setup is not complete."));
    expect(status).toBe(503);
    expect(headers["retry-after"]).toBeUndefined();
    expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}setup-required`, title: "Setup is not complete", status: 503 });
  });

  // public-api: Request bodies have a size limit. The detail is the refusal's own server text, which names the
  // limit that applied; the row carries no Retry-After, because the same body is refused again.
  it("answers a body over the size limit with 413 payload-too-large, a detail that names the limit, and no Retry-After", () => {
    const { status, headers, body } = httpProblem(new Refusal("payload-too-large", "The request body is larger than 2 MiB."));
    expect(status).toBe(413);
    expect(headers).toEqual({ "content-type": "application/problem+json", "cache-control": "no-store" });
    expect(body).toEqual({
      type: `${PROBLEM_TYPE_BASE}payload-too-large`,
      title: "Request body too large",
      status: 413,
      detail: "The request body is larger than 2 MiB.",
    });
  });

  // public-api: One error model for Tiehall's own refusals (D50 (3)). GitHub or the Jira site failing a call
  // that the action needs is the install's upstream failing, not Tiehall: 502, under its own problem type, and
  // no Retry-After, because nobody can say when GitHub or the Jira site answers again.
  it("answers GitHub or the Jira site failing an action with 502 integration-unavailable, and no Retry-After", () => {
    const refusal = new Refusal("integration-unavailable", "GitHub did not answer the look-up of the username within 10 seconds.");
    expect(refusal.type.endsWith("/integration-unavailable")).toBe(true);
    expect(refusal.type).toBe(`${PROBLEM_TYPE_BASE}integration-unavailable`);
    const { status, headers, body } = httpProblem(refusal);
    expect(status).toBe(502);
    expect(headers).toEqual({ "content-type": "application/problem+json", "cache-control": "no-store" });
    expect(headers["retry-after"]).toBeUndefined();
    expect(body).toEqual({
      type: `${PROBLEM_TYPE_BASE}integration-unavailable`,
      title: "Integration unavailable",
      status: 502,
      detail: "GitHub did not answer the look-up of the username within 10 seconds.",
    });
  });

  it("challenges a call without a valid token as OAuth defines", () => {
    expect(httpProblem(new Refusal("unauthenticated", "This operation needs a token.")).headers["www-authenticate"]).toBe("Bearer");
    expect(httpProblem(new Refusal("invalid-token", "This token is not valid.")).headers["www-authenticate"]).toBe(
      'Bearer error="invalid_token"',
    );
  });

  // agent-access: Missing and insufficient tokens get standard challenges: a
  // challenge points to the protected resource metadata (RFC 9728) and says
  // which scope the operation needs (RFC 6750).
  it("adds to a challenge where the protected resource metadata is and which scope the operation needs", () => {
    const metadata = "https://tiehall.example.com/.well-known/oauth-protected-resource/mcp";
    const missing = new Refusal("unauthenticated", "This operation needs a token.", { challenge: { resourceMetadata: metadata, scope: ["requests:read"] } });
    expect(httpProblem(missing).headers["www-authenticate"]).toBe(`Bearer resource_metadata="${metadata}", scope="requests:read"`);
    const invalid = new Refusal("invalid-token", "This token is not valid.", { challenge: { resourceMetadata: metadata } });
    expect(httpProblem(invalid).headers["www-authenticate"]).toBe(`Bearer error="invalid_token", resource_metadata="${metadata}"`);
    const insufficient = new Refusal("insufficient-scope", "This token lacks requests:write.", {
      challenge: { scope: ["requests:write", "contracts:report"], resourceMetadata: metadata },
    });
    expect(httpProblem(insufficient)).toMatchObject({
      status: 403,
      headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="requests:write contracts:report", resource_metadata="${metadata}"` },
    });
  });

  it("carries a challenge's parameters only on a refusal that challenges, and keeps them when a refusal gains more", () => {
    const refusal = new Refusal("forbidden", "Only an admin may do this.", { challenge: { scope: ["requests:read"] } });
    expect(httpProblem(refusal).headers["www-authenticate"]).toBeUndefined();
    const scoped = new Refusal("insufficient-scope", "This token lacks requests:write.", { challenge: { scope: ["requests:write"] } });
    const withMetadata = scoped.withChallenge({ resourceMetadata: "https://tiehall.example.com/.well-known/oauth-protected-resource/mcp" });
    expect(withMetadata).toBeInstanceOf(Refusal);
    expect(withMetadata.message).toBe(scoped.message);
    expect(httpProblem(withMetadata).headers["www-authenticate"]).toBe(
      'Bearer error="insufficient_scope", scope="requests:write", resource_metadata="https://tiehall.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("gives an unexpected failure a 500 problem that says nothing about it", () => {
    expect(internalErrorProblem()).toEqual({
      status: 500,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: { type: "about:blank", title: "Internal Server Error", status: 500, detail: "Tiehall could not complete this call." },
    });
  });
});

describe("the MCP tools' form of a refusal", () => {
  const refusals = [
    new Refusal("route-not-found", "There is no such operation here."),
    new Refusal("record-not-found", "There is no request FE-9999."),
    new Refusal("invalid-input", "The input does not match its schema.", { issues: [{ path: ["questionId"], message: "Required" }] }),
    new Refusal("conflict", "FE-142 is already claimed."),
    new Refusal("rate-limited", "Too many writes from this token.", { retryAfterSeconds: 42 }),
    new Refusal("shutting-down", "Tiehall is shutting down."),
    new Refusal("setup-required", "Setup is not complete."),
  ];

  it("is a tool result with isError whose content names the problem type of the row", () => {
    for (const refusal of refusals) {
      const result = toolError(refusal);
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const [content] = result.content;
      expect(content?.type).toBe("text");
      expect(content?.text).toContain(refusal.type);
      // The text is the same problem an HTTP endpoint answers with, so an agent reads one shape everywhere.
      expect(JSON.parse(content?.text ?? "")).toEqual(httpProblem(refusal).body);
    }
  });

  it("carries when to retry for a limit", () => {
    expect(JSON.parse(toolError(new Refusal("rate-limited", "Too many writes.", { retryAfterSeconds: 42 })).content[0]?.text ?? "")).toMatchObject({
      retryAfter: 42,
    });
  });
});
