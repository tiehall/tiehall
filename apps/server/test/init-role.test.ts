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

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const envExample = fileURLToPath(new URL("../../../deploy/.env.example", import.meta.url));

/** The settings whose values init generates: the passwords and the keys. */
const GENERATED = SETTINGS.filter(({ init }) => init === "secret").map(({ name }) => name);

function runInit(...args: string[]) {
  const run = spawnSync(process.execPath, [main, "init", ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  if (run.error) throw run.error;
  return run;
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

  it("pins the image it is given, and otherwise names the image's own build", () => {
    const pinned = `ghcr.io/acme/tiehall:1.4.0@sha256:${"a".repeat(64)}`;
    expect(parseEnvFile(initEnv({ url: "https://tiehall.example.com", image: pinned }))["TIEHALL_IMAGE"]).toBe(pinned);
    expect(
      parseEnvFile(initEnv({ url: "https://tiehall.example.com", build: { name: "ghcr.io/acme/tiehall", version: "1.4.0" } }))[
        "TIEHALL_IMAGE"
      ],
    ).toBe("ghcr.io/acme/tiehall:1.4.0");
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

  it("names its options when the URL is missing or an option is unknown", () => {
    for (const args of [[], ["--url"], ["--url", "https://tiehall.example.com", "--force"]]) {
      const run = runInit(...args);
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("Usage: main.mjs init --url <https://tiehall.example.com> [--image <image@sha256:digest>]\n");
    }
  });
});
