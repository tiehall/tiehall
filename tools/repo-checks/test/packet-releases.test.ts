import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  addRelease,
  LATEST_V1,
  readReleaseTree,
  releasedVersions,
  releaseHistoryProblems,
  releaseTreeProblems,
  releaseUrl,
  RELEASES_FOLDER,
  writeReleaseTree,
  type ReleaseTree,
} from "../src/packet-releases.ts";

// The fixed release URLs of the published packet schema (handoff-packet:
// Fixed release URLs; design.md, Design rules: Handoff packet; D26). Each
// published release lives at its own URL under
// https://tiehall.com/schemas/packet/, which is also its $id and never
// changes: v1.0.json, then v1.1.json and so on, while v1.json always serves
// the latest v1.x release. The repository holds that tree in
// packages/packet/releases/, which the schema's host serves as it is. Adding
// a release adds its file with its URL as $id, keeps every earlier file byte
// for byte, and moves v1.json to the new release; a check holds the tree to
// that, and the history to never changing or removing a release's file.
//
// No release is published yet, so the tests simulate v1.0 and v1.1: v1.0 is
// the committed schema as its publication makes it, with schema_version
// "1.0", and v1.1 adds an optional field to it.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const COMMITTED = readFileSync(new URL("../../../packages/packet/schema/v1-beta.json", import.meta.url), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "tiehall-packet-releases-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Json = Record<string, unknown>;
interface Variant {
  properties: { schema_version: Json; untrusted: { properties: Record<string, Json> } };
}

/** The committed schema with schema_version "1.0", as the publication switch generates it. */
function v1Schema(edit?: (variant: Variant) => void): string {
  const schema = JSON.parse(COMMITTED) as Json & { oneOf: Variant[] };
  for (const variant of schema.oneOf) {
    variant.properties.schema_version["const"] = "1.0";
    edit?.(variant);
  }
  return `${JSON.stringify(schema, null, 2)}\n`;
}

const V1_0 = v1Schema();
const V1_1 = v1Schema((variant) => (variant.properties.untrusted.properties["priority"] = { enum: ["low", "high"], type: "string", "x-tiehall-untrusted": true }));
const idOf = (text: string | undefined) => (JSON.parse(text ?? "{}") as Json)["$id"];

describe("the release-URL tree", () => {
  const empty: ReleaseTree = new Map();
  const first = addRelease(empty, V1_0);
  const second = addRelease(first, V1_1);

  it("names each release by its URL under https://tiehall.com/schemas/packet/", () => {
    expect(releaseUrl("1.0")).toBe("https://tiehall.com/schemas/packet/v1.0.json");
    expect(releaseUrl("1.1")).toBe("https://tiehall.com/schemas/packet/v1.1.json");
    expect(RELEASES_FOLDER).toBe("packages/packet/releases");
  });

  it("starts with v1.0.json, whose $id is its URL, and v1.json, which serves it", () => {
    expect([...first.keys()].sort()).toEqual(["v1.0.json", "v1.json"]);
    expect(idOf(first.get("v1.0.json"))).toBe("https://tiehall.com/schemas/packet/v1.0.json");
    expect(first.get(LATEST_V1)).toBe(first.get("v1.0.json"));
    expect(releasedVersions(first)).toEqual(["1.0"]);
    expect(releaseTreeProblems(first)).toEqual([]);
  });

  it("adds v1.1.json with its URL as $id: v1.0.json keeps its bytes, and v1.json moves to v1.1", () => {
    expect([...second.keys()].sort()).toEqual(["v1.0.json", "v1.1.json", "v1.json"]);
    expect(second.get("v1.0.json")).toBe(first.get("v1.0.json"));
    expect(idOf(second.get("v1.1.json"))).toBe("https://tiehall.com/schemas/packet/v1.1.json");
    expect(second.get(LATEST_V1)).toBe(second.get("v1.1.json"));
    expect(second.get(LATEST_V1)).not.toBe(first.get(LATEST_V1));
    expect(releasedVersions(second)).toEqual(["1.0", "1.1"]);
    expect(releaseTreeProblems(second)).toEqual([]);
    // Only the $id differs between the schema given and the release's file.
    const { $id: _given, ...given } = JSON.parse(V1_1) as Json;
    const { $id: _released, ...released } = JSON.parse(second.get("v1.1.json") ?? "{}") as Json;
    expect(released).toEqual(given);
  });

  it("refuses to publish a release again, to skip one, a v2, and a beta schema", () => {
    expect(() => addRelease(second, V1_1, "1.1")).toThrow("v1.1 is published already, and a published release never changes; the next release is v1.2.");
    expect(() => addRelease(first, V1_1, "1.2")).toThrow("The next release is v1.1, not v1.2: releases follow one another.");
    expect(() => addRelease(first, V1_1, "2.0")).toThrow("The tree holds the releases of v1, v1.0, v1.1 and on; 2.0 is not one.");
    expect(() => addRelease(empty, COMMITTED)).toThrow(
      'The schema fixes schema_version to "1-beta": a beta schema is not a release. Turn the publication switch on and regenerate the schema first.',
    );
  });

  it("is written to a folder and read back as it was", () => {
    const folder = join(scratch, "written");
    writeReleaseTree(folder, second);
    expect(readReleaseTree(folder)).toEqual(second);
  });
});

