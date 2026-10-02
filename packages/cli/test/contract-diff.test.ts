import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OASDIFF_MINIMUM, run } from "../src/index.ts";

// tiehall contract diff (contract-changes: Attaching a contract diff to a
// request by hand; agent-surfaces: CLI contract and hook commands; design.md,
// Technical decisions: T12). It runs the diff engine from the developer's
// PATH, on the developer's own machine, between two refs of an OpenAPI
// document in their repository, and refuses an engine older than the version
// Tiehall pins. It prints the classified changes, and with --attach attaches
// them to a request as the contract section of its packet, through the
// operation behind attach_contract_changes, naming the revision it expects,
// with the developer's saved login. It routes nothing and sends no document.
// Here oasdiff on the PATH is a stand-in that reports its version and, for
// `changelog`, prints what the pinned oasdiff recorded for the breaking pair
// of task 23.1, keeping a copy of the documents it was handed.

const FIXTURES = fileURLToPath(new URL("../../../actions/contract/test/fixtures/oasdiff/", import.meta.url));
const INSTALL = "https://tiehall.example.com";
const scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-diff-"));
let repository: string;
let base: string;
let head: string;

/** Runs git in a folder, and throws when it fails. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(() => {
  repository = join(scratch, "payments");
  mkdirSync(join(repository, "openapi"), { recursive: true });
  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "config", "user.name", "Deniz");
  git(repository, "config", "user.email", "deniz@acme.example");
  git(repository, "remote", "add", "origin", "https://github.com/acme/payments.git");
  copyFileSync(join(FIXTURES, "breaking", "base.yaml"), join(repository, "openapi", "payments.yaml"));
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--message", "The base");
  base = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "--quiet", "-b", "new-payment-fields");
  copyFileSync(join(FIXTURES, "breaking", "revision.yaml"), join(repository, "openapi", "payments.yaml"));
  git(repository, "commit", "--quiet", "--all", "--message", "The change");
  head = git(repository, "rev-parse", "HEAD");
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A folder holding an oasdiff stand-in of this version, to put on the PATH:
 * for `changelog` it prints the breaking pair's recorded changelog and copies
 * the documents it was handed into handed/; none when no version is given.
 */
