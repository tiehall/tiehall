import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COMMAND_TABLE, type CommandEntry } from "@tiehall/client";
import { callOf, optionOf } from "../src/arguments.ts";
import { CliError } from "../src/environment.ts";

// A request command's arguments (agent-surfaces: CLI request commands;
// design.md, Self-hosting decisions: S16). Each command takes the fields its
// entry of the command table names as positional arguments, and every other
// field of its operation as an option named after it; a value takes its
// field's JSON type, and JSON comes as itself, from a file or from standard
// input. The command sets its own input where the table says so.

const scratch = mkdtempSync(join(tmpdir(), "tiehall-cli-arguments-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function entry(command: string): CommandEntry {
  const found = COMMAND_TABLE.find((each) => each.command === command);
  if (found === undefined) throw new Error(`the command table has no ${command}`);
  return found;
}

const noStdin = async () => "";

async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof CliError) return error.message;
    throw error;
  }
  throw new Error("the arguments were taken");
}

describe("the options", () => {
  it("are the fields' names in lower-case words joined by hyphens", () => {
    expect(["questionId", "targetTeam", "key", "If-Match", "Idempotency-Key", "dueDate"].map(optionOf)).toEqual([
      "--question-id",
      "--target-team",
      "--key",
      "--if-match",
      "--idempotency-key",
      "--due-date",
    ]);
  });
});

describe("a command's call", () => {
  it("takes its arguments in order, as the path and the body carry them", async () => {
    expect(await callOf(entry("status"), ["FE-142", "open"], noStdin)).toEqual({ path: { key: "FE-142" }, query: {}, header: {}, body: { state: "open" } });
    expect(await callOf(entry("link-pr"), ["FE-142", "https://github.com/acme/web/pull/88"], noStdin)).toEqual({
      path: { key: "FE-142" },
      query: {},
      header: {},
      body: { url: "https://github.com/acme/web/pull/88" },
    });
  });

  it("takes options as --name value or --name=value, and a flag alone", async () => {
    expect(await callOf(entry("ask"), ["FE-142", "Which browsers?", "--blocking"], noStdin)).toEqual({
      path: { key: "FE-142" },
      query: {},
      header: {},
      body: { kind: "question", body: "Which browsers?", blocking: true },
    });
    expect((await callOf(entry("ask"), ["FE-142", "Noted.", "--kind=comment"], noStdin)).body).toEqual({ kind: "comment", body: "Noted." });
    expect((await callOf(entry("inbox"), ["--state", "open", "--limit", "5"], noStdin)).query).toEqual({ state: "open", limit: 5 });
  });

  it("sets the input its command sets itself, and offers no option for it", async () => {
    expect((await callOf(entry("reply"), ["FE-142", "Chrome.", "--question-id", "0b1f2d4e-1111-4222-8333-944455556666"], noStdin)).body).toEqual({
      kind: "answer",
      body: "Chrome.",
      questionId: "0b1f2d4e-1111-4222-8333-944455556666",
    });
    expect(await refusal(callOf(entry("reply"), ["FE-142", "Chrome.", "--kind", "comment"], noStdin))).toContain("tiehall reply has no option --kind.");
  });

  it("takes JSON as itself, from a file with @, or from standard input with -", async () => {
    const packet = { schema_version: "1-beta", kind: "request", untrusted: { need: "Add a dark mode." } };
    const file = join(scratch, "packet.json");
    writeFileSync(file, JSON.stringify(packet));
    for (const [value, stdin] of [
      [JSON.stringify(packet), noStdin],
      [`@${file}`, noStdin],
      ["-", async () => JSON.stringify(packet)],
    ] as const) {
      const call = await callOf(entry("open"), ["FE", "--title", "Dark mode", "--packet", value], stdin);
      expect(call.body).toEqual({ targetTeam: "FE", title: "Dark mode", packet });
    }
    expect(await refusal(callOf(entry("open"), ["FE", "--packet", "{not json"], noStdin))).toContain("--packet is JSON");
  });

  it("sends a revision given to --if-match as its ETag, and null to a field that takes it", async () => {
    const call = await callOf(entry("propose"), ["due_date", "FE-142", "--due-date", "null", "--if-match", "3"], noStdin);
    expect(call.header).toEqual({ "If-Match": '"3"' });
    expect(call.body).toEqual({ kind: "due_date", key: "FE-142", dueDate: null });
  });

  it("refuses what the command does not take, and says how to see what it does", async () => {
    expect(await refusal(callOf(entry("claim"), ["FE-142", "FE-143"], noStdin))).toBe(
      "tiehall claim takes at most 1: <key>. Run tiehall claim --help for its arguments and options.",
    );
    expect(await refusal(callOf(entry("claim"), [], noStdin))).toContain("tiehall claim needs <key>.");
    expect(await refusal(callOf(entry("inbox"), ["--limit", "many"], noStdin))).toContain("--limit is a number.");
    expect(await refusal(callOf(entry("status"), ["FE-142", "closed"], noStdin))).toContain("<state> is one of in_progress, open, declined, done.");
    expect(await refusal(callOf(entry("ask"), ["FE-142", "Hi", "--blocking=maybe"], noStdin))).toContain("--blocking is true or false.");
    expect(await refusal(callOf(entry("ask"), ["FE-142", "--body"], noStdin))).toContain("--body needs a value.");
  });
});
