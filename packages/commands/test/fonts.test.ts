import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FONT_FILES } from "../src/assets.ts";

// The fonts the install serves (web-ui: Fonts served by the install; design.md,
// Design: Type and the self-hosted fonts; D57 (3), (14)). The repository keeps
// IBM's own files of Plex, unmodified, from the npm packages @ibm/plex-sans
// 1.1.0 and @ibm/plex-mono 2.5.0, without installing them: both packages run
// IBM's telemetry tool when they are installed. SOURCES.json names each
// package, its version and its tarball's integrity as the registry gives it,
// and each file with its path in the package and its SHA-256; the folder holds
// exactly those files: Plex Sans Regular, Medium, SemiBold and Bold in IBM's
// six subsets, Plex Mono Regular and Medium in its five (IBM ships no Greek
// subset of Plex Mono), and the SIL Open Font License as IBM's license.txt.

const FONTS = fileURLToPath(new URL("../assets/fonts/", import.meta.url));

interface Sources {
  packages: { name: string; version: string; integrity: string; files: { path: string; from: string; sha256: string }[] }[];
}

const sources = JSON.parse(readFileSync(`${FONTS}SOURCES.json`, "utf8")) as Sources;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(`${FONTS}${file}`)).digest("hex");

/** IBM's license.txt, byte for byte the same file in both packages' fonts/split/woff2/ folders. */
const OFL_SHA256 = "91c25c350d3cac39da2736d74f7ba37ef648f5237a4e330a240615bc8d8c4360";

describe("IBM Plex in the repository", () => {
  it("comes from @ibm/plex-sans 1.1.0 and @ibm/plex-mono 2.5.0, each with its tarball's integrity", () => {
    expect(sources.packages.map(({ name, version }) => `${name}@${version}`)).toEqual(["@ibm/plex-sans@1.1.0", "@ibm/plex-mono@2.5.0"]);
    for (const { integrity } of sources.packages) expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it("holds exactly the files SOURCES.json lists, each with its SHA-256", () => {
    const listed = sources.packages.flatMap(({ files }) => files.map(({ path }) => path));
    const held = readdirSync(FONTS).filter((file) => file !== "SOURCES.json");
    expect(held.sort()).toEqual([...new Set(listed)].sort());
    for (const { files } of sources.packages) for (const { path, sha256: digest } of files) expect(sha256(path), path).toBe(digest);
  });

  it("is Plex Sans in four weights and six subsets and Plex Mono in two weights and five subsets, from IBM's split WOFF2 folders", () => {
    const sans = ["Regular", "Medium", "SemiBold", "Bold"].flatMap((weight) =>
      ["Cyrillic", "Greek", "Latin1", "Latin2", "Latin3", "Pi"].map((subset) => `IBMPlexSans-${weight}-${subset}.woff2`),
    );
    const mono = ["Regular", "Medium"].flatMap((weight) => ["Cyrillic", "Latin1", "Latin2", "Latin3", "Pi"].map((subset) => `IBMPlexMono-${weight}-${subset}.woff2`));
    const [plexSans, plexMono] = sources.packages;
    expect(plexSans?.files.filter(({ path }) => path.endsWith(".woff2")).map(({ path }) => path).sort()).toEqual(sans.sort());
    expect(plexMono?.files.filter(({ path }) => path.endsWith(".woff2")).map(({ path }) => path).sort()).toEqual(mono.sort());
    for (const { files } of sources.packages) {
      for (const { path, from } of files) expect(from).toBe(path === "OFL.txt" ? "fonts/split/woff2/license.txt" : `fonts/split/woff2/${path}`);
    }
    expect([...FONT_FILES].sort()).toEqual([...sans, ...mono].sort());
    expect(FONT_FILES).toHaveLength(34);
  });

  it("carries IBM's license.txt as OFL.txt, the same file in both packages", () => {
    expect(sha256("OFL.txt")).toBe(OFL_SHA256);
    for (const { files } of sources.packages) expect(files.find(({ path }) => path === "OFL.txt")?.sha256).toBe(OFL_SHA256);
    const text = readFileSync(`${FONTS}OFL.txt`, "utf8");
    expect(text).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
