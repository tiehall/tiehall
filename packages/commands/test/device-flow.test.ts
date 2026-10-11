import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CLI_CLIENT_ID, removeExpiredDeviceCodes, storedDeviceCode } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { MCP_RESOURCE, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// The CLI signs in through a restricted device flow (agent-access: The CLI
// signs in through a restricted device flow; design.md, Design rules: Agent
// access; design.md, Technical decisions: T7, with the device-flow spike's
// corrections; design.md, Self-hosting decisions: S15). The `tiehall` CLI is a
// pre-registered public client with a fixed client id, seeded when the
// install's authorization server is built. It signs in with the OAuth device
// authorization grant (RFC 8628): a guard on the device authorization endpoint
// refuses every other client id with unauthorized_client, the library's
// client check is not set, and the library's own device token endpoint, which
// would hand out a session token, is not served. A device code expires 10
// minutes after it is issued. The CLI exchanges an approved code at the OAuth
// token endpoint for an access token whose only audience is the install's MCP
// resource, and a refresh token, and no web session is made for it.
//
// An expired code is removed by an hourly job, with the address it kept. The
// install keeps a device code and its user code only as their SHA-256 hashes,
// as it keeps personal access tokens, so a reader of the database finds no
// code to redeem or approve.
//
// The device approval page, where a member approves a code with the
// confirmation step, has its own tests (device-approval.test.ts); here a test
// approves a code as that approval stores it: the code, approved for the
// member, and the member's grant to the CLI, without which the token endpoint
// gives no token.

let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** The CLI's device authorization request: `tiehall login` asks for a device code. */
async function deviceCode(form: Record<string, string>): Promise<Answer> {
  const answer = await harness.handle(
    new Request(`${URL_OF_INSTALL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.7" },
      body: new URLSearchParams(form).toString(),
    }),
  );
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

/** The CLI's poll of the OAuth token endpoint with its device code, from this client address when one is given. */
async function deviceToken(code: string, clientId = CLI_CLIENT_ID, address?: string): Promise<Answer> {
  const answer = await harness.handle(
    new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(address === undefined ? {} : { "x-forwarded-for": address }) },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code, client_id: clientId }).toString(),
    }),
  );
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

/** A token call with this form body from this client address, as any client sends one. */
function tokenCall(body: string, address: string): Promise<Response> {
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address },
      body,
    }),
  );
}

/** The install's interval passes for a device code, as its clock reads the code's last poll. */
async function intervalPasses(code: string): Promise<void> {
  await harness.install.owner.query("UPDATE oauth_device_codes SET last_polled_at = last_polled_at - interval '5 seconds' WHERE device_code = $1", [
    storedDeviceCode(code),
  ]);
}

/** The CLI's own request, as `tiehall login` sends it: its client id, the MCP resource and the scopes it works with. */
const CLI_REQUEST = { client_id: CLI_CLIENT_ID, resource: MCP_RESOURCE, scope: "requests:read requests:write" };

/** Approves a device code for a user as the device approval page's confirmed approval stores it: the code, and the user's grant to the CLI. */
async function approve(userCode: string, userId: string): Promise<void> {
  await harness.install.owner.query("UPDATE oauth_device_codes SET status = 'approved', user_id = $2 WHERE user_code = $1", [storedDeviceCode(userCode), userId]);
  await harness.install.owner.query(
    `INSERT INTO oauth_consents (org_id, client_id, user_id, scopes, resources, requested_user_info_claims, created_at, updated_at)
       SELECT d.org_id, $3, $2, string_to_array(d.scope, ' '), d.resources, '{}', now(), now() FROM oauth_device_codes d
        WHERE d.user_code = $1 AND NOT EXISTS (SELECT 1 FROM oauth_consents c WHERE c.user_id = $2 AND c.client_id = $3)`,
    [storedDeviceCode(userCode), userId, CLI_CLIENT_ID],
  );
}

/** How many device codes the install holds. */
async function deviceCodes(): Promise<number> {
  const { rows } = await harness.install.owner.query("SELECT count(*)::int AS n FROM oauth_device_codes");
  return rows[0].n;
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("the CLI", () => {
  it("is a registered public client with a fixed id, for the device grant and refresh tokens only", async () => {
    const { rows } = await harness.install.owner.query(
      "SELECT client_secret, token_endpoint_auth_method, grant_types, redirect_uris, disabled FROM oauth_clients WHERE client_id = $1",
      [CLI_CLIENT_ID],
    );
    expect(rows).toEqual([
      {
        client_secret: null,
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        redirect_uris: [],
        disabled: false,
      },
    ]);
  });

  it("gets a device code that expires after 10 minutes, and a verification address on the install's device approval page", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ expires_in: 600, verification_uri: `${URL_OF_INSTALL}/device` });
    // No link carries the code: the approval page ignores a code in its URL, so nothing invites one there.
    expect(answer.body).not.toHaveProperty("verification_uri_complete");
    const { rows } = await harness.install.owner.query(
      "SELECT extract(epoch FROM expires_at - requested_at)::int AS lifetime, host(requested_from) AS ip, status, user_id FROM oauth_device_codes WHERE device_code = $1",
      [storedDeviceCode(String(answer.body["device_code"]))],
    );
    expect(rows).toEqual([{ lifetime: 600, ip: "198.51.100.7", status: "pending", user_id: null }]);
  });

  it("gets expired_token for a code 11 minutes after it was issued, and no token", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    const code = String(answer.body["device_code"]);
    await approve(String(answer.body["user_code"]), ana.userId);
    // Eleven minutes on, as the install's clock reads the code's expiry.
    await harness.install.owner.query("UPDATE oauth_device_codes SET expires_at = now() - interval '1 minute' WHERE device_code = $1", [storedDeviceCode(code)]);
    const polled = await deviceToken(code);
    expect(polled.status).toBe(400);
    expect(polled.body["error"]).toBe("expired_token");
    expect(polled.body["access_token"]).toBeUndefined();
  });

  it("gets authorization_pending until the code is approved, and nothing is granted meanwhile", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    const polled = await deviceToken(String(answer.body["device_code"]));
    expect(polled.status).toBe(400);
    expect(polled.body["error"]).toBe("authorization_pending");
  });

  // The CLI polls at the install's interval, every 5 seconds, for as long as its code waits, up to its 10 minutes;
  // and on an install on one machine, as a trial URL's is, every client there reaches the install from one address.
  // The token endpoint's limit on the calls from one address, 20 in a row, would refuse the 21st poll, about 100
  // seconds in, with 429, and every token call from that address until a minute passed without one, the next
  // `tiehall login`'s first poll included. The device flow holds each code to the interval itself.
  it("keeps getting authorization_pending at the install's interval for as long as its code waits, past the token endpoint's limit on one address", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    const code = String(answer.body["device_code"]);
    for (let poll = 1; poll <= 30; poll += 1) {
      const polled = await deviceToken(code, CLI_CLIENT_ID, "198.51.100.41");
      expect(polled.status, `poll ${poll}`).toBe(400);
      expect(polled.body["error"], `poll ${poll}`).toBe("authorization_pending");
      await intervalPasses(code);
    }
    // The next sign-in from the same address is answered as the first was.
    const next = await deviceCode(CLI_REQUEST);
    expect((await deviceToken(String(next.body["device_code"]), CLI_CLIENT_ID, "198.51.100.41")).body["error"]).toBe("authorization_pending");
  });

  it("gets slow_down for a poll that comes before the install's interval has passed since its last one", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    const code = String(answer.body["device_code"]);
    expect((await deviceToken(code, CLI_CLIENT_ID, "198.51.100.42")).body["error"]).toBe("authorization_pending");
    expect((await deviceToken(code, CLI_CLIENT_ID, "198.51.100.42")).body["error"]).toBe("slow_down");
  });

  it("gets an access token whose only audience is the MCP resource, and a refresh token, once a member approved its code; /api/v1 accepts it", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    await approve(String(answer.body["user_code"]), ana.userId);
    const { rows: sessionsBefore } = await harness.install.owner.query("SELECT count(*)::int AS n FROM web_sessions");
    const polled = await deviceToken(String(answer.body["device_code"]));
    expect(polled.status).toBe(200);
    expect(polled.body).toMatchObject({ token_type: "Bearer", expires_in: 600, access_token: expect.any(String), refresh_token: expect.any(String) });
    const claims = claimsOf(String(polled.body["access_token"]));
    expect(claims).toMatchObject({ iss: URL_OF_INSTALL, aud: MCP_RESOURCE, sub: ana.userId, azp: CLI_CLIENT_ID });
    expect(String(claims["scope"]).split(" ").sort()).toEqual(["offline_access", "requests:read", "requests:write"]);
    const call = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${String(polled.body["access_token"])}` });
    expect(call.status).toBe(200);
    // No web session is made for the CLI.
    const { rows: sessionsAfter } = await harness.install.owner.query("SELECT count(*)::int AS n FROM web_sessions");
    expect(sessionsAfter[0].n).toBe(sessionsBefore[0].n);
    // The code is used up.
    const again = await deviceToken(String(answer.body["device_code"]));
    expect(again.body["error"]).toBe("invalid_grant");
  });

  it("gets a token for the MCP resource alone even when its request names no resource", async () => {
    const answer = await deviceCode({ client_id: CLI_CLIENT_ID, scope: "requests:read" });
    expect(answer.status).toBe(200);
    await approve(String(answer.body["user_code"]), ana.userId);
    const polled = await deviceToken(String(answer.body["device_code"]));
    expect(polled.status).toBe(200);
    expect(claimsOf(String(polled.body["access_token"]))["aud"]).toBe(MCP_RESOURCE);
  });

  it("refreshes its token, and the refresh token rotates", async () => {
    const answer = await deviceCode(CLI_REQUEST);
    await approve(String(answer.body["user_code"]), ana.userId);
    const polled = await deviceToken(String(answer.body["device_code"]));
    const refreshed = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(polled.body["refresh_token"]), client_id: CLI_CLIENT_ID }).toString(),
      }),
    );
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(body["refresh_token"]).not.toBe(polled.body["refresh_token"]);
    expect(claimsOf(String(body["access_token"]))["aud"]).toBe(MCP_RESOURCE);
  });

  it("gets invalid_scope for a scope Tiehall does not offer, openid included, and no device code", async () => {
    const before = await deviceCodes();
    for (const scope of ["openid", "requests:read admin", "offline_access"]) {
      const answer = await deviceCode({ ...CLI_REQUEST, scope });
      expect(answer.status, scope).toBe(400);
      expect(answer.body["error"], scope).toBe("invalid_scope");
    }
    expect(await deviceCodes()).toBe(before);
  });

  it("cannot bind its code to a user in advance", async () => {
    const before = await deviceCodes();
    const answer = await deviceCode({ ...CLI_REQUEST, user_id: ana.userId });
    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toBe("invalid_request");
    expect(await deviceCodes()).toBe(before);
  });
});

