import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPackage, PackageBuildError } from "../src/build-package.ts";
import { packageContentProblems, packedFiles, packTarball, RENDERER_MODULES, tarballConformance } from "../src/package-check.ts";
import { generatedTypes, TYPES_FILE } from "../src/types-generation.ts";

// The npm package @tiehall/packet (handoff-packet: The npm package; handoff-
// packet: The Apache-2.0 schema directory; public-api: The license map). It
// is built from this directory, under Apache-2.0, and holds the packet's
// types, a validator and the conformance fixtures, with the schema the
// validator reads; it holds no fencing renderer, which this directory keeps
// for Tiehall's own server, nor any other source of the directory's. The
// build compiles the validator, the fixture runner and the types to
// JavaScript with their declarations, copies the schema, the fixtures, the
// license and the spec, and writes the package's manifest. The check runs npm's
// pack dry run, which lists what a publish would upload, holds the list to
// that, packs the tarball, installs it in a folder of its own as a consumer
// would, and runs its validator over its own fixtures. The CI job that
// publishes it stays off until the schema is published (tools/repo-checks/
// test/packet-package-workflow.test.ts).

const directory = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "tiehall-packet-package-"));
const out = join(scratch, "package");
const fixturesIn = (expected: string) => readdirSync(join(directory, "fixtures", expected)).filter((name) => name.endsWith(".json")).length;
let files: string[] = [];

