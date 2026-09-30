import { readFileSync } from "node:fs";
import { join } from "node:path";

// The commands of the install docs (self-host-install: Backups with the
// shipped scripts; self-host-install: Upgrades apply migrations before the app
// starts; self-host-install: No telemetry and a documented list of outbound
// connections). docs/install.md shows the commands an operator runs as fenced
// `sh` blocks, each named in its info string, such as ```sh
// docs-test=install-up. The operator tests in tools/image-tests run each block
// by its name, in the fresh-install, backup and upgrade CI jobs, with the
// example values of the docs, such as https://tiehall.example.com and <image>,
// replaced by the test's own; the docs check in tools/repo-checks makes sure
// every block has a name and that one of those tests runs it.

/** The install docs, relative to the repository's root. */
export const INSTALL_DOCS = "docs/install.md";

export interface DocsCommand {
  /** The block's name, from its info string. */
  id: string;
  /** The block's text, without the indentation of a list item. */
  text: string;
  /** The line of its opening fence, from 1. */
  line: number;
}

/** A fenced block of a Markdown text: its info string, its text and where it opens. */
export interface FencedBlock {
  info: string;
  text: string;
  line: number;
}

/** Every fenced block of a Markdown text, in order; a list item's block loses the item's indentation. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.split("\n");
  const blocks: FencedBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^(\s*)```(.*)$/.exec(lines[index] ?? "");
    if (open === null) continue;
    const indent = open[1] ?? "";
    const body: string[] = [];
    let end = index + 1;
    while (end < lines.length && !/^\s*```\s*$/.test(lines[end] ?? "")) {
      const line = lines[end] ?? "";
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line.trimStart());
      end += 1;
    }
    blocks.push({ info: (open[2] ?? "").trim(), text: body.join("\n"), line: index + 1 });
    index = end;
  }
  return blocks;
}

/** The name an `sh` block's info string gives it, such as install-up for "sh docs-test=install-up"; undefined for none. */
export function docsTestName(info: string): string | undefined {
  const [language, ...attributes] = info.split(/\s+/);
  if (language !== "sh") return undefined;
  return attributes.map((attribute) => /^docs-test=([a-z0-9-]+)$/.exec(attribute)?.[1]).find((name) => name !== undefined);
}

/** The named `sh` blocks of a Markdown text, in order. */
export function docsCommands(markdown: string): DocsCommand[] {
  return fencedBlocks(markdown).flatMap(({ info, text, line }) => {
    const id = docsTestName(info);
    return id === undefined ? [] : [{ id, text, line }];
  });
}

/** The install docs' named commands, by name, read from the repository at this root. */
export function installDocsCommands(root: string): Map<string, DocsCommand> {
  const commands = docsCommands(readFileSync(join(root, INSTALL_DOCS), "utf8"));
  return new Map(commands.map((command) => [command.id, command]));
}

/** A placeholder the docs leave for the operator to fill in, such as <image> or <github-login>. */
const PLACEHOLDER = /<[a-z][a-z-]*>/;

/**
 * The text of the install docs' command with this name, with each example
 * value replaced by the test's own, as an operator fills them in; it throws
 * for a name the docs do not hold, and for a placeholder left unfilled.
 */
export function documentedCommand(root: string, id: string, values: Readonly<Record<string, string>> = {}): string {
  const command = installDocsCommands(root).get(id);
  if (command === undefined) throw new Error(`${INSTALL_DOCS} holds no command named ${id}`);
  let text = command.text;
  for (const [example, value] of Object.entries(values)) text = text.split(example).join(value);
  const left = PLACEHOLDER.exec(text)?.[0];
  if (left !== undefined) throw new Error(`the command ${id} of ${INSTALL_DOCS} still holds the placeholder ${left}`);
  return text;
}
