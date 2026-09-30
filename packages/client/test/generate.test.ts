import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { clientDrift, ClientGenerationError, commandTable, GENERATED_FILES, generateClient, type OpenApiDocument } from "../src/generate.ts";

// @tiehall/client, generated from the OpenAPI document (public-api: The client
// package `@tiehall/client`; public-api: The license map; design.md, Technical
// decisions: T10; design.md, Self-hosting decisions: S16). `pnpm
// client:generate` writes the client's types with openapi-typescript and the
// CLI's command table, read from each operation's x-tiehall-cli extension,
// from openapi/v1.json; CI regenerates both with `pnpm check:client` and fails
// when either differs from what is committed, so a hand edit, or an API change
// that was not regenerated, cannot pass.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-client.ts", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("fixtures/openapi.json", import.meta.url), "utf8")) as OpenApiDocument;

/** The fixture document with this operation's x-tiehall-cli replaced. */
function withCli(path: string, method: string, cli: unknown): OpenApiDocument {
  const document = structuredClone(fixture) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const operation = document.paths[path]?.[method];
  if (operation === undefined) throw new Error(`the fixture has no ${method} ${path}`);
  operation["x-tiehall-cli"] = cli;
  return document;
}

describe("the command table", () => {
  it("reads each command from its operation's x-tiehall-cli extension, sorted by name, with the fields the operation takes", () => {
    expect(commandTable(fixture)).toEqual([
      {
        command: "ask",
        operationId: "messages.post",
        summary: "Post a question or an answer in a request's thread.",
        method: "POST",
        path: "/api/v1/requests/{key}/messages",
        stability: "alpha",
        arguments: ["key", "body"],
        input: {},
        defaults: { kind: "question" },
        fields: [
          { name: "key", in: "path", types: ["string"], required: true },
          { name: "blocking", in: "body", types: ["boolean"], required: false, description: "Whether the request waits for the answer." },
          { name: "body", in: "body", types: ["string"], required: true, description: "The message's text." },
          { name: "kind", in: "body", types: ["string"], values: ["question", "answer"], required: true },
          { name: "questionId", in: "body", types: ["string"], required: false, description: "The id of the question this answers." },
        ],
        proposes: false,
      },
      {
        command: "open",
        operationId: "requests.create",
        summary: "Open a request to a team.",
        method: "POST",
        path: "/api/v1/requests",
        stability: "beta",
        arguments: ["targetTeam"],
        input: {},
        defaults: {},
        fields: [
          { name: "packet", in: "body", types: ["object"], required: true },
          { name: "targetTeam", in: "body", types: ["string"], required: true, description: "The key of the team the request is addressed to, such as FE." },
          { name: "title", in: "body", types: ["string"], required: true },
          { name: "Idempotency-Key", in: "header", types: ["string"], required: false, description: "A key of your choice that makes a retried POST run once." },
        ],
        proposes: false,
      },
      {
        command: "propose",
        operationId: "requests.propose",
        summary: "Propose a due date.",
        method: "POST",
        path: "/api/v1/requests/{key}/proposals",
        stability: "alpha",
        arguments: ["key"],
        input: {},
        defaults: {},
        fields: [
          { name: "key", in: "path", types: ["string"], required: true },
          { name: "dueDate", in: "body", types: ["string", "null"], required: true, description: "The due date to propose, or null to remove it." },
          { name: "limit", in: "body", types: ["integer"], required: false },
          { name: "If-Match", in: "header", types: ["string"], required: false, description: 'The ETag of the packet\'s current revision, such as "3".' },
        ],
        proposes: true,
      },
      {
        command: "reply",
        operationId: "messages.post",
        summary: "Post a question or an answer in a request's thread.",
        method: "POST",
        path: "/api/v1/requests/{key}/messages",
        stability: "alpha",
        arguments: ["key", "body"],
        input: { kind: "answer" },
        defaults: {},
        // Only the variant its fixed kind picks: an answer, which names its question.
        fields: [
          { name: "key", in: "path", types: ["string"], required: true },
          { name: "body", in: "body", types: ["string"], required: true, description: "The message's text." },
          { name: "kind", in: "body", types: ["string"], values: ["answer"], required: true },
          { name: "questionId", in: "body", types: ["string"], required: true, description: "The id of the question this answers." },
        ],
        proposes: false,
      },
    ]);
  });

  it("holds no operation the CLI does not offer", () => {
    expect(commandTable(fixture).map(({ operationId }) => operationId)).not.toContain("requests.list");
  });

  it("refuses an x-tiehall-cli that the CLI could not build a command from", () => {
    const refusal = (document: OpenApiDocument) => {
      try {
        commandTable(document);
      } catch (error) {
        if (error instanceof ClientGenerationError) return error.message;
        throw error;
      }
      return undefined;
    };
    expect(refusal(withCli("/api/v1/requests", "post", { command: "open" }))).toBe(
      "POST /api/v1/requests: its x-tiehall-cli names no list of commands.",
    );
    expect(refusal(withCli("/api/v1/requests", "post", { commands: [{ arguments: ["targetTeam"] }] }))).toBe(
      "POST /api/v1/requests: a command of its x-tiehall-cli has no name.",
    );
    expect(refusal(withCli("/api/v1/requests", "post", { commands: [{ command: "open", arguments: ["team"] }] }))).toBe(
      "POST /api/v1/requests: its command open takes team, which the operation does not take.",
    );
    expect(refusal(withCli("/api/v1/requests", "post", { commands: [{ command: "open", input: { draft: true } }] }))).toBe(
      "POST /api/v1/requests: its command open sets draft, which the operation does not take.",
    );
    expect(refusal(withCli("/api/v1/requests", "post", { commands: [{ command: "ask" }] }))).toBe(
      "POST /api/v1/requests/{key}/messages: its command ask is also a command of POST /api/v1/requests.",
    );
  });
});

