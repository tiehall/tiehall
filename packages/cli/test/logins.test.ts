import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_VERSION, run } from "../src/index.ts";

// Signing in and the saved logins (agent-access: The CLI keeps its token
// readable only by the user; agent-access: The CLI signs in through a
// restricted device flow; agent-surfaces: CLI request commands; design.md,
// Self-hosting decisions: S15). `tiehall login <url>` signs in to the install
// at that URL through the device flow and keeps one saved login per install
// URL in a file only the user can read and write, mode 0600, however the file
// was before. A command uses the one saved login there is, the one --install
// names, or the one a request URL's origin picks, and refuses when it cannot
// tell; an access token that has expired is refreshed first, and the new
// tokens replace the saved ones.

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tiehall-logins-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const file = () => join(configDir, "logins.json");
const mode = (path: string) => statSync(path).mode & 0o777;
const saved = () => (JSON.parse(readFileSync(file(), "utf8")) as { logins: Record<string, { accessToken: string; refreshToken: string; expiresAt: string }> }).logins;

/** An install at this URL whose device flow approves at the first poll, and whose API answers who the token is. */
function install(url: string, options: { tokens?: () => { access_token: string; refresh_token: string; expires_in: number } } = {}) {
  let issued = 0;
  const calls: { method: string; path: string; form: Record<string, string>; authorization: string | null; cliVersion: string | null }[] = [];
  const tokens =
    options.tokens ??
    (() => {
      issued += 1;
      return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 600 };
    });
  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const text = request.method === "POST" ? await request.text() : "";
    const form = Object.fromEntries(new URLSearchParams(text));
    calls.push({ method: request.method, path: pathname, form, authorization: request.headers.get("authorization"), cliVersion: request.headers.get("tiehall-cli-version") });
    if (pathname === "/api/auth/device/code") {
      return Response.json({ device_code: "the-device-code", user_code: "WDJB-MJHT", verification_uri: `${url}/device`, expires_in: 600, interval: 5 });
    }
    if (pathname === "/api/auth/oauth2/token") return Response.json({ token_type: "Bearer", ...tokens() });
    if (pathname === "/api/v1/inbox") return Response.json({ "requests": [] });
    if (pathname === "/api/v1/whoami") {
      return Response.json({ user: { id: "00000000-0000-4000-8000-000000000001", login: "dana-fe", kind: "human", bot: false }, teams: [], install: { url } });
    }
    return new Response("Not found", { status: 404 });
  };
  return { handle, calls };
}

/** Runs the CLI with these installs by origin; any other host cannot be reached. */
async function tiehall(args: readonly string[], installs: Record<string, (request: Request) => Promise<Response>>, now = () => new Date()) {
  let stdout = "";
  let stderr = "";
  const reached: string[] = [];
  const code = await run({
    argv: args,
    env: { TIEHALL_CONFIG_DIR: configDir },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    fetch: async (request) => {
      reached.push(new URL(request.url).origin);
      const handle = installs[new URL(request.url).origin];
      if (handle === undefined) throw new TypeError("fetch failed");
      return handle(request);
    },
    sleep: async () => {},
    now,
  });
  return { code, stdout, stderr, reached };
}

const COM = "https://tiehall.example.com";
const NET = "https://tiehall.example.net";

describe("the file of saved logins", () => {
  it("is readable only by the user, mode 0600, after a fresh login", async () => {
    const com = install(COM);
    const result = await tiehall(["login", COM], { [COM]: com.handle });
    expect(result.code).toBe(0);
    expect(mode(file())).toBe(0o600);
    expect(saved()[COM]).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
  });

  it("is readable only by the user after a login that reuses an existing file of mode 0644", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file(), JSON.stringify({ logins: { [NET]: { accessToken: "net-access", refreshToken: "net-refresh", expiresAt: "2026-09-30T12:00:00.000Z" } } }));
    chmodSync(file(), 0o644);
    expect(mode(file())).toBe(0o644);
    const com = install(COM);
    expect((await tiehall(["login", COM], { [COM]: com.handle })).code).toBe(0);
    expect(mode(file())).toBe(0o600);
    expect(Object.keys(saved()).sort()).toEqual([COM, NET]);
  });

  it("stays readable only by the user after a command refreshes its tokens", async () => {
    const com = install(COM);
    await tiehall(["login", COM], { [COM]: com.handle });
    chmodSync(file(), 0o644);
    const later = () => new Date(Date.now() + 3_600_000);
    expect((await tiehall(["inbox", "--json"], { [COM]: com.handle }, later)).code).toBe(0);
    expect(mode(file())).toBe(0o600);
  });
});