describe("the token endpoint's limit on the calls from one address", () => {
  // Every token call but a device-code poll keeps the limit: 20 in a row from one address, and the next gets the
  // error model's 429, whatever the CLI's polls from that address did before.
  it("refuses the 21st other token call in a row from an address, which the CLI's polls from it did not use up", async () => {
    const address = "198.51.100.43";
    const answer = await deviceCode(CLI_REQUEST);
    const code = String(answer.body["device_code"]);
    for (let poll = 1; poll <= 25; poll += 1) {
      expect((await deviceToken(code, CLI_CLIENT_ID, address)).body["error"], `poll ${poll}`).toBe("authorization_pending");
      await intervalPasses(code);
    }
    const refresh = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "not-a-refresh-token", client_id: CLI_CLIENT_ID }).toString();
    for (let call = 1; call <= 20; call += 1) expect((await tokenCall(refresh, address)).status, `call ${call}`).not.toBe(429);
    const limited = await tokenCall(refresh, address);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("content-type")).toBe("application/problem+json");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts a token call that names its grant type twice, the device code grant among them", async () => {
    const twice = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:device_code")}&grant_type=refresh_token&device_code=not-a-code&client_id=${CLI_CLIENT_ID}`;
    for (let call = 1; call <= 20; call += 1) expect((await tokenCall(twice, "198.51.100.44")).status, `call ${call}`).not.toBe(429);
    expect((await tokenCall(twice, "198.51.100.44")).status).toBe(429);
  });
});

