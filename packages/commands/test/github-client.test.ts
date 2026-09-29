import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubInstallation } from "@tiehall/testing/github";
import { Refusal } from "@tiehall/core";
import {
  convertManifestCode,
  createGitHubClient,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubUnavailableError,
  LOGGABLE,
  readSignedInUser,
  requestInstallationToken,
} from "../src/index.ts";

// The GitHub client assumes no length for installation tokens
// (github-app-reachability: design.md, Design rules: Installation tokens;
// tracker-mirrors: GitHub writes appear as the App's bot). GitHub is moving
// installation tokens to a format of about 520 characters, with `_`, `-` and
// `.` after the `ghs_` prefix, so the client passes each token on exactly as
// GitHub issued it, whatever its length, and keeps it only in memory: no
// column of the schema and no field of the catalog holds one
// (github-app-reachability: design.md, Technical decisions: T5).

let stub: GitHubStub;
let app: StubApp;
let installation: StubInstallation;

beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
  app = stub.createApp({ owner: "acme" });
  installation = await stub.install(app, { account: "acme", repositories: ["acme/web", "acme/api"] });
});

afterEach(async () => {
  await stub.close();
});

describe("installation tokens of any length", () => {
  for (const length of [520, 2_048]) {
    it(`carries a ${length}-character token on every call exactly as the stub issued it`, async () => {
      stub.setInstallationTokenLength(length);
      const client = createGitHubClient({ clientId: app.clientId, privateKey: app.pem }, { apiUrl: stub.apiUrl });
      const octokit = client.installation(installation.id);

      const listed = await octokit.request("GET /installation/repositories", { per_page: 100 });
      expect(listed.data.repositories.map((repository) => repository.full_name).sort()).toEqual(["acme/api", "acme/web"]);
      const repository = await octokit.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "web" });
      expect(repository.status).toBe(200);

      // One token, kept in memory for the next call, and used exactly as issued.
      const issued = stub.issuedInstallationTokens(installation);
      expect(issued).toHaveLength(1);
      const [token] = issued as [string];
      expect(token).toHaveLength(length);
      expect(token).toMatch(/^ghs_[A-Za-z0-9_.-]+$/);
      const calls = stub.received.filter((request) => request.host === "api" && request.token?.kind === "installation");
      expect(calls.map((call) => call.path)).toEqual(["/installation/repositories", "/repos/acme/web"]);
      for (const call of calls) {
        expect(call.token!.value).toBe(token);
        expect(call.headers["authorization"]).toBe(`token ${token}`);
        expect(call.status).toBe(200);
      }
    });
  }

  it("calls as the App with a JWT whose issuer is the client id, and with nothing else", async () => {
    const client = createGitHubClient({ clientId: app.clientId, privateKey: app.pem }, { apiUrl: stub.apiUrl });
    const installations = await client.app().request("GET /app/installations", { per_page: 100 });
    expect(installations.data.map((item) => item.id)).toEqual([installation.id]);
    await client.installation(installation.id).request("GET /installation/repositories");
    const kinds = stub.received.filter((request) => request.host === "api").map((request) => request.token?.kind);
    expect(new Set(kinds)).toEqual(new Set(["app-jwt", "installation"]));
    // Each JWT names the App's client id as its issuer, not the App's numeric id, which GitHub would take too.
    const issuers = stub.received
      .filter((request) => request.token?.kind === "app-jwt")
      .map((request) => (JSON.parse(Buffer.from(request.token!.value.split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: unknown }).iss);
    expect(issuers.length).toBeGreaterThan(0);
    for (const issuer of issuers) expect(issuer).toBe(app.clientId);
  });
});

describe("conditional requests (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode)", () => {
  it("asks for a URL it read before with If-None-Match, and gives GitHub's 304 back as the answer it read before", async () => {
    const client = createGitHubClient({ clientId: app.clientId, privateKey: app.pem }, { apiUrl: stub.apiUrl });
    const octokit = client.installation(installation.id);

    const first = await octokit.request("GET /installation/repositories", { per_page: 100 });
    const second = await octokit.request("GET /installation/repositories", { per_page: 100 });
    stub.addRepo("acme/tools");
    await stub.addRepositories(installation, ["acme/tools"], { delivery: "none" });
    const third = await octokit.request("GET /installation/repositories", { per_page: 100 });

    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
    expect(third.data.repositories.map((repository) => repository.full_name).sort()).toEqual(["acme/api", "acme/tools", "acme/web"]);
    const reads = stub.received.filter(({ host, path }) => host === "api" && path === "/installation/repositories");
    expect(reads.map(({ status, headers }) => ({ status, conditional: headers["if-none-match"] !== undefined }))).toEqual([
      { status: 200, conditional: false },
      { status: 304, conditional: true },
      { status: 200, conditional: true },
    ]);
  });
});

