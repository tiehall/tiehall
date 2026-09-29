import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp, type StubInstallation } from "@tiehall/testing/github";
import { createGitHubClient } from "../src/index.ts";

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
