import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readAppSettings, readMigrateSettings, SETTINGS } from "@tiehall/commands";
import { exampleEnv, initEnv, parseEnvFile } from "../src/env-file.ts";

// The init role (self-host-install: `init` prints a complete `.env`):
// `docker run --rm <image> init --url https://tiehall.example.com > .env`
// prints every install setting, with fresh random secrets, so the printed file
// starts an install without edits. deploy/.env.example, which each release
// publishes, names every setting too, and is written from the same list.
// TIEHALL_IMAGE is the reference `--image` gives, verbatim, as the install
// command in the release notes passes it; without `--image`, it is the image's
// own name and version tag, with a comment that says where the digest comes
// from. A value that is not an image reference is refused before anything is
// printed.

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const envExample = fileURLToPath(new URL("../../../deploy/.env.example", import.meta.url));

/** The settings whose values init generates: the passwords and the keys. */
const GENERATED = SETTINGS.filter(({ init }) => init === "secret").map(({ name }) => name);

/** The image reference the release notes of 1.3.0 would give: pinned by version and digest. */
const RELEASE_IMAGE = `ghcr.io/acme/tiehall:1.3.0@sha256:${"a".repeat(64)}`;

/** How long one run of the role as a process may take, even on a slow CI runner. */
const PROCESS_TIMEOUT = 30_000;

function runInit(...args: string[]) {
  const run = spawnSync(process.execPath, [main, "init", ...args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
    timeout: PROCESS_TIMEOUT,
  });
  if (run.error) throw run.error;
  return run;
}

/** The comment just above a setting's line in a printed `.env`, as one text without its "#" marks. */
function commentAbove(text: string, name: string): string {
  const lines = text.split("\n");
  const comment: string[] = [];
  for (let index = lines.findIndex((line) => line.startsWith(`${name}=`)) - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("#")) break;
    comment.unshift(line.replace(/^# ?/, ""));
  }
  return comment.join(" ");
}

describe("init", () => {
  it("prints fresh secrets on each run, and the URL it is given", () => {
    const first = parseEnvFile(initEnv({ url: "https://tiehall.example.com" }));
    const second = parseEnvFile(initEnv({ url: "https://tiehall.example.com" }));
    expect(first["TIEHALL_URL"]).toBe("https://tiehall.example.com");
    expect(second["TIEHALL_URL"]).toBe("https://tiehall.example.com");
    expect(GENERATED).toEqual([
      "TIEHALL_DATABASE_OWNER_PASSWORD",
      "TIEHALL_DATABASE_APP_PASSWORD",
      "TIEHALL_SECRET_KEY",
      "TIEHALL_AUTH_SECRET",
    ]);
    const secondText = Object.values(second).join("\n");
    for (const name of GENERATED) {
      const secret = first[name] ?? "";
      expect(secret, name).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secondText, name).not.toContain(secret);
    }
  });

  it("prints every setting, and so does .env.example", () => {
    const printed = parseEnvFile(initEnv({ url: "https://tiehall.example.com" }));
    const example = parseEnvFile(readFileSync(envExample, "utf8"));
    const names = SETTINGS.map(({ name }) => name);
    expect(Object.keys(printed)).toEqual(names);
    expect(Object.keys(example)).toEqual(names);
  });

  it("prints a file that passes the settings checks of every role unchanged", () => {
    const printed = parseEnvFile(initEnv({ url: "https://tiehall.example.com" }));
    expect(readAppSettings(printed)).toMatchObject({
      url: "https://tiehall.example.com",
      database: { password: printed["TIEHALL_DATABASE_APP_PASSWORD"] },
      secretKey: printed["TIEHALL_SECRET_KEY"],
      authSecret: printed["TIEHALL_AUTH_SECRET"],
      trustedProxies: ["caddy"],
      clientMetadataFetch: true,
    });
    expect(readAppSettings(printed).smtp).toBeUndefined();
    expect(readMigrateSettings(printed)).toMatchObject({
      owner: { password: printed["TIEHALL_DATABASE_OWNER_PASSWORD"] },
      appRole: { name: "tiehall_app", password: printed["TIEHALL_DATABASE_APP_PASSWORD"] },
    });
    const trial = parseEnvFile(initEnv({ url: "http://localhost:3000" }));
    expect(readAppSettings(trial).url).toBe("http://localhost:3000");
  });

  it("writes the image reference --image gives verbatim, in a file that passes the settings checks of every role unchanged", () => {
    const printed = parseEnvFile(initEnv({ url: "https://tiehall.example.com", image: RELEASE_IMAGE }));
    expect(printed["TIEHALL_IMAGE"]).toBe(RELEASE_IMAGE);
    expect(readAppSettings(printed)).toMatchObject({
      url: "https://tiehall.example.com",
      database: { password: printed["TIEHALL_DATABASE_APP_PASSWORD"] },
      secretKey: printed["TIEHALL_SECRET_KEY"],
      authSecret: printed["TIEHALL_AUTH_SECRET"],
    });
    expect(readMigrateSettings(printed)).toMatchObject({
      owner: { password: printed["TIEHALL_DATABASE_OWNER_PASSWORD"] },
      appRole: { name: "tiehall_app", password: printed["TIEHALL_DATABASE_APP_PASSWORD"] },
    });
  });

  it("writes any other image reference verbatim too, with or without a registry, a tag or a digest", () => {
    for (const image of [
      "tiehall",
      "tiehall:ci",
      "ghcr.io/acme/tiehall:1.3.0",
      `ghcr.io/acme/tiehall@sha256:${"0123456789abcdef".repeat(4)}`,
      "localhost:5000/tiehall:dev",
      `registry.example.com:5000/platform/tools/tie-hall__x.y:1.3.0-rc.1_A@sha512:${"f".repeat(128)}`,
      "[::1]:5000/tiehall:dev",
    ]) {
      expect(parseEnvFile(initEnv({ url: "https://tiehall.example.com", image }))["TIEHALL_IMAGE"], image).toBe(image);
    }
  });

  it("prints fresh secrets on each run with the same --image", () => {
    const first = parseEnvFile(initEnv({ url: "https://tiehall.example.com", image: RELEASE_IMAGE }));
    const second = parseEnvFile(initEnv({ url: "https://tiehall.example.com", image: RELEASE_IMAGE }));
    expect(first["TIEHALL_IMAGE"]).toBe(RELEASE_IMAGE);
    expect(second["TIEHALL_IMAGE"]).toBe(RELEASE_IMAGE);
    const secondText = Object.values(second).join("\n");
    for (const name of GENERATED) expect(secondText, name).not.toContain(first[name]);
  });

  it("names the image's own build without --image: its release, or the commit of a build of main", () => {
    expect(
      parseEnvFile(initEnv({ url: "https://tiehall.example.com", build: { name: "ghcr.io/acme/tiehall", version: "1.3.0" } }))[
        "TIEHALL_IMAGE"
      ],
    ).toBe("ghcr.io/acme/tiehall:1.3.0");
    // A build of main is tagged by its commit, as the build workflow pushes it.
    expect(
      parseEnvFile(
        initEnv({
          url: "https://tiehall.example.com",
          build: { name: "ghcr.io/acme/tiehall", version: "0.0.0-dev", commit: "c".repeat(40) },
        }),
      )["TIEHALL_IMAGE"],
    ).toBe(`ghcr.io/acme/tiehall:sha-${"c".repeat(40)}`);
  });

  it("says at TIEHALL_IMAGE, without --image, that the release notes name the digest and both ways to pin it", () => {
    const upgrade = /To upgrade, back up, set the new image here and run `docker compose pull && docker compose up -d`\.$/;
    for (const build of [
      { name: "ghcr.io/acme/tiehall", version: "1.3.0" },
      { name: "ghcr.io/acme/tiehall", version: "0.0.0-dev", commit: "c".repeat(40) },
    ]) {
      const comment = commentAbove(initEnv({ url: "https://tiehall.example.com", build }), "TIEHALL_IMAGE");
      expect(comment, build.version).toMatch(/release notes name/);
      expect(comment, build.version).toMatch(/digest/);
      expect(comment, build.version).toMatch(/set TIEHALL_IMAGE to the reference the release notes give/);
      expect(comment, build.version).toMatch(/run init again with --image/);
      expect(comment, build.version).toMatch(upgrade);
    }
    // With --image, the comment says the image is as given, and names neither the release notes nor a way to pin.
    const given = commentAbove(initEnv({ url: "https://tiehall.example.com", image: RELEASE_IMAGE }), "TIEHALL_IMAGE");
    expect(given).toMatch(/as given to init with --image/);
    expect(given).not.toMatch(/release notes/);
    expect(given).not.toMatch(/init again/);
    expect(given).toMatch(upgrade);
  });

  it("keeps .env.example in step with the list of settings", () => {
    expect(readFileSync(envExample, "utf8")).toBe(exampleEnv());
  });
});