describe("tiehall login", () => {
  it("asks the install for a device code for the CLI and its MCP resource, prints where to type it, and polls until it is approved", async () => {
    const com = install(COM);
    const result = await tiehall(["login", `${COM}/`], { [COM]: com.handle });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`open ${COM}/device in a browser where you are signed in to Tiehall, and type this code: WDJB-MJHT`);
    expect(result.stdout).toContain("continue only if you just ran tiehall login");
    expect(result.stdout).toContain(`Signed in to ${COM}.`);
    expect(com.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/auth/device/code",
      form: { client_id: "tiehall-cli", resource: `${COM}/mcp`, scope: "requests:read requests:write contracts:report" },
      authorization: null,
    });
    expect(com.calls[1]).toMatchObject({
      path: "/api/auth/oauth2/token",
      form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "the-device-code", client_id: "tiehall-cli" },
    });
    expect(Object.keys(saved())).toEqual([COM]);
  });

  // requester-loop: News is announced once: the mark of the news announced is the login's user's, whom whoami names.
  it("keeps with the login the user whoami names, which a refresh of its tokens keeps too", async () => {
    const com = install(COM);
    expect((await tiehall(["login", COM], { [COM]: com.handle })).code).toBe(0);
    expect(com.calls[2]).toMatchObject({ method: "GET", path: "/api/v1/whoami", authorization: "Bearer access-1" });
    expect(saved()[COM]).toMatchObject({ accessToken: "access-1", userId: "00000000-0000-4000-8000-000000000001" });
    await tiehall(["inbox"], { [COM]: com.handle }, () => new Date(Date.now() + 3_600_000));
    expect(saved()[COM]).toMatchObject({ accessToken: "access-2", userId: "00000000-0000-4000-8000-000000000001" });
  });

  it("signs in still when the install does not answer whoami, keeping a login that names no user", async () => {
    const com = install(COM);
    const refusing = (request: Request) => (new URL(request.url).pathname === "/api/v1/whoami" ? Promise.resolve(new Response("Not found", { status: 404 })) : com.handle(request));
    const result = await tiehall(["login", COM], { [COM]: refusing });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Signed in to ${COM}.`);
    expect(saved()[COM]).not.toHaveProperty("userId");
  });

  it("keeps waiting while the code is pending, and says so when it expired before anyone approved it", async () => {
    let polls = 0;
    const handle = async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/auth/device/code") return Response.json({ device_code: "d", user_code: "ABCD-EFGH", verification_uri: `${COM}/device`, expires_in: 600, interval: 5 });
      polls += 1;
      return Response.json({ error: polls < 3 ? "authorization_pending" : "expired_token" }, { status: 400 });
    };
    const result = await tiehall(["login", COM], { [COM]: handle });
    expect(result.code).toBe(1);
    expect(polls).toBe(3);
    expect(result.stderr).toContain("The code expired before it was approved: run tiehall login again.");
    expect(existsSync(file())).toBe(false);
  });

  // An answer to a poll that carries no OAuth error, such as the error model's problem or a page a proxy wrote, is
  // no refusal of the sign-in, so the CLI says what it was: its HTTP status and, for a problem, its title and detail.
  it("says what the install answered a poll with when the answer carries no OAuth error: its status, and a problem's title and detail", async () => {
    const answers: Record<string, () => Response> = {
      problem: () =>
        new Response(
          JSON.stringify({
            type: "https://tiehall.com/problems/rate-limited",
            title: "Limit exceeded",
            status: 429,
            detail: "Too many sign-in calls came from this address. Wait, then sign in again.",
          }),
          { status: 429, headers: { "content-type": "application/problem+json", "retry-after": "30" } },
        ),
      page: () => new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } }),
    };
    const said: Record<string, string> = {
      problem: `${COM} answered the CLI's sign-in with HTTP 429 (Limit exceeded): Too many sign-in calls came from this address. Wait, then sign in again.`,
      page: `${COM} answered the CLI's sign-in with HTTP 404 and no OAuth error: check that it is your install's URL, then run tiehall login again.`,
    };
    for (const [kind, answer] of Object.entries(answers)) {
      const handle = async (request: Request) => {
        if (new URL(request.url).pathname === "/api/auth/device/code") {
          return Response.json({ device_code: "d", user_code: "ABCD-EFGH", verification_uri: `${COM}/device`, expires_in: 600, interval: 5 });
        }
        return answer();
      };
      const result = await tiehall(["login", COM], { [COM]: handle });
      expect(result.code, kind).toBe(1);
      expect(result.stderr, kind).toContain(said[kind]);
      expect(result.stderr, kind).not.toContain("refused");
      expect(existsSync(file()), kind).toBe(false);
    }
  });

  it("says what the install answered when it did not start the sign-in with an OAuth error: its status, and a problem's title and detail", async () => {
    const handle = async () =>
      new Response(JSON.stringify({ type: "https://tiehall.com/problems/setup-required", title: "Setup required", status: 503, detail: "Setup is not complete." }), {
        status: 503,
        headers: { "content-type": "application/problem+json" },
      });
    const result = await tiehall(["login", COM], { [COM]: handle });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${COM} answered the CLI's sign-in with HTTP 503 (Setup required): Setup is not complete.`);
    expect(result.stdout).not.toContain("type this code");
  });

  it("refuses a URL that is not an install's: neither https nor http://localhost", async () => {
    for (const url of ["http://tiehall.example.com", "ftp://tiehall.example.com", "tiehall.example.com", "https://tiehall.example.com/FE-142"]) {
      const result = await tiehall(["login", url], {});
      expect(result.code, url).toBe(1);
      expect(result.reached, url).toEqual([]);
    }
    const trial = install("http://localhost:3000");
    expect((await tiehall(["login", "http://localhost:3000"], { "http://localhost:3000": trial.handle })).code).toBe(0);
  });

  it("keeps one saved login per install URL: another install's beside it, and a new one in place of the same install's", async () => {
    const com = install(COM);
    const net = install(NET);
    const installs = { [COM]: com.handle, [NET]: net.handle };
    await tiehall(["login", COM], installs);
    await tiehall(["login", NET], installs);
    await tiehall(["login", COM], installs);
    expect(Object.keys(saved()).sort()).toEqual([COM, NET]);
    expect(saved()[COM]?.accessToken).toBe("access-2");
    expect(saved()[NET]?.accessToken).toBe("access-1");
  });
});

