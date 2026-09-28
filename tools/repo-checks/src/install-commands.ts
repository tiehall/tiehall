import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The install command in the text operators read (D42; self-host-install:
// `init` prints a complete `.env`). The install command in the release notes
// is `docker run --rm <reference> init --url <url> --image <reference> > .env`,
// with the release's reference pinned by version and digest, so the printed
// `.env` pins the digest; deploy/.env.example, the header of
// deploy/compose.yaml and the install docs show the same command. An install
// command is one that runs `init --url`; each must carry `--image`.

export interface InstallCommand {
  /** The line the command starts on, from 1. */
  line: number;
  /** The command, with its continuation lines joined, comment marks dropped and white space collapsed. */
  command: string;
}

export interface InstallCommandProblem extends InstallCommand {
  file: string;
}

/** The commands in a text: each line, joined with the lines that continue it after a trailing "\", without a leading "#". */
function commands(text: string): InstallCommand[] {
  const lines = text.split("\n").map((line) => line.replace(/^\s*#+/, "").trim());
  const found: InstallCommand[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    let command = lines[index] ?? "";
    while (command.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      command = `${command.slice(0, -1)} ${lines[index] ?? ""}`;
    }
    found.push({ line: start + 1, command: command.replace(/\s+/g, " ").trim() });
  }
  return found;
}

/** The install commands in a text: those that run `init --url`. */
export function installCommands(text: string): InstallCommand[] {
  return commands(text).filter(({ command }) => /\binit --url\b/.test(command));
}

/** The install commands in a text that carry no `--image`. */
export function installCommandsWithoutImage(file: string, text: string): InstallCommandProblem[] {
  return installCommands(text)
    .filter(({ command }) => !/(?:^|\s)--image(?:\s|=)/.test(command))
    .map((found) => ({ file, ...found }));
}

/**
 * The texts that show operators the install command: deploy/.env.example; the
 * header of deploy/compose.yaml, its comment lines before the first setting;
 * and every tracked Markdown file outside openspec/, .claude/ and test
 * fixtures, which holds the install docs and the release notes' template once
 * they exist.
 */
export function operatorTexts(root: string): { file: string; text: string }[] {
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const composeLines = read("deploy/compose.yaml").split("\n");
  const headerEnd = composeLines.findIndex((line) => line.trim() !== "" && !line.startsWith("#"));
  const markdown = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(
      (file) => file !== "" && !file.startsWith("openspec/") && !file.startsWith(".claude/") && !file.includes("/test/fixtures/"),
    );
  return [
    { file: "deploy/.env.example", text: read("deploy/.env.example") },
    { file: "deploy/compose.yaml", text: composeLines.slice(0, headerEnd === -1 ? undefined : headerEnd).join("\n") },
    ...markdown.map((file) => ({ file, text: read(file) })),
  ];
}