describe("the generated client", () => {
  it("holds the types of every operation, with openapi-typescript, and the command table", async () => {
    const files = await generateClient(fixture);
    expect(Object.keys(files).sort()).toEqual([...GENERATED_FILES].sort());
    const types = files["src/generated/openapi.ts"] ?? "";
    expect(types).toMatch(/^\/\/ Generated by `pnpm client:generate` from openapi\/v1\.json/);
    expect(types).toContain("export interface paths {");
    expect(types).toContain('"/api/v1/requests/{key}/messages": {');
    expect(types).toContain('"messages.post": {');
    const commands = files["src/generated/commands.ts"] ?? "";
    expect(commands).toContain("export const COMMAND_TABLE: readonly CommandEntry[] = [");
    expect(commands).toContain('"command": "reply"');
  });

  it("is the same every time it is generated from the same document", async () => {
    expect(await generateClient(fixture)).toEqual(await generateClient(fixture));
  });
});

describe("the drift check", () => {
  it("passes files that the document regenerates unchanged", async () => {
    const files = await generateClient(fixture);
    expect(clientDrift(files, files)).toBeUndefined();
  });

  it("fails on a hand edit of a generated file, naming the file and the command that regenerates it", async () => {
    const files = await generateClient(fixture);
    const edited = { ...files, "src/generated/commands.ts": (files["src/generated/commands.ts"] ?? "").replace('"command": "reply"', '"command": "answer"') };
    const drift = clientDrift(files, edited);
    expect(drift).toContain("packages/client/src/generated/commands.ts differs from what openapi/v1.json generates.");
    expect(drift).toContain("pnpm client:generate");
    expect(drift).toContain('"command": "reply"');
  });

  it("fails when a generated file is missing", async () => {
    const files = await generateClient(fixture);
    const { ["src/generated/openapi.ts"]: _removed, ...rest } = files;
    expect(clientDrift(files, rest)).toContain("packages/client/src/generated/openapi.ts is missing");
  });
});

describe("the check's script", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tiehall-client-check-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function check(root: string) {
    const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    if (run.error) throw run.error;
    return run;
  }

  /** A copy of the repository's document and generated client, under a root of its own. */
  function copyOfTheTree(name: string): string {
    const root = join(scratch, name);
    for (const file of ["openapi/v1.json", ...GENERATED_FILES.map((path) => `packages/client/${path}`)]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(repoRoot, file), join(root, file));
    }
    return root;
  }

  it("passes on the real tree, whose generated client is what openapi/v1.json generates", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("@tiehall/client is what openapi/v1.json generates");
  });

  it("fails on a hand edit of the committed client", () => {
    const root = copyOfTheTree("hand-edit");
    const file = join(root, "packages/client/src/generated/openapi.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("export interface paths {", "export interface paths {\n    \"/api/v1/hand-edited\": never;"));
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("packages/client/src/generated/openapi.ts differs from what openapi/v1.json generates.");
    expect(run.stderr).toContain("pnpm client:generate");
  });

  it("fails when the document changed and the client was not regenerated", () => {
    const root = copyOfTheTree("stale");
    const file = join(root, "openapi/v1.json");
    const document = JSON.parse(readFileSync(file, "utf8")) as { paths: Record<string, Record<string, { summary: string }>> };
    const [first] = Object.values(document.paths).flatMap((item) => Object.values(item));
    if (first === undefined) throw new Error("openapi/v1.json has no operation");
    first.summary = "A summary changed without regenerating the client.";
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("differs from what openapi/v1.json generates");
  });
});
