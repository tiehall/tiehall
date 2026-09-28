import { randomBytes } from "node:crypto";
import { installUrl, SETTINGS, SettingsError, type SettingDefinition } from "@tiehall/commands";

// The `.env` file (self-host-install: One `.env` holds the install settings;
// self-host-install: `init` prints a complete `.env`). `init` prints one with
// every setting and fresh random secrets, and deploy/.env.example, which each
// release publishes, is written from the same list, so the two never name
// different settings. Values never need quoting: URLs, host names, image
// references and base64url secrets hold no spaces, quotes or `#`.
//
// TIEHALL_IMAGE is the reference `init --image` gives, verbatim, as the
// install command in the release notes passes it, pinned by version and
// digest. A container cannot see the image it was started from, and a digest
// exists only after the build, so without --image init names its own build
// by the name and version the build baked in, with a comment that says where
// the digest comes from (D42).

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
  /** The image to pin, such as ghcr.io/acme/tiehall:1.4.0@sha256:<digest>; it must be an image reference. */
  image?: string;
  build?: ImageBuild;
}

/** A development build of the image, which names itself as the local image `tiehall`. */
const DEVELOPMENT_BUILD: ImageBuild = { name: "tiehall", version: "0.0.0-dev" };

/** A fresh secret: 32 random bytes, in base64url, which fits in a URL and needs no quoting. */
export function freshSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The `.env` that `init` prints: every setting, with fresh secrets. It throws
 * SettingsError for a URL the install would refuse, and for an image that is
 * not an image reference.
 */
export function initEnv(options: InitOptions): string {
  const url = installUrl(options.url);
  if (options.image !== undefined && !isImageReference(options.image)) {
    throw new SettingsError(
      "The value of --image is not an image reference. Give one as [registry/]repository[:tag][@digest], " +
        "such as ghcr.io/<owner>/tiehall:1.3.0@sha256:<digest>.",
    );
  }
  const image = options.image ?? imageOf(options.build ?? DEVELOPMENT_BUILD);
  const imageComment = options.image === undefined ? "build" : "given";
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
    (setting) => setting.initComment?.[imageComment] ?? setting.description,
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

// An image reference as container engines read one (D42; self-host-install:
// `init` prints a complete `.env`): [registry/]repository[:tag][@digest].
// The registry is a host name, or an IPv6 address in brackets, with an
// optional port; the repository is one or more components of lowercase
// letters and digits joined by ".", "_", "__" or one or more "-", with "/"
// between them, at most 255 characters with the registry; the tag is at most
// 128 letters, digits, "_", "." and "-", starting with a letter, a digit or
// "_"; and the digest is an algorithm the engines support, ":" and its value
// in lowercase hexadecimal, of the length the algorithm gives.
const PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const DOMAIN_COMPONENT = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const REGISTRY = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const IMAGE_REFERENCE = new RegExp(
  `^((?:${REGISTRY}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*)(?::[\\w][\\w.-]{0,127})?(?:@([a-z0-9]+):([0-9a-f]+))?$`,
);
/** The digest algorithms container engines support, with the number of hexadecimal digits of each. */
const DIGEST_LENGTHS: ReadonlyMap<string, number> = new Map([
  ["sha256", 64],
  ["sha384", 96],
  ["sha512", 128],
]);

/** Whether a value is an image reference, as `init --image` accepts it. */
export function isImageReference(value: string): boolean {
  const match = IMAGE_REFERENCE.exec(value);
  if (match === null) return false;
  const [, name = "", algorithm, hex] = match;
  if (name.length > 255) return false;
  return algorithm === undefined || DIGEST_LENGTHS.get(algorithm) === hex?.length;
}

/** The image a build names: its release tag, or, for a build of main, the tag of its commit. */
function imageOf(build: ImageBuild): string {
  const development = build.version.endsWith("-dev");
  const tag = development && build.commit !== undefined ? `sha-${build.commit}` : build.version;
  return `${build.name}:${tag}`;
}

function render(
  header: readonly string[],
  valueOf: (setting: SettingDefinition) => string,
  commentOf: (setting: SettingDefinition) => string = (setting) => setting.description,
): string {
  const lines = header.map((line) => `# ${line}`);
  for (const setting of SETTINGS) {
    // A setting without a description continues the one before it, under the same comment.
    if (setting.description !== "" || setting.group !== undefined) lines.push("");
    if (setting.group !== undefined) lines.push(...comment(setting.group), "#");
    lines.push(...comment(commentOf(setting)), `${setting.name}=${valueOf(setting)}`);
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
