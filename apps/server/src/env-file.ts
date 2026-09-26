import { randomBytes } from "node:crypto";
import { installUrl, SETTINGS, type SettingDefinition } from "@tiehall/commands";

// The `.env` file (self-host-install: One `.env` holds the install settings;
// self-host-install: `init` prints a complete `.env`). `init` prints one with
// every setting and fresh random secrets, and deploy/.env.example, which each
// release publishes, is written from the same list, so the two never name
// different settings. Values never need quoting: URLs, host names and
// base64url secrets hold no spaces, quotes or `#`.

/** The build of the image that runs `init`, which names its own image when `--image` is not given. */
export interface ImageBuild {
  /** The image's repository, such as ghcr.io/acme/tiehall. */
  name: string;
  /** Its release, such as 1.4.0, or 0.0.0-dev for a development build. */
  version: string;
  /** The commit it was built from, which tags a build of main. */
  commit?: string;
}

export interface InitOptions {
  /** TIEHALL_URL, which init checks as the install does. */
  url: string;
  /** The image to pin, such as ghcr.io/acme/tiehall:1.4.0@sha256:<digest>. */
  image?: string;
  build?: ImageBuild;
}

/** A development build of the image, which names itself as the local image `tiehall`. */
const DEVELOPMENT_BUILD: ImageBuild = { name: "tiehall", version: "0.0.0-dev" };

/** A fresh secret: 32 random bytes, in base64url, which fits in a URL and needs no quoting. */
export function freshSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The `.env` that `init` prints: every setting, with fresh secrets. It throws SettingsError for a URL the install would refuse. */
export function initEnv(options: InitOptions): string {
  const url = installUrl(options.url);
  const image = options.image ?? imageOf(options.build ?? DEVELOPMENT_BUILD);
  const values = (setting: SettingDefinition) => {
    switch (setting.init) {
      case "url":
        return url;
      case "image":
        return image;
      case "secret":
        return freshSecret();
      case "fixed":
        return setting.value ?? "";
    }
  };
  return render(
    [
      `Tiehall's install settings for ${url}, printed by init.`,
      "Keep this file secret: it holds the database passwords and the keys. Back it up apart from the database:",
      "a database backup alone cannot read the stored integration secrets without TIEHALL_SECRET_KEY.",
      ...FILE_FORMS,
    ],
    values,
  );
}

/** deploy/.env.example: every setting, with the secrets left empty for `init` to fill. */
export function exampleEnv(): string {
  return render(
    [
      "Tiehall's install settings. Print a complete .env with fresh secrets instead of copying this file:",
      "  docker run --rm <image> init --url https://tiehall.example.com --image <image> > .env",
      "Keep .env secret, and back it up apart from the database.",
      ...FILE_FORMS,
    ],
    (setting) => {
      switch (setting.init) {
        case "url":
          return "https://tiehall.example.com";
        case "image":
          return `ghcr.io/<owner>/tiehall:<version>@sha256:<digest>`;
        case "secret":
          return "";
        case "fixed":
          return setting.value ?? "";
      }
    },
  );
}

const FILE_FORMS = [
  "A secret can instead come from a file, as its NAME_FILE form, such as TIEHALL_SECRET_KEY_FILE; the path is",
  "inside the container, so mount the file there, for example with a compose.override.yaml.",
];

/** The image a build names: its release tag, or, for a build of main, the tag of its commit. */
function imageOf(build: ImageBuild): string {
  const development = build.version.endsWith("-dev");
  const tag = development && build.commit !== undefined ? `sha-${build.commit}` : build.version;
  return `${build.name}:${tag}`;
}

function render(header: readonly string[], valueOf: (setting: SettingDefinition) => string): string {
  const lines = header.map((line) => `# ${line}`);
  for (const setting of SETTINGS) {
    // A setting without a description continues the one before it, under the same comment.
    if (setting.description !== "" || setting.group !== undefined) lines.push("");
    if (setting.group !== undefined) lines.push(...comment(setting.group), "#");
    lines.push(...comment(setting.description), `${setting.name}=${valueOf(setting)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A description as comment lines of at most 100 characters. */
function comment(text: string): string[] {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ").filter((part) => part !== "")) {
    if (line.length + 1 + word.length > 100 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  if (line !== "#") lines.push(line);
  return lines;
}

/**
 * Parses a `.env` file as Compose reads the files `init` prints: one
 * NAME=value per line, with comment lines and blank lines between them.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) throw new Error(`Not a NAME=value line: ${line.slice(0, 40)}`);
    values[match[1] as string] = match[2] as string;
  }
  return values;
}
