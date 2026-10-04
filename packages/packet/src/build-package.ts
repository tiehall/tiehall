import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Builds @tiehall/packet from this directory (handoff-packet: The npm
// package; handoff-packet: The Apache-2.0 schema directory; design.md,
// Technical decisions: T13), into a folder of its own that npm publishes as
// it is: the packet's types, the validator and the fixture runner, compiled
// from src/index.ts and what it imports to JavaScript with their declarations
// (tsconfig.package.json), so the package runs on Node.js without TypeScript;
// the schema the validator reads; the conformance fixtures; the license and
// the spec; and a manifest with the version given, the license Apache-2.0,
// the validator's one dependency at the version this directory pins, and the
// repository and folder it is built from, which npm's provenance checks. The
// fencing renderer and the notice and proposal texts stay out: the entry
// imports none of them, and nothing else is copied.
// Usage: node packages/packet/src/build-package.ts --version <semver> --out <folder>

/** This directory, packages/packet. */
export const DIRECTORY = fileURLToPath(new URL("../", import.meta.url));

/** The repository the package is built from, as its manifest names it for npm's provenance. */
export const REPOSITORY = { type: "git", url: "git+https://github.com/muhmmdcnkl/Tiehall.git", directory: "packages/packet" } as const;

/** A semantic version without build metadata, which npm takes. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** A build that cannot be made; its message says why. */
export class PackageBuildError extends Error {
  override name = "PackageBuildError";
}

export interface BuildOptions {
  /** The folder the package is built into; whatever it held is replaced. */
  out: string;
  /** The package's version, such as 1.0.0. */
  version: string;
}

/** The manifest of the built package. */
function manifest(version: string): Record<string, unknown> {
  const own = JSON.parse(readFileSync(join(DIRECTORY, "package.json"), "utf8")) as { dependencies: Record<string, string>; engines: Record<string, string> };
  return {
    name: "@tiehall/packet",
    version,
    description:
      "The handoff packet tiehall.packet/v1: its JSON Schema, TypeScript types, a validator and the conformance fixtures of valid and invalid packets.",
    license: "Apache-2.0",
    type: "module",
    keywords: ["tiehall", "packet", "json-schema", "handoff"],
    homepage: "https://github.com/muhmmdcnkl/Tiehall/tree/main/packages/packet#readme",
    repository: REPOSITORY,
    engines: { node: ">=22" },
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./schema/*": "./schema/*",
      "./fixtures/*": "./fixtures/*",
      "./package.json": "./package.json",
    },
    types: "./dist/index.d.ts",
    files: ["dist", "schema", "fixtures"],
    sideEffects: false,
    dependencies: { ajv: own.dependencies["ajv"] },
  };
}

/** Builds the package into the folder; returns the folder. */
export function buildPackage({ out, version }: BuildOptions): string {
  if (!VERSION.test(version)) throw new PackageBuildError(`The package's version must be a semantic version, such as 1.0.0; ${JSON.stringify(version)} is not.`);
  const folder = resolve(out);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const compiled = spawnSync(process.execPath, [tsc, "-p", join(DIRECTORY, "tsconfig.package.json"), "--outDir", join(folder, "dist")], { encoding: "utf8" });
  if (compiled.status !== 0) throw new PackageBuildError(`TypeScript could not compile the package:\n${compiled.stdout}${compiled.stderr}`);
  // The declarations name the modules they import by their compiled files, as the JavaScript does, for any consumer's TypeScript.
  for (const name of readdirSync(join(folder, "dist")).filter((file) => file.endsWith(".d.ts"))) {
    const file = join(folder, "dist", name);
    writeFileSync(file, readFileSync(file, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
  for (const path of ["schema", "fixtures"]) cpSync(join(DIRECTORY, path), join(folder, path), { recursive: true });
  for (const file of ["LICENSE", "README.md"]) cpSync(join(DIRECTORY, file), join(folder, file));
  writeFileSync(join(folder, "package.json"), `${JSON.stringify(manifest(version), null, 2)}\n`);
  return folder;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, out: { type: "string" } } });
  if (values.version === undefined || values.out === undefined) {
    console.error("Usage: node packages/packet/src/build-package.ts --version <semver> --out <folder>");
    process.exit(2);
  }
  try {
    const folder = buildPackage({ out: values.out, version: values.version });
    console.log(`Built @tiehall/packet ${values.version} in ${folder}.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