// public-api: The CLI sends its version and the server keeps a minimum.
describe("every call", () => {
  it("names the CLI's version, the sign-in's and the refresh's included", async () => {
    const com = install(COM);
    await tiehall(["login", COM], { [COM]: com.handle });
    await tiehall(["inbox"], { [COM]: com.handle }, () => new Date(Date.now() + 3_600_000));
    expect(com.calls.map(({ path }) => path)).toEqual(["/api/auth/device/code", "/api/auth/oauth2/token", "/api/v1/whoami", "/api/auth/oauth2/token", "/api/v1/inbox", "/api/v1/whoami"]);
    expect(com.calls.every(({ cliVersion }) => cliVersion === CLI_VERSION)).toBe(true);
  });
});

describe("the install a command is for", () => {
  it("is the one saved login there is", async () => {
    const com = install(COM);
    await tiehall(["login", COM], { [COM]: com.handle });
    const result = await tiehall(["inbox", "--json"], { [COM]: com.handle });
    expect(result.code).toBe(0);
    expect(com.calls.at(-1)).toMatchObject({ path: "/api/v1/inbox", authorization: "Bearer access-1" });
  });

  it("with several saved logins, is the one --install names, and a command that names none refuses, lists them and sends nothing", async () => {
    const com = install(COM);
    const net = install(NET);
    const installs = { [COM]: com.handle, [NET]: net.handle };
    await tiehall(["login", COM], installs);
    await tiehall(["login", NET], installs);
    const refused = await tiehall(["inbox"], installs);
    expect(refused.code).toBe(1);
    expect(refused.reached).toEqual([]);
    expect(refused.stderr).toBe(
      `The CLI has saved logins for several installs, so the command names the one it is for with --install <url>:\n  ${COM}\n  ${NET}\n`,
    );
    const picked = await tiehall(["inbox", "--json", "--install", `${NET}/`], installs);
    expect(picked.code).toBe(0);
    expect(picked.reached).toEqual([NET]);
  });

  it("refuses an --install that names no saved login, and sends nothing", async () => {
    const com = install(COM);
    await tiehall(["login", COM], { [COM]: com.handle });
    const result = await tiehall(["inbox", "--install", NET], { [COM]: com.handle });
    expect(result.code).toBe(1);
    expect(result.reached).toEqual([]);
    expect(result.stderr).toContain(`The CLI has no saved login for ${NET}: run tiehall login ${NET} first. It has saved logins for:\n  ${COM}`);
  });

  it("is picked by a request URL's origin, and a URL on another origin is refused with nothing sent there", async () => {
    const com = install(COM);
    const net = install(NET);
    const installs = { [COM]: com.handle, [NET]: net.handle };
    await tiehall(["login", COM], installs);
    await tiehall(["login", NET], installs);
    const picked = await tiehall(["get", `${NET}/FE-142`, "--json"], installs);
    expect(picked.reached).toEqual([NET]);
    const refused = await tiehall(["get", "https://attacker.example.net/FE-142"], installs);
    expect(refused.code).toBe(1);
    expect(refused.reached).toEqual([]);
    expect(refused.stderr).toContain("https://attacker.example.net");
    const mismatched = await tiehall(["get", `${NET}/FE-142`, "--install", COM], installs);
    expect(mismatched.code).toBe(1);
    expect(mismatched.reached).toEqual([]);
  });
});