describe("the init role", () => {
  it("prints the .env on standard output and nothing else", () => {
    const run = runInit("--url", "https://tiehall.example.com");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const printed = parseEnvFile(run.stdout);
    expect(printed["TIEHALL_URL"]).toBe("https://tiehall.example.com");
    expect(() => readAppSettings(printed)).not.toThrow();
    expect(run.stdout).not.toMatch(/"level"/);
  });

  it("refuses a URL that the install would refuse, and prints nothing to standard output", () => {
    const run = runInit("--url", "http://tiehall.example.com");
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "tiehall init: TIEHALL_URL must be an https:// URL, or http://localhost with or without a port for a trial on one machine.\n",
    );
  });

  it.each([
    // An uppercase letter in the repository.
    "ghcr.io/acme/Tiehall:1.3.0",
    // A space.
    "ghcr.io/acme/tiehall:1.3.0 latest",
    // An empty tag.
    "ghcr.io/acme/tiehall:",
    // A digest of the wrong length.
    "ghcr.io/acme/tiehall@sha256:abc",
    // A digest with no value.
    "tiehall:1.3.0@md5",
  ])(
    "refuses --image %s, which is not an image reference, with one line that shows the shape, and prints nothing to standard output",
    (image) => {
      const run = runInit("--url", "https://tiehall.example.com", "--image", image);
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^tiehall init: [^\n]+\n$/);
      expect(run.stderr).toContain("--image");
      expect(run.stderr).toContain("not an image reference");
      expect(run.stderr).toContain("[registry/]repository[:tag][@digest]");
    },
    PROCESS_TIMEOUT,
  );

  it(
    "keeps --image without a value, or with an empty one, a usage error",
    () => {
      for (const args of [
        ["--url", "https://tiehall.example.com", "--image"],
        ["--url", "https://tiehall.example.com", "--image", ""],
      ]) {
        const run = runInit(...args);
        expect(run.status, args.join(" ")).toBe(2);
        expect(run.stdout).toBe("");
        expect(run.stderr).toBe("Usage: main.mjs init --url <https://tiehall.example.com> [--image <image@sha256:digest>]\n");
      }
    },
    PROCESS_TIMEOUT * 2,
  );

  it("names its options when the URL is missing or an option is unknown", () => {
    for (const args of [[], ["--url"], ["--url", "https://tiehall.example.com", "--force"]]) {
      const run = runInit(...args);
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("Usage: main.mjs init --url <https://tiehall.example.com> [--image <image@sha256:digest>]\n");
    }
  });
});