function engineOnPath(version: string | undefined): { bin: string; handed: string } {
  const bin = mkdtempSync(join(scratch, "bin-"));
  const handed = join(bin, "handed");
  mkdirSync(handed);
  if (version !== undefined) {
    const changelog = join(FIXTURES, "breaking", "changelog.json");
    writeFileSync(
      join(bin, "oasdiff"),
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "oasdiff version ${version}"; exit 0; fi`,
        `if [ "$1" = "changelog" ]; then cp "$2" "${handed}/base"; cp "$3" "${handed}/revision"; echo "$@" > "${handed}/args"; cat '${changelog}'; exit 0; fi`,
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "oasdiff"), 0o755);
  }
  return { bin, handed };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Runs `tiehall contract diff <args>` in the repository, with this engine on the PATH and an install that answers as given. */
async function contractDiff(
  args: readonly string[],
  options: { version?: string | undefined; answer?: (request: Request) => Response; login?: boolean } = {},
) {
  const engine = engineOnPath("version" in options ? options.version : "1.32.1");
  const configDir = mkdtempSync(join(scratch, "config-"));
  if (options.login !== false) {
    writeFileSync(
      join(configDir, "logins.json"),
      JSON.stringify({ logins: { [INSTALL]: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 600_000).toISOString() } } }),
      { mode: 0o600 },
    );
  }
  const calls: Call[] = [];
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv: ["contract", "diff", ...args],
    env: { PATH: `${engine.bin}:/usr/bin:/bin`, TIEHALL_CONFIG_DIR: configDir, HOME: scratch },
    cwd: repository,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    async fetch(request) {
      const text = request.method === "GET" ? "" : await request.clone().text();
      calls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: text === "" ? undefined : JSON.parse(text) });
      if (options.answer !== undefined) return options.answer(request);
      return Response.json({ message: "no install here" }, { status: 599 });
    },
  });
  const handed = readdirSync(engine.handed).length === 0 ? undefined : {
    base: readFileSync(join(engine.handed, "base"), "utf8"),
    revision: readFileSync(join(engine.handed, "revision"), "utf8"),
    args: readFileSync(join(engine.handed, "args"), "utf8").trim(),
  };
  return { code, stdout, stderr, calls, handed };
}

const DIFF = ["--api", "payments-api", "--spec", "openapi/payments.yaml", "--base", "main", "--head", "new-payment-fields"];
const ATTACH = [...DIFF, "--attach", "FE-142", "--if-match", "1", "--pull-request", "310", "--install", INSTALL];

/** The contract section the breaking pair gives. */
function contractSection() {
  return {
    api: "payments-api",
    base: { ref: "main", sha: base },
    head: { ref: "new-payment-fields", sha: head },
    engine: { name: "oasdiff", version: "1.32.1" },
    changes: [
      { id: "request-parameter-became-required", level: "ERR", operation: "POST /payments" },
      { id: "response-required-property-removed", level: "ERR", operation: "GET /payments/{id}" },
      { id: "request-parameter-removed", level: "WARN", operation: "GET /payments" },
      { id: "api-major-version-not-bumped", level: "INFO", operation: "the info section" },
      { id: "endpoint-added", level: "INFO", operation: "GET /refunds" },
    ],
    provider_pr: { repository: "acme/payments", number: 310 },
    provider_status: "open",
  };
}

describe("the diff engine on the PATH", () => {
  it("is refused when it is older than the version Tiehall pins: the command names the minimum and attaches nothing", async () => {
    const ran = await contractDiff(ATTACH, { version: "1.31.0" });

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(`needs oasdiff ${OASDIFF_MINIMUM} or later`);
    expect(ran.stderr).toContain("1.31.0");
    expect(ran.handed).toBeUndefined();
    expect(ran.calls).toEqual([]);
  });

  it("is refused when there is none, and the command says where to get it", async () => {
    const ran = await contractDiff(ATTACH, { version: undefined });

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(`needs oasdiff ${OASDIFF_MINIMUM} or later on your PATH`);
    expect(ran.stderr).toContain("https://github.com/oasdiff/oasdiff/releases");
    expect(ran.calls).toEqual([]);
  });

  it("is taken when it is newer than the version Tiehall pins", async () => {
    const ran = await contractDiff(DIFF, { version: "1.33.0" });
    expect(ran.code).toBe(0);
  });

  it("must be at least the version the contract Action pins", () => {
    const pins = JSON.parse(readFileSync(new URL("../../../actions/contract/pins.json", import.meta.url), "utf8")) as { oasdiff: { version: string } };
    expect(OASDIFF_MINIMUM).toBe(pins.oasdiff.version);
  });
});

describe("the diff", () => {
  it("runs the engine on the document at the two refs and prints the classified changes, sending nothing", async () => {
    const ran = await contractDiff(DIFF);

    expect(ran.code).toBe(0);
    expect(ran.handed?.base).toBe(readFileSync(join(FIXTURES, "breaking", "base.yaml"), "utf8"));
    expect(ran.handed?.revision).toBe(readFileSync(join(FIXTURES, "breaking", "revision.yaml"), "utf8"));
    expect(ran.handed?.args).toMatch(/^changelog \S+ \S+ --format json --allow-external-refs=false$/);
    expect(ran.stdout).toContain(`oasdiff 1.32.1 classified 5 changes of payments-api between main (${base.slice(0, 7)}) and new-payment-fields (${head.slice(0, 7)}): 2 breaking, 1 potentially breaking and 2 informational.`);
    expect(ran.stdout).toMatch(/^ {2}ERR {2}request-parameter-became-required +POST \/payments$/m);
    expect(ran.stdout).toMatch(/^ {2}WARN request-parameter-removed +GET \/payments$/m);
    expect(ran.calls).toEqual([]);
  });

  it("prints the contract section it would attach with --json", async () => {
    const ran = await contractDiff([...DIFF, "--json", "--pull-request", "310"]);

    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ contract: contractSection() });
  });

  it("refuses a ref the repository does not have", async () => {
    const ran = await contractDiff(["--api", "payments-api", "--spec", "openapi/payments.yaml", "--base", "no-such-branch"]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("no-such-branch");
  });
});

describe("--attach", () => {
  it("attaches the classified diff to the request through the attach operation, naming the revision it expects, with the saved login", async () => {
    const ran = await contractDiff(ATTACH, {
      answer: (request) =>
        new URL(request.url).pathname === "/api/v1/whoami"
          ? Response.json({ user: { id: "u1", login: "deniz", kind: "human", bot: false }, teams: [{ id: "t1", key: "PAY" }], install: { url: INSTALL } })
          : Response.json(
              {
                request: { id: "r1", key: "FE-142", state: "open", targetTeam: { id: "t2", key: "FE" }, requester: { user: { id: "u1", login: "deniz", kind: "human", bot: false }, team: { id: "t1", key: "PAY" } }, claimant: null, createdAt: "2026-10-02T09:00:00.000Z", needsHuman: false, untrusted: { title: "Move to the new payment fields" } },
                packet: { request: { id: "r1", key: "FE-142" }, revision: 2, createdAt: "2026-10-02T09:01:00.000Z", packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "n", contract: contractSection() } } },
              },
              { headers: { etag: '"2"' } },
            ),
    });

    expect(ran.code).toBe(0);
    const attach = ran.calls.find(({ method }) => method === "POST");
    expect(attach?.url).toBe(`${INSTALL}/api/v1/requests/FE-142/contract-changes`);
    expect(attach?.headers["if-match"]).toBe('"1"');
    expect(attach?.headers["authorization"]).toBe("Bearer access-1");
    expect(attach?.body).toEqual({ contract: contractSection() });
    expect(JSON.stringify(attach?.body)).not.toContain("openapi: 3.1.0");
    expect(ran.stdout).toContain("The packet of FE-142 is at revision 2 now");
  });

  it("prints the proposal an attachment to a claimed request becomes, with no confirm URL", async () => {
    const deniz = { id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", login: "deniz", kind: "human", bot: false };
    const proposal = {
      id: "8d1f6c2a-3b4e-4f5a-9c7d-0e1f2a3b4c5d",
      request: { id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", key: "FE-142" },
      kind: "scope",
      state: "pending",
      accountableHuman: deniz,
      confirmations: { needed: [{ step: "accountable_human", user: deniz, rules: [], team: null }], received: [] },
      createdAt: "2026-10-02T09:00:00.000Z",
      expiresAt: "2026-10-09T09:00:00.000Z",
    };
    const ran = await contractDiff(ATTACH, { answer: () => Response.json({ proposal }, { status: 202 }) });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("change the scope of FE-142");
    expect(ran.stdout).not.toContain("/confirm/");
  });

  it("prints the install's refusal, such as a stale expected revision, and exits with 1", async () => {
    const ran = await contractDiff(ATTACH, {
      answer: () =>
        Response.json(
          { type: "https://tiehall.com/problems/precondition-failed", title: "Precondition failed", status: 412, detail: "The packet is at revision 2, not 1: read it again and send its ETag in If-Match." },
          { status: 412, headers: { "content-type": "application/problem+json" } },
        ),
    });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("The packet is at revision 2, not 1");
  });

  it("needs the provider pull request's number, and sends nothing without it", async () => {
    const ran = await contractDiff([...DIFF, "--attach", "FE-142", "--if-match", "1", "--install", INSTALL]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("--pull-request");
    expect(ran.calls).toEqual([]);
  });
});

describe("tiehall contract", () => {
  it("lists diff and report", async () => {
    let stdout = "";
    await run({ argv: ["contract"], env: {}, stdout: (text) => void (stdout += text), stderr: () => {} });
    expect(stdout).toMatch(/^ {2}tiehall contract diff\b/m);
    expect(stdout).toMatch(/^ {2}tiehall contract report\b/m);
  });
});