beforeAll(() => {
  buildPackage({ out, version: "1.0.0" });
  files = packedFiles(out);
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the @tiehall/packet package", () => {
  it("holds the types, the validator, the fixture runner, the schema, the fixtures, the license and the spec", () => {
    for (const file of ["package.json", "LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", "dist/validator.js", "dist/conformance.js", "dist/types.d.ts", "schema/v1-beta.json"]) {
      expect(files, file).toContain(file);
    }
    expect(files.filter((file) => file.startsWith("fixtures/valid/"))).toHaveLength(fixturesIn("valid"));
    expect(files.filter((file) => file.startsWith("fixtures/invalid/"))).toHaveLength(fixturesIn("invalid"));
    expect(packageContentProblems(out, files)).toEqual([]);
  });

  it("holds no fencing renderer, and none of the directory's sources or tests", () => {
    for (const module of RENDERER_MODULES) expect(files.filter((file) => file.includes(module)), module).toEqual([]);
    expect(files.filter((file) => file.startsWith("src/") || file.startsWith("test/") || file.endsWith(".ts") && !file.endsWith(".d.ts"))).toEqual([]);
  });

  it("is licensed under Apache-2.0, depends only on the validator's ajv, pinned, and names its source for npm's provenance", () => {
    const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "@tiehall/packet", version: "1.0.0", license: "Apache-2.0", type: "module" });
    expect(manifest["private"]).toBeUndefined();
    const packet = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(manifest["dependencies"]).toEqual({ ajv: packet.dependencies["ajv"] });
    expect(manifest["repository"]).toEqual({ type: "git", url: "git+https://github.com/muhmmdcnkl/Tiehall.git", directory: "packages/packet" });
    expect(readFileSync(join(out, "LICENSE"), "utf8")).toBe(readFileSync(join(directory, "LICENSE"), "utf8"));
  });

  it(
    "has a validator that, installed from the tarball, accepts every valid fixture and rejects every invalid one",
    () => {
      const tarball = packTarball(out, scratch);
      expect(tarball).toMatch(/tiehall-packet-1\.0\.0\.tgz$/);
      const result = tarballConformance(tarball, join(scratch, "consumer"));
      expect(result.problems).toEqual([]);
      expect(result).toMatchObject({ valid: fixturesIn("valid"), invalid: fixturesIn("invalid") });
    },
    120_000,
  );

  it("fails a package that holds the renderer, lacks its fixtures or is no Apache-2.0 package", () => {
    const bad = join(scratch, "bad");
    cpSync(out, bad, { recursive: true });
    writeFileSync(join(bad, "dist", "render.js"), "export {};\n");
    rmSync(join(bad, "fixtures", "invalid"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(bad, "package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(bad, "package.json"), `${JSON.stringify({ ...manifest, license: "AGPL-3.0-only" }, null, 2)}\n`);
    expect(packageContentProblems(bad, packedFiles(bad))).toEqual([
      "package.json: states the license AGPL-3.0-only; @tiehall/packet is licensed under Apache-2.0.",
      "dist/render.js: is the fencing renderer, which @tiehall/packet leaves out.",
      "fixtures/invalid: holds no fixture; the package carries the invalid fixtures too.",
    ]);
  });

  it("refuses a version that is no semantic version", () => {
    expect(() => buildPackage({ out: join(scratch, "unversioned"), version: "v1" })).toThrow(PackageBuildError);
  });
});

describe("the package of a published release", () => {
  // From publication on, the publish job versions the package after the latest release of the release-URL tree,
  // v1.<minor> as 1.<minor>.0 (handoff-packet: Fixed release URLs), so the package carries that release's schema,
  // whose $id is its release URL. The tests simulate v1.0 and v1.1, which adds an optional field.
  const releases = join(scratch, "releases");
  const release = (minor: number) => {
    const schema = JSON.parse(readFileSync(join(directory, "schema", "v1-beta.json"), "utf8")) as Record<string, unknown> & {
      oneOf: { properties: { schema_version: Record<string, unknown>; untrusted: { properties: Record<string, unknown> } } }[];
    };
    for (const variant of schema.oneOf) {
      variant.properties.schema_version["const"] = "1.0";
      if (minor > 0) variant.properties.untrusted.properties["priority"] = { enum: ["low", "high"], type: "string", "x-tiehall-untrusted": true };
    }
    return `${JSON.stringify({ ...schema, $id: `https://tiehall.com/schemas/packet/v1.${minor}.json` }, null, 2)}\n`;
  };
  const packaged = (folder: string) => readFileSync(join(folder, "schema", "v1-beta.json"), "utf8");

  beforeAll(() => {
    mkdirSync(releases);
    writeFileSync(join(releases, "v1.0.json"), release(0));
    writeFileSync(join(releases, "v1.1.json"), release(1));
    writeFileSync(join(releases, "v1.json"), release(1));
  });

  it("the package the publish job versions as 1.1.0 carries the v1.1 release", () => {
    const folder = buildPackage({ out: join(scratch, "v1.1"), version: "1.1.0", releases });
    expect(packaged(folder)).toBe(release(1));
    expect((JSON.parse(packaged(folder)) as { $id: string }).$id).toBe("https://tiehall.com/schemas/packet/v1.1.json");
    expect(readdirSync(join(folder, "schema"))).toEqual(["v1-beta.json"]);
  });

  it("carries the release its version names, an earlier one or a patch of one too", () => {
    expect(packaged(buildPackage({ out: join(scratch, "v1.0"), version: "1.0.0", releases }))).toBe(release(0));
    expect(packaged(buildPackage({ out: join(scratch, "v1.0.1"), version: "1.0.1", releases }))).toBe(release(0));
  });

  it("refuses a version that names no published release", () => {
    for (const version of ["1.2.0", "2.0.0", "0.9.0"]) {
      expect(() => buildPackage({ out: join(scratch, "unreleased"), version, releases }), version).toThrow(
        `The packet schema is published, so the package's version names one of its releases: 1.<minor>.<patch> carries release v1.<minor>, and the releases are v1.0 and v1.1; ${version} names none.`,
      );
    }
  });

  it("carries the working schema while the tree holds no release, before publication", () => {
    const empty = join(scratch, "no-releases");
    mkdirSync(empty);
    expect(packaged(buildPackage({ out: join(scratch, "beta"), version: "1.0.0", releases: empty }))).toBe(readFileSync(join(directory, "schema", "v1-beta.json"), "utf8"));
    expect(packaged(out)).toBe(readFileSync(join(directory, "schema", "v1-beta.json"), "utf8"));
  });
});

describe("the packet's types", () => {
  it("are what the committed schema generates: pnpm packet:generate writes them", async () => {
    expect(readFileSync(join(directory, TYPES_FILE), "utf8")).toBe(await generatedTypes(readFileSync(join(directory, "schema/v1-beta.json"), "utf8")));
  });

  it("name a packet of either kind", () => {
    const types = readFileSync(join(directory, TYPES_FILE), "utf8");
    expect(types).toContain('export type Packet = components["schemas"]["Packet"];');
    expect(types).toContain('export type RequestPacket = Extract<Packet, { kind: "request" }>;');
    expect(types).toContain('export type ContractChangePacket = Extract<Packet, { kind: "contract_change" }>;');
  });
});