describe("where installation tokens are kept", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const sourcesIn = (folder: string, extension: string): string[] =>
    readdirSync(join(root, folder), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(extension))
      .map((file) => join(folder, file));
  /** An identifier for an installation token: installation_token, installationToken, installation_access_token and the like. */
  const TOKEN_FIELD = /installation_?(?:access_?)?token/i;

  it("is no column of the schema or its migrations", () => {
    for (const path of ["packages/db/src/schema.ts", ...sourcesIn("packages/db/migrations", ".sql")]) {
      expect({ path, match: TOKEN_FIELD.exec(read(path))?.[0] }).toEqual({ path, match: undefined });
    }
  });

  it("is no field of the catalog's schemas or of the documents made from them", () => {
    for (const path of [...sourcesIn("packages/catalog/src", ".ts"), "openapi/v1.json", "mcp/tools.json", "packages/packet/schema/v1-beta.json"]) {
      expect({ path, match: TOKEN_FIELD.exec(read(path))?.[0] }).toEqual({ path, match: undefined });
    }
  });
});

// Every call to GitHub waits a bounded time (tracker-mirrors: GitHub writes
// appear as the App's bot; design.md, Technical decisions: T16): the client
// gives each request a timeout of 10 seconds, unless the call gives a signal
// of its own, so a GitHub that stops answering holds up no web request and no
// worker slot. A call that times out fails like any other call GitHub does not
// answer: the App's calls throw, the key check throws, the manifest conversion
// throws its own error, and the sign-in learns nobody signed in.
describe("a GitHub that does not answer", () => {
  /** A fetch that never answers: its promise settles only when the request's signal aborts it. */
  const silent = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  const options = { apiUrl: "https://api.github.invalid", fetch: silent, timeoutMs: 200 };

  it("waits 10 seconds by default", () => {
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it("gives up on the App's own calls, on an installation's calls and on the token request before them", async () => {
    const client = createGitHubClient({ clientId: app.clientId, privateKey: app.pem }, options);
    await expect(client.app().request("GET /app/installations")).rejects.toThrow();
    await expect(client.installation(installation.id).request("GET /installation/repositories")).rejects.toThrow();
  });

  it("gives up on the key check, the manifest conversion and the sign-in's read of who signed in", async () => {
    await expect(requestInstallationToken({ clientId: app.clientId, privateKey: app.pem }, installation.id, options)).rejects.toThrow();
    // Not answering is GitHub being unavailable (D50 (3)): the error gives no status, since GitHub gave none.
    const conversion = convertManifestCode("a-manifest-code", options);
    await expect(conversion).rejects.toBeInstanceOf(GitHubUnavailableError);
    await expect(conversion).rejects.toMatchObject({ status: undefined });
    expect(await readSignedInUser("a-user-token", options)).toBeUndefined();
  });

  it("gives every request a signal by default, and a call's own signal in place of it", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return fetch(input, init);
    }) as typeof fetch;
    const client = createGitHubClient({ clientId: app.clientId, privateKey: app.pem }, { apiUrl: stub.apiUrl, fetch: recording });
    await client.installation(installation.id).request("GET /installation/repositories");
    // The token request and the call itself.
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);

    const own = new AbortController();
    await client.installation(installation.id).request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "web", request: { signal: own.signal } });
    expect(signals.at(-1)).toBe(own.signal);
  });
});

// GitHub unavailable (public-api: One error model for Tiehall's own refusals;
// design.md, Technical decisions: T2): when GitHub answers a call with a status
// its caller gives no answer of its own for, or not at all, the client throws
// one error, which the actions that asked turn into 502
// integration-unavailable. Its message is Tiehall's own words, which name
// GitHub's status and nothing of the call's input, so the logger keeps it.
describe("a GitHub that fails a call", () => {
  it("that converts a manifest's code: GitHub's refusal of the code is GitHub unavailable, with GitHub's status", async () => {
    const error = await convertManifestCode("a-code-github-never-issued", { apiUrl: stub.apiUrl }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitHubUnavailableError);
    expect(error).toMatchObject({ status: 404 });
    expect((error as GitHubUnavailableError)[LOGGABLE]).toBe(true);
    expect((error as Error).message).not.toContain("a-code-github-never-issued");

    const failing = (async () => new Response('{"message":"Server Error"}', { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(convertManifestCode("a-manifest-code", { apiUrl: stub.apiUrl, fetch: failing })).rejects.toMatchObject({
      name: "GitHubUnavailableError",
      status: 500,
    });
  });

  it("that converts a code not in the form GitHub issues: refused as invalid input, before GitHub is asked", async () => {
    let asked = 0;
    const counting = (async (input: string | URL | Request, init?: RequestInit) => {
      asked += 1;
      return fetch(input, init);
    }) as typeof fetch;
    for (const code of ["", "not a code/../x", "a".repeat(201)]) {
      const error = await convertManifestCode(code, { apiUrl: stub.apiUrl, fetch: counting }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Refusal);
      expect(error).toMatchObject({ reason: "invalid-input", status: 400, issues: [{ path: ["code"] }] });
    }
    expect(asked).toBe(0);
  });
});
