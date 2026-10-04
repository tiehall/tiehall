import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The content check of @tiehall/packet (handoff-packet: The npm package;
// public-api: The license map). npm's pack dry run lists exactly what a
// publish of the built package would upload, and the check holds that list to
// what the package is: the packet's types, the validator and the fixture
// runner, compiled, with the schema, the valid and the invalid fixtures, the
// license and the spec; no fencing renderer, none of the renderer's texts, and
// no source or test of the directory. Its manifest names the package, the
// license Apache-2.0 and only the validator's dependency. Then the check packs
// the tarball, installs it in a folder of its own as a consumer would, runs
// its validator over the fixtures it carries, which must accept every valid
// one and reject every invalid one, and compiles a consumer's TypeScript
// against its types.

const DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(DIRECTORY, "package.json"));

/** The renderer's modules, which the package leaves out, each with what it is. */
const RENDERER: Readonly<Record<string, string>> = {
  render: "the fencing renderer",
  notices: "the renderer's notice templates",
  proposals: "the renderer's proposal texts",
  "tool-text": "the renderer's tool texts",
};

/** The renderer's module names. */
export const RENDERER_MODULES: readonly string[] = Object.keys(RENDERER);

/** The files the package holds besides its fixtures. */
export const REQUIRED_FILES: readonly string[] = [
  "package.json",
  "LICENSE",
  "README.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/validator.js",
  "dist/validator.d.ts",
  "dist/conformance.js",
  "dist/conformance.d.ts",
  "dist/types.d.ts",
  "schema/v1-beta.json",
];