describe("another client", () => {
  it("gets unauthorized_client for a client registered through DCR, and no device code is issued", async () => {
    const client = await harness.registerClient();
    const before = await deviceCodes();
    const answer = await deviceCode({ ...CLI_REQUEST, client_id: client.clientId });
    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toBe("unauthorized_client");
    expect(answer.body["device_code"]).toBeUndefined();
    expect(await deviceCodes()).toBe(before);
  });

  it("gets unauthorized_client for a metadata-document client id, an unknown id, no id or two ids, and nothing is fetched or issued", async () => {
    const before = await deviceCodes();
    const forms: Record<string, string>[] = [
      { ...CLI_REQUEST, client_id: "https://agent.example/client.json" },
      { ...CLI_REQUEST, client_id: "an-unknown-client" },
      { resource: MCP_RESOURCE, scope: "requests:read" },
    ];
    for (const form of forms) {
      const answer = await deviceCode(form);
      expect(answer.status, JSON.stringify(form)).toBe(400);
      expect(answer.body["error"], JSON.stringify(form)).toBe("unauthorized_client");
    }
    const twice = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `client_id=${CLI_CLIENT_ID}&client_id=an-unknown-client&scope=requests%3Aread`,
      }),
    );
    expect(twice.status).toBe(400);
    expect(((await twice.json()) as { error?: string }).error).toBe("unauthorized_client");
    expect(await deviceCodes()).toBe(before);
  });

  it("cannot redeem the CLI's approved code under its own id", async () => {
    const client = await harness.registerClient();
    const answer = await deviceCode(CLI_REQUEST);
    await approve(String(answer.body["user_code"]), ana.userId);
    const polled = await deviceToken(String(answer.body["device_code"]), client.clientId);
    expect(polled.status).toBe(400);
    expect(polled.body["access_token"]).toBeUndefined();
  });
});

