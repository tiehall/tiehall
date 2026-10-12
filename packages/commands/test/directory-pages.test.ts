import { describe, expect, it } from "vitest";
import { wholeDirectory } from "../src/directory-pages.ts";

// Every page of directory, for the web UI's pages that list every team of the
// install (agent-surfaces: The MCP tools; decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (39), as the maintainer
// answered on 2026-10-12). A page may end inside one API's list of consumers,
// or inside the list of the teams a team's intake notes' writer belonged to,
// and the next page goes on with the same API or team: the whole directory
// joins the parts again, so each team and each API is listed once, with its
// whole list, and no part says that it goes on.

const team = (id: string, writers: string[] | null, flags: Record<string, boolean> = {}) => ({
  id,
  key: id.toUpperCase(),
  intakeNotesWrittenBy: writers === null ? null : writers.map((key) => ({ id: `id-${key}`, key })),
  untrusted: { name: `Team ${id}`, intakeNotes: "" },
  ...flags,
});
const api = (id: string, consumers: string[], flags: Record<string, boolean> = {}) => ({
  id,
  consumers: consumers.map((key) => ({ id: `id-${key}`, key })),
  untrusted: { name: `api-${id}` },
  ...flags,
});

describe("the whole directory", () => {
  it("reads every page in turn, and joins a team or an API that goes on from one page to the next", async () => {
    const pages: Record<string, unknown> = {
      first: { teams: [team("a", null), team("b", ["X1"], { continuedOnNextPage: true })], apis: [], next: "c1" },
      c1: { teams: [team("b", ["X2"], { continuedFromPreviousPage: true, continuedOnNextPage: true })], apis: [], next: "c2" },
      c2: { teams: [team("b", ["X3"], { continuedFromPreviousPage: true }), team("c", [])], apis: [api("p", ["T1"], { continuedOnNextPage: true })], next: "c3" },
      c3: { teams: [], apis: [api("p", ["T2"], { continuedFromPreviousPage: true }), api("q", [])], next: null },
    };
    const asked: unknown[] = [];
    const whole = await wholeDirectory(async <Output>(commandId: string, input: unknown) => {
      expect(commandId).toBe("directory.get");
      asked.push(input);
      const { cursor } = input as { cursor?: string };
      return pages[cursor ?? "first"] as Output;
    });
    expect(asked).toEqual([{}, { cursor: "c1" }, { cursor: "c2" }, { cursor: "c3" }]);
    expect(whole.teams).toEqual([team("a", null), team("b", ["X1", "X2", "X3"]), team("c", [])]);
    expect(whole.apis).toEqual([api("p", ["T1", "T2"]), api("q", [])]);
  });
});