/** npm without its notices, audits or update checks, as the checks run it. */
function npm(cwd: string, args: string[]): string {
  const run = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", npm_config_loglevel: "error" },
  });
  if (run.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${run.stdout}${run.stderr}`);
  return run.stdout;
}

/** The files a publish of the built package in this folder would upload, as npm's pack dry run lists them. */
export function packedFiles(folder: string): string[] {
  const [packed] = JSON.parse(npm(folder, ["pack", "--dry-run", "--json", "--ignore-scripts"])) as { files: { path: string }[] }[];
  return (packed?.files ?? []).map(({ path }) => path).sort();
}

/** Every rule the package in this folder, with these packed files, breaks, as a sentence. */
export function packageContentProblems(folder: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as Record<string, unknown>;
  if (manifest["name"] !== "@tiehall/packet") problems.push(`package.json: names the package ${String(manifest["name"])}; it is @tiehall/packet.`);
  if (manifest["license"] !== "Apache-2.0") problems.push(`package.json: states the license ${String(manifest["license"])}; @tiehall/packet is licensed under Apache-2.0.`);
  if (manifest["private"] !== undefined) problems.push("package.json: is marked private, which npm does not publish.");
  const dependencies = Object.keys((manifest["dependencies"] ?? {}) as Record<string, string>);
  if (dependencies.join() !== "ajv") problems.push(`package.json: depends on ${dependencies.join(", ") || "nothing"}; the package depends only on ajv, its validator.`);
  if (JSON.stringify(manifest).includes("workspace:")) problems.push("package.json: names a workspace dependency, which npm cannot install.");
  for (const file of files) {
    const module = /^dist\/([a-z-]+)\.(?:d\.ts|js)$/.exec(file)?.[1];
    if (module !== undefined && Object.hasOwn(RENDERER, module)) problems.push(`${file}: is ${RENDERER[module] ?? ""}, which @tiehall/packet leaves out.`);
    else if (file.startsWith("src/") || file.startsWith("test/") || (file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
      problems.push(`${file}: is a source or a test of the directory, which the package carries only compiled.`);
    }
  }
  for (const file of REQUIRED_FILES) if (!files.includes(file)) problems.push(`${file}: is missing.`);
  for (const expected of ["valid", "invalid"]) {
    if (!files.some((file) => file.startsWith(`fixtures/${expected}/`) && file.endsWith(".json"))) {
      problems.push(`fixtures/${expected}: holds no fixture; the package carries the ${expected} fixtures too.`);
    }
  }
  if (files.includes("LICENSE") && !/Apache License\s+Version 2\.0/.test(readFileSync(join(folder, "LICENSE"), "utf8"))) {
    problems.push("LICENSE: is not the text of the Apache License, Version 2.0.");
  }
  return problems;
}

/** Packs the built package in this folder into the destination folder; returns the tarball's path. */
export function packTarball(folder: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  const [packed] = JSON.parse(npm(folder, ["pack", "--json", "--ignore-scripts", "--pack-destination", resolve(destination)])) as { filename: string }[];
  return join(resolve(destination), packed?.filename ?? "");
}

export interface TarballResult {
  /** How many valid fixtures the package carries. */
  valid: number;
  /** How many invalid fixtures it carries. */
  invalid: number;
  /** Each fixture its validator misjudges, and anything that kept the check from running; empty when it passes. */
  problems: string[];
}

/** The folder a workspace package is installed in, as this directory resolves it. */
function installed(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/**
 * Installs the tarball in the consumer folder, which it replaces, as a
 * consumer's node_modules holds it, beside the validator's dependency; runs
 * its validator over the fixtures it carries; and compiles a consumer's
 * TypeScript against its types.
 */
export function tarballConformance(tarball: string, consumer: string): TarballResult {
  rmSync(consumer, { recursive: true, force: true });
  mkdirSync(join(consumer, "node_modules", "@tiehall"), { recursive: true });
  mkdirSync(join(consumer, "unpacked"));
  const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", join(consumer, "unpacked")], { encoding: "utf8" });
  if (unpacked.status !== 0 || !existsSync(join(consumer, "unpacked", "package"))) return { valid: 0, invalid: 0, problems: [`The tarball does not unpack: ${unpacked.stderr}`] };
  renameSync(join(consumer, "unpacked", "package"), join(consumer, "node_modules", "@tiehall", "packet"));
  symlinkSync(installed("ajv"), join(consumer, "node_modules", "ajv"), "dir");
  mkdirSync(join(consumer, "node_modules", "@types"));
  symlinkSync(installed("@types/node"), join(consumer, "node_modules", "@types", "node"), "dir");

  writeFileSync(
    join(consumer, "conformance.mjs"),
    [
      'import { conformanceProblems, loadFixtures, packetValidator, runConformance } from "@tiehall/packet";',
      "const fixtures = loadFixtures();",
      "const problems = conformanceProblems(runConformance(packetValidator(), fixtures));",
      'const count = (expected) => fixtures.filter((fixture) => fixture.expected === expected).length;',
      'console.log(JSON.stringify({ valid: count("valid"), invalid: count("invalid"), problems }));',
      "",
    ].join("\n"),
  );
  const ran = spawnSync(process.execPath, ["conformance.mjs"], { cwd: consumer, encoding: "utf8" });
  if (ran.status !== 0) return { valid: 0, invalid: 0, problems: [`The package's validator does not run for a consumer:\n${ran.stderr}`] };
  const result = JSON.parse(ran.stdout) as TarballResult;

  writeFileSync(
    join(consumer, "consumer.ts"),
    [
      'import { packetValidator, type ContractChangePacket, type Packet, type RequestPacket } from "@tiehall/packet";',
      'const request: RequestPacket = { schema_version: JSON.parse("{}").version, kind: "request", untrusted: { need: "Expose the invoice total." } };',
      "const packets: Packet[] = [request];",
      "const contract: ContractChangePacket | undefined = undefined;",
      "export const valid: boolean[] = [...packets, ...(contract === undefined ? [] : [contract])].map(packetValidator());",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: ["node"] }, files: ["consumer.ts"] }, null, 2)}\n`,
  );
  const compiled = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
  if (compiled.status !== 0) result.problems.push(`A consumer's TypeScript does not compile against the package's types:\n${compiled.stdout}${compiled.stderr}`);
  return result;
}
