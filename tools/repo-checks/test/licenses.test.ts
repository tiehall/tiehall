import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkLicenseFiles, checkLicenses, licenseTextDigest, loadLicenseMap, workspacePackages } from "../src/licenses.ts";

// The license-map check (tasks 3.3 and 28.1; public-api: The license map;
// design.md, Self-hosting decisions: S16). It runs the same script as the CI
// job against fixture workspaces and the real tree. The package metadata's
// fixtures are committed, with no license files, so the script also reports
// those missing there; checkLicenses() reads the metadata alone. The license
// files' fixtures are copies of the real tree's workspace, its package.json
// files and its license files, with one license file taken out or changed, so
// that no fixture keeps a second copy of the license texts in the repository.
// Third-party files kept in a folder of the repository, such as IBM's Plex
// fonts under the SIL Open Font License (web-ui: Fonts served by the install;
// design.md, Design: Type and the self-hosted fonts; D57 (3)), are licensed by
// their own license file, which the map names with its text.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-licenses.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/licenses/${name}/`, import.meta.url));

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

const copies: string[] = [];

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

/** The files of the real tree the check reads: the workspace, every workspace package's package.json, and the license files. */
function licenseTree(): string[] {
  const folders = workspacePackages(repoRoot);
  const map = loadLicenseMap();
  return [
    "pnpm-workspace.yaml",
    "LICENSE",
    ...folders.map((folder) => (folder === "." ? "package.json" : `${folder}/package.json`)),
    ...Object.keys(map.clientPieces).map((folder) => `${folder}/LICENSE`),
    ...Object.entries(map.thirdParty).map(([folder, { licenseFile }]) => `${folder}/${licenseFile}`),
  ];
}

/** A copy of the real tree's license files and package metadata, changed by edit. */
function copyOfTree(edit: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "tiehall-licenses-"));
  copies.push(root);
  for (const file of licenseTree()) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(repoRoot, file)));
  }
  edit(root);
  return root;
}

const AGPL = readFileSync(join(repoRoot, "LICENSE"), "utf8");
const APACHE = readFileSync(join(repoRoot, "packages/cli/LICENSE"), "utf8");
const OFL = readFileSync(join(repoRoot, "packages/commands/assets/fonts/OFL.txt"), "utf8");
/** The digest of IBM's license.txt for Plex: the SIL Open Font License 1.1 with IBM's copyright notice. */
const OFL_DIGEST = "1dac2b307cd87215176a16010d1a5d9c3f094d89eace8894f3bcc8d7e8a9194d";