describe("the release-URL tree's check", () => {
  const tree = addRelease(addRelease(new Map(), V1_0), V1_1);
  const with_ = (name: string, text: string | undefined): ReleaseTree => {
    const changed = new Map(tree);
    if (text === undefined) changed.delete(name);
    else changed.set(name, text);
    return changed;
  };

  it("passes an empty tree, before the first release", () => {
    expect(releaseTreeProblems(new Map())).toEqual([]);
  });

  it("fails when v1.json is not the latest release, or is missing", () => {
    expect(releaseTreeProblems(with_(LATEST_V1, tree.get("v1.0.json")))).toEqual(["v1.json is not v1.1.json, the latest v1.x release, byte for byte."]);
    expect(releaseTreeProblems(with_(LATEST_V1, undefined))).toEqual(["v1.json is missing: it serves v1.1.json, the latest v1.x release."]);
  });

  it("fails on a release whose $id is not its URL, on a gap between releases, and on a file that is no release", () => {
    const wrongId = (JSON.parse(tree.get("v1.0.json") ?? "{}") as Json) ;
    wrongId["$id"] = "https://tiehall.com/schemas/packet/v1-beta.json";
    expect(releaseTreeProblems(with_("v1.0.json", `${JSON.stringify(wrongId, null, 2)}\n`))).toEqual([
      "v1.0.json has the $id https://tiehall.com/schemas/packet/v1-beta.json; a release's $id is its URL, https://tiehall.com/schemas/packet/v1.0.json.",
    ]);
    expect(releaseTreeProblems(with_("v1.0.json", undefined))).toEqual(["The tree has no v1.0.json: releases start at v1.0 and follow one another."]);
    expect(releaseTreeProblems(with_("notes.txt", "x"))).toEqual(["notes.txt is not a release: the tree holds v1.<minor>.json files and v1.json."]);
    expect(releaseTreeProblems(new Map([[LATEST_V1, V1_0]]))).toEqual(["v1.json is in the tree before any release."]);
  });
});

describe("the release-URL tree's history", () => {
  let made = 0;
  /** A repository of the test's own with one commit per tree, in order. */
  function history(...trees: ReleaseTree[]): string {
    made += 1;
    const repo = join(scratch, `repo-${made}`);
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    };
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "maintainers@example.com");
    git("config", "user.name", "Maintainers");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "A repository.\n");
    git("add", "--all");
    git("commit", "--quiet", "--message", "Start");
    for (const [index, tree] of trees.entries()) {
      const folder = join(repo, RELEASES_FOLDER);
      rmSync(folder, { recursive: true, force: true });
      writeReleaseTree(folder, tree);
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "--message", `Tree ${index + 1}`);
    }
    return repo;
  }

  const first = addRelease(new Map(), V1_0);
  const second = addRelease(first, V1_1);

  it("passes a history in which releases are only added", () => {
    expect(releaseHistoryProblems(history(first, second))).toEqual([]);
  });

  it("fails when a commit changed a release's file, or removed it", () => {
    const edited = new Map(second);
    edited.set("v1.0.json", `${(edited.get("v1.0.json") ?? "").trimEnd()} \n`);
    expect(releaseHistoryProblems(history(first, edited))).toEqual([
      "v1.0.json differs from what an earlier commit published; a published release never changes.",
    ]);
    const removed = new Map(second);
    removed.delete("v1.0.json");
    expect(releaseHistoryProblems(history(first, second, removed))).toContain("v1.0.json was published and is gone; a published release is never removed.");
  });

  it("passes the repository, which publishes no release yet", () => {
    expect(releaseHistoryProblems(root)).toEqual([]);
    expect(releaseTreeProblems(readReleaseTree(join(root, RELEASES_FOLDER)))).toEqual([]);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../src/check-packet-releases.ts", import.meta.url))], { cwd: root, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No release of the packet schema is published yet");
  });
});
