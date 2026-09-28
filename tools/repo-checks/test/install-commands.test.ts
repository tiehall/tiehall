import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installCommands, installCommandsWithoutImage, operatorTexts } from "../src/install-commands.ts";

// The install command in the text operators read (D42; self-host-install:
// `init` prints a complete `.env`; self-host-install: One `.env` holds the
// install settings). The install command in the release notes carries
// `--image` with the release's reference pinned by version and digest, and
// deploy/.env.example, the header of deploy/compose.yaml, the install docs and
// the release notes show the same command, so no operator copies one that
// leaves the digest out.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const digest = `sha256:${"0".repeat(64)}`;

describe("the install commands in a text", () => {
  it("finds an install command without --image, in a comment, in Markdown and across continuation lines", () => {
    const text = [
      "# Print a .env:",
      "#   docker run --rm <image> init --url https://tiehall.example.com > .env",
      "",
      "Run `docker run --rm ghcr.io/acme/tiehall:1.3.0 init --url https://tiehall.example.com > .env` once.",
      "",
      "```sh",
      `docker run --rm ghcr.io/acme/tiehall:1.3.0@${digest} \\`,
      "  init --url https://tiehall.example.com \\",
      "  > .env",
      "```",
    ].join("\n");
    expect(installCommandsWithoutImage("install.md", text)).toEqual([
      { file: "install.md", line: 2, command: "docker run --rm <image> init --url https://tiehall.example.com > .env" },
      {
        file: "install.md",
        line: 4,
        command: "Run `docker run --rm ghcr.io/acme/tiehall:1.3.0 init --url https://tiehall.example.com > .env` once.",
      },
      {
        file: "install.md",
        line: 7,
        command: `docker run --rm ghcr.io/acme/tiehall:1.3.0@${digest} init --url https://tiehall.example.com > .env`,
      },
    ]);
  });

  it("accepts an install command with --image, on one line or across continuation lines", () => {
    const text = [
      "#   docker run --rm <image> init --url https://tiehall.example.com --image <image> > .env",
      `docker run --rm ghcr.io/acme/tiehall:1.3.0@${digest} init \\`,
      "  --url https://tiehall.example.com \\",
      `  --image ghcr.io/acme/tiehall:1.3.0@${digest} > .env`,
    ].join("\n");
    expect(installCommands(text)).toHaveLength(2);
    expect(installCommandsWithoutImage("install.md", text)).toEqual([]);
  });

  it("ignores text that shows no install command", () => {
    const text = [
      "# init prints a complete .env with fresh secrets; --url names the install.",
      "docker compose up -d",
      "TIEHALL_URL=https://tiehall.example.com",
    ].join("\n");
    expect(installCommands(text)).toEqual([]);
  });
});

describe("the install command operators read", () => {
  it("carries --image in deploy/.env.example, the header of deploy/compose.yaml and the tracked docs", () => {
    const texts = operatorTexts(root);
    const files = texts.map(({ file }) => file);
    expect(files).toContain("deploy/.env.example");
    expect(files).toContain("deploy/compose.yaml");
    expect(files).not.toContainEqual(expect.stringMatching(/^openspec\//));
    for (const file of ["deploy/.env.example", "deploy/compose.yaml"]) {
      const text = texts.find((entry) => entry.file === file)?.text ?? "";
      expect(installCommands(text).length, `${file} shows the install command`).toBeGreaterThan(0);
    }
    expect(texts.flatMap(({ file, text }) => installCommandsWithoutImage(file, text))).toEqual([]);
  });
});