describe("the license-map check", () => {
  it("fails when a client piece says AGPL-3.0", () => {
    const run = check(fixture("client-says-agpl"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'packages/cli/package.json: license is "AGPL-3.0-only", but the license map makes packages/cli (tiehall) Apache-2.0.',
    );
    expect(checkLicenses(fixture("client-says-agpl"), loadLicenseMap())).toEqual([
      {
        file: "packages/cli/package.json",
        detail: 'license is "AGPL-3.0-only", but the license map makes packages/cli (tiehall) Apache-2.0.',
      },
    ]);
  });

  it("fails when a server package says Apache-2.0", () => {
    const run = check(fixture("server-says-apache"));
    expect(run.status).toBe(1);
    expect(checkLicenses(fixture("server-says-apache"), loadLicenseMap())).toEqual([
      {
        file: "packages/catalog/package.json",
        detail:
          'license is "Apache-2.0", but the license map makes every package other than the five client pieces AGPL-3.0-only.',
      },
    ]);
    expect(run.stderr).toContain("packages/catalog/package.json: license is \"Apache-2.0\"");
  });

  it("fails when a client piece the map names is not a workspace package", () => {
    const run = check(fixture("missing-packet-package"));
    expect(run.status).toBe(1);
    expect(checkLicenses(fixture("missing-packet-package"), loadLicenseMap())).toEqual([
      {
        file: "packages/packet/package.json",
        detail: "the license map names packages/packet (@tiehall/packet) as Apache-2.0, but it is not a workspace package.",
      },
    ]);
  });

  it("passes on the real tree, where the root and every workspace package carry the license the map gives them", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Apache-2\.0 in the 5 client pieces of the license map, and AGPL-3\.0-only in the root and the \d+ other workspace packages\.$/m);
    expect(run.stdout).toMatch(/^The AGPL-3\.0-only text in the root's LICENSE file, and the Apache-2\.0 text in the LICENSE file of each of the 5 client pieces\.$/m);
    expect(run.stdout).toMatch(/^The license file of each of the 1 third-party folders: packages\/commands\/assets\/fonts\/OFL\.txt with the OFL-1\.1 text\.$/m);
    expect(checkLicenses(repoRoot, loadLicenseMap())).toEqual([]);
    expect(checkLicenseFiles(repoRoot, loadLicenseMap())).toEqual([]);
  });

  it("names exactly the five Apache-2.0 client pieces of design.md S16, with the packet schema package among them", () => {
    expect(loadLicenseMap()).toEqual({
      serverLicense: "AGPL-3.0-only",
      clientLicense: "Apache-2.0",
      licenseTexts: {
        "AGPL-3.0-only": "2cd0fb7883a3b3553dedbb0bad171646d46f51e2642951aae7c59cb5cec86c46",
        "Apache-2.0": "0ffddef9e48f8a09aed5caf2d44f7ba1c1be2d9b8e0a6f693b1635b2d5566645",
        "OFL-1.1": OFL_DIGEST,
      },
      clientPieces: {
        "packages/cli": "tiehall",
        "packages/client": "@tiehall/client",
        "packages/claude-plugin": "@tiehall/claude-plugin",
        "actions/contract": "@tiehall/contract-action",
        "packages/packet": "@tiehall/packet",
      },
      thirdParty: {
        "packages/commands/assets/fonts": { license: "OFL-1.1", licenseFile: "OFL.txt" },
      },
    });
  });

  it("is the list the dependency rule for Apache-2.0 pieces reads", () => {
    const require = createRequire(import.meta.url);
    const config = require("../../../.dependency-cruiser.cjs") as {
      forbidden: { name: string; from: { path: string[] } }[];
    };
    const rule = config.forbidden.find(({ name }) => name === "apache-2.0-imports-no-agpl-3.0");
    const folders = Object.keys(loadLicenseMap().clientPieces).map((folder) => `^${folder}/`);
    expect(rule?.from.path).toEqual(folders);
  });
});

describe("the license files", () => {
  it("are the AGPL-3.0 text at the root and the Apache-2.0 text in each client piece, as the map's digests name them", () => {
    const map = loadLicenseMap();
    expect(Object.keys(map.licenseTexts).sort()).toEqual(["AGPL-3.0-only", "Apache-2.0", "OFL-1.1"]);
    expect(AGPL).toMatch(/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007\n/);
    expect(APACHE).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004\s+http:\/\/www\.apache\.org\/licenses\/\n/);
    for (const folder of Object.keys(map.clientPieces)) expect(readFileSync(join(repoRoot, folder, "LICENSE"), "utf8"), folder).toBe(APACHE);
  });

  it("fail the check when a client piece's directory has no LICENSE file", () => {
    const root = copyOfTree((tree) => unlinkSync(join(tree, "packages/cli/LICENSE")));
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "packages/cli/LICENSE: is missing, but the license map makes packages/cli (tiehall) Apache-2.0, which needs its own LICENSE file with the Apache-2.0 text.",
    );
    expect(checkLicenseFiles(root, loadLicenseMap())).toEqual([
      {
        file: "packages/cli/LICENSE",
        detail: "is missing, but the license map makes packages/cli (tiehall) Apache-2.0, which needs its own LICENSE file with the Apache-2.0 text.",
      },
    ]);
    expect(checkLicenses(root, loadLicenseMap())).toEqual([]);
  });

  it("fail the check when the root has no LICENSE file", () => {
    const root = copyOfTree((tree) => unlinkSync(join(tree, "LICENSE")));
    expect(check(root).status).toBe(1);
    expect(checkLicenseFiles(root, loadLicenseMap())).toEqual([
      { file: "LICENSE", detail: "is missing, but the repository's root license is AGPL-3.0-only, which needs the AGPL-3.0-only text in the root's LICENSE file." },
    ]);
  });

  it("fail the check when a client piece holds the AGPL-3.0 text, or the root the Apache-2.0 text", () => {
    const root = copyOfTree((tree) => {
      writeFileSync(join(tree, "packages/packet/LICENSE"), AGPL);
      writeFileSync(join(tree, "LICENSE"), APACHE);
    });
    expect(check(root).status).toBe(1);
    expect(checkLicenseFiles(root, loadLicenseMap())).toEqual([
      { file: "LICENSE", detail: "holds the Apache-2.0 text, but the repository's root license is AGPL-3.0-only, which needs the AGPL-3.0-only text in the root's LICENSE file." },
      {
        file: "packages/packet/LICENSE",
        detail: "holds the AGPL-3.0-only text, but the license map makes packages/packet (@tiehall/packet) Apache-2.0, which needs its own LICENSE file with the Apache-2.0 text.",
      },
    ]);
  });

  it("fail the check when a license text was changed, and accept one whose lines were only wrapped or ended otherwise", () => {
    const changed = copyOfTree((tree) => writeFileSync(join(tree, "actions/contract/LICENSE"), APACHE.replace("2. Grant of Copyright License.", "2. Grant of Copyright.")));
    expect(checkLicenseFiles(changed, loadLicenseMap())).toEqual([
      {
        file: "actions/contract/LICENSE",
        detail:
          "holds no license text the map knows, but the license map makes actions/contract (@tiehall/contract-action) Apache-2.0, which needs its own LICENSE file with the Apache-2.0 text.",
      },
    ]);
    expect(check(changed).status).toBe(1);

    const rewrapped = copyOfTree((tree) => {
      writeFileSync(join(tree, "LICENSE"), AGPL.replace(/\n/g, "\r\n"));
      writeFileSync(join(tree, "packages/client/LICENSE"), APACHE.replace(/\n(?=\S)/g, " \n").replace(/ {2,}/g, " "));
    });
    expect(checkLicenseFiles(rewrapped, loadLicenseMap())).toEqual([]);
    expect(check(rewrapped).status).toBe(0);
  });
});