describe("the device flow's other endpoints", () => {
  it.each([
    ["POST", "/api/auth/device/token"],
    ["GET", "/api/auth/device?user_code=ABCDEFGH"],
    ["POST", "/api/auth/device/approve"],
    ["POST", "/api/auth/device/deny"],
  ])("do not serve %s %s over HTTP: 404, and no session token", async (method, path) => {
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie: ana.cookie },
        ...(method === "POST" ? { body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "x", client_id: CLI_CLIENT_ID, userCode: "x" }) } : {}),
      }),
    );
    expect(answer.status).toBe(404);
    expect(await answer.text()).not.toContain("access_token");
  });
});

describe("the hourly removal", () => {
  /** Runs the hourly removal as the worker would at that time. */
  async function removeExpired(at: Date): Promise<void> {
    await removeExpiredDeviceCodes.handle(
      { id: "remove", queue: removeExpiredDeviceCodes.type.queue, data: {}, signal: new AbortController().signal },
      { database: harness.install.db, now: () => at },
    );
  }

  it("keeps a device code until it expires, then removes it with the address it kept", async () => {
    const issued = await deviceCode(CLI_REQUEST);
    const { rows } = await harness.install.owner.query("SELECT expires_at FROM oauth_device_codes WHERE device_code = $1", [storedDeviceCode(String(issued.body["device_code"]))]);
    const expiresAt = rows[0].expires_at as Date;
    await removeExpired(new Date(expiresAt.getTime() - 60_000));
    const { rows: kept } = await harness.install.owner.query("SELECT host(requested_from) AS ip FROM oauth_device_codes WHERE device_code = $1", [storedDeviceCode(String(issued.body["device_code"]))]);
    expect(kept).toEqual([{ ip: "198.51.100.7" }]);
    await removeExpired(new Date(expiresAt.getTime() + 1000));
    const { rows: left } = await harness.install.owner.query("SELECT 1 FROM oauth_device_codes WHERE device_code = $1", [storedDeviceCode(String(issued.body["device_code"]))]);
    expect(left).toEqual([]);
  });
});

describe("the authorization server metadata", () => {
  it("names the device authorization endpoint", async () => {
    const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/.well-known/oauth-authorization-server`));
    const body = (await answer.json()) as Record<string, unknown>;
    expect(body["device_authorization_endpoint"]).toBe(`${URL_OF_INSTALL}/api/auth/device/code`);
  });
});

// The codes the install keeps: the SHA-256 hash of each, never the code, so the hash a reader of the database finds
// redeems nothing at the token endpoint.
describe("the codes the install keeps", () => {
  const sha256 = (code: string) => `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;

  it("are the SHA-256 hashes of the device code and the user code, and never the codes", async () => {
    const issued = await deviceCode(CLI_REQUEST);
    const device = String(issued.body["device_code"]);
    const user = String(issued.body["user_code"]);
    expect(storedDeviceCode(device)).toBe(sha256(device));
    const { rows } = await harness.install.owner.query("SELECT device_code, user_code FROM oauth_device_codes WHERE device_code = $1", [sha256(device)]);
    expect(rows).toEqual([{ device_code: sha256(device), user_code: sha256(user) }]);
    const { rows: plain } = await harness.install.owner.query("SELECT 1 FROM oauth_device_codes WHERE device_code = $1 OR user_code = $2", [device, user]);
    expect(plain).toEqual([]);
  });

  it("redeem nothing when the hash the database keeps is sent as the device code; the code itself redeems", async () => {
    const issued = await deviceCode(CLI_REQUEST);
    const device = String(issued.body["device_code"]);
    await approve(String(issued.body["user_code"]), ana.userId);
    const withHash = await deviceToken(sha256(device));
    expect(withHash.status).toBe(400);
    expect(withHash.body["error"]).toBe("invalid_grant");
    expect(withHash.body["access_token"]).toBeUndefined();
    await harness.install.owner.query("UPDATE oauth_device_codes SET last_polled_at = NULL WHERE device_code = $1", [sha256(device)]);
    const withCode = await deviceToken(device);
    expect(withCode.status).toBe(200);
    expect(typeof withCode.body["access_token"]).toBe("string");
  });
});