describe("an expired access token", () => {
  it("is refreshed before the call, and the new tokens replace the saved ones", async () => {
    const com = install(COM);
    await tiehall(["login", COM], { [COM]: com.handle });
    const later = () => new Date(Date.now() + 3_600_000);
    const result = await tiehall(["inbox", "--json"], { [COM]: com.handle }, later);
    expect(result.code).toBe(0);
    const refresh = com.calls.find(({ form }) => form["grant_type"] === "refresh_token");
    expect(refresh?.form).toMatchObject({ refresh_token: "refresh-1", client_id: "tiehall-cli" });
    expect(com.calls.at(-1)).toMatchObject({ path: "/api/v1/inbox", authorization: "Bearer access-2" });
    expect(saved()[COM]).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("whose refresh the install refuses, says to sign in again", async () => {
    const com = install(COM);
    await tiehall(["login", COM], { [COM]: com.handle });
    const refusing = async (request: Request) =>
      new URL(request.url).pathname === "/api/auth/oauth2/token" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : com.handle(request);
    const result = await tiehall(["inbox"], { [COM]: refusing }, () => new Date(Date.now() + 3_600_000));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`The saved login for ${COM} no longer works: run tiehall login ${COM} again.`);
  });
});

// agent-surfaces: CLI request commands. The CLI sends its tokens and its
// sign-in's codes to its install only: it follows no redirect, so an install,
// or a proxy in front of it, that answers with one to another origin gets the
// command refused, and nothing reaches that origin.
describe("a redirect", () => {
  it("is not followed: a refresh token, a device code and a call's token never reach the origin it points to", async () => {
    const reached: { method: string | undefined; path: string | undefined; authorization: string | null; body: string }[] = [];
    const other = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        reached.push({ method: request.method, path: request.url, authorization: request.headers.authorization ?? null, body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "stolen", refresh_token: "stolen", expires_in: 600, "requests": [] }));
      });
    });
    let status = 307;
    const redirecting = createServer((request, response) => {
      request.resume();
      response.writeHead(status, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}${request.url ?? "/"}` });
      response.end();
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(redirecting.address() as AddressInfo).port}`;
    /** Runs the CLI with the global fetch, which a real install's answers reach. */
    const real = async (args: readonly string[]) => {
      let stderr = "";
      const code = await run({ argv: args, env: { TIEHALL_CONFIG_DIR: configDir }, stdout: () => {}, stderr: (text) => void (stderr += text), sleep: async () => {} });
      return { code, stderr };
    };
    const savedLogin = (expiresAt: Date) => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(file(), JSON.stringify({ logins: { [url]: { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", expiresAt: expiresAt.toISOString() } } }), { mode: 0o600 });
    };
    try {
      for (const redirect of [307, 308, 302]) {
        status = redirect;
        savedLogin(new Date(Date.now() - 60_000));
        const refresh = await real(["inbox"]);
        expect(refresh.code, `refresh, ${redirect}`).toBe(1);
        expect(refresh.stderr).toContain(`${url} answered with a redirect, which the CLI does not follow`);
        savedLogin(new Date(Date.now() + 3_600_000));
        const call = await real(["inbox"]);
        expect(call.code, `call, ${redirect}`).toBe(1);
        expect(call.stderr).toContain(`${url} answered with a redirect, which the CLI does not follow`);
        const login = await real(["login", url]);
        expect(login.code, `login, ${redirect}`).toBe(1);
        expect(login.stderr).toContain(`${url} answered with a redirect, which the CLI does not follow`);
      }
      expect(reached).toEqual([]);
      expect(saved()[url]).toMatchObject({ accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET" });
    } finally {
      await new Promise((resolve) => redirecting.close(resolve));
      await new Promise((resolve) => other.close(resolve));
    }
  });
});