describe("the third-party folders", () => {
  it("hold their license file with the text the map names: IBM Plex's OFL.txt with the OFL-1.1 text", () => {
    const map = loadLicenseMap();
    expect(map.thirdParty["packages/commands/assets/fonts"]).toEqual({ license: "OFL-1.1", licenseFile: "OFL.txt" });
    expect(licenseTextDigest(OFL)).toBe(map.licenseTexts["OFL-1.1"]);
    expect(OFL).toMatch(/^Copyright © 2017 IBM Corp\. with Reserved Font Name "Plex"\n/);
    expect(OFL).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
  });

  it("fail the check when the fonts' OFL.txt is missing", () => {
    const root = copyOfTree((tree) => unlinkSync(join(tree, "packages/commands/assets/fonts/OFL.txt")));
    const run = check(root);
    expect(run.status).toBe(1);
    const detail =
      "is missing, but the license map makes packages/commands/assets/fonts third-party files under OFL-1.1, which needs their license file OFL.txt with the OFL-1.1 text.";
    expect(run.stderr).toContain(`packages/commands/assets/fonts/OFL.txt: ${detail}`);
    expect(checkLicenseFiles(root, loadLicenseMap())).toEqual([{ file: "packages/commands/assets/fonts/OFL.txt", detail }]);
  });

  it("fail the check when the fonts' OFL.txt holds a changed text, or another license's", () => {
    const changed = copyOfTree((tree) => writeFileSync(join(tree, "packages/commands/assets/fonts/OFL.txt"), OFL.replace("Reserved Font Name", "Font Name")));
    expect(check(changed).status).toBe(1);
    expect(checkLicenseFiles(changed, loadLicenseMap())).toEqual([
      {
        file: "packages/commands/assets/fonts/OFL.txt",
        detail:
          "holds no license text the map knows, but the license map makes packages/commands/assets/fonts third-party files under OFL-1.1, which needs their license file OFL.txt with the OFL-1.1 text.",
      },
    ]);
    const apache = copyOfTree((tree) => writeFileSync(join(tree, "packages/commands/assets/fonts/OFL.txt"), APACHE));
    expect(checkLicenseFiles(apache, loadLicenseMap())).toEqual([
      {
        file: "packages/commands/assets/fonts/OFL.txt",
        detail:
          "holds the Apache-2.0 text, but the license map makes packages/commands/assets/fonts third-party files under OFL-1.1, which needs their license file OFL.txt with the OFL-1.1 text.",
      },
    ]);
  });
});
