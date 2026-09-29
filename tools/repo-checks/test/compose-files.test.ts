import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeConfig, EXAMPLE_ENVIRONMENT, type ComposeModel, type ComposeService } from "../src/compose.ts";

// The self-host Compose file (tasks 2.8, 3.1 and 5.3; self-host-install:
// Compose runs Tiehall and Postgres; self-host-install: Only the migrate step
// holds the database owner's credentials; self-host-install: `TIEHALL_URL` and
// TLS). deploy/compose.yaml is the one Compose file an install runs, with every
// setting from the `.env` that `init` prints; CI boots it.

const deploy = fileURLToPath(new URL("../../../deploy/", import.meta.url));
const selfHost = fileURLToPath(new URL("../../../deploy/compose.yaml", import.meta.url));
const main = fileURLToPath(new URL("../../../apps/server/src/main.ts", import.meta.url));
const image = `ghcr.io/example/tiehall:1.4.0@sha256:${"0".repeat(64)}`;

let folder: string;
/** A .env printed by init, as an operator writes it. */
let envFile: string;
let env: Map<string, string>;

/** Runs the init role from source, as `docker run --rm <image> init` does in the image. */
function init(url: string): string {
  const run = spawnSync(process.execPath, [main, "init", "--url", url, "--image", image], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`init failed: ${run.stderr}`);
  return run.stdout;
}

function values(text: string): Map<string, string> {
  return new Map(
    text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
  );
}

// Runs the init role as a child process, which takes longer on a CI runner than Vitest's 10-second default for hooks
// allows for.
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "tiehall-compose-"));
  envFile = join(folder, ".env");
  const text = init("https://tiehall.example.com");
  writeFileSync(envFile, text);
  env = values(text);
}, 60_000);

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

function model(options: { profiles?: string[]; envFile?: string } = {}): ComposeModel {
  const result = composeConfig([selfHost], { profiles: ["caddy"], envFile, ...options });
  if (result.model === undefined) throw new Error(`docker compose config failed: ${result.stderr}`);
  return result.model;
}

function environmentOf(service: ComposeService | undefined): Record<string, string | null> {
  return (service?.["environment"] ?? {}) as Record<string, string | null>;
}

describe("the self-host Compose file", () => {
  it("is the only Compose file in deploy/, with no overlay beside it", () => {
    const composeFiles = readdirSync(deploy).filter((name) => /^(docker-)?compose\b.*\.ya?ml$/.test(name));
    expect(composeFiles).toEqual(["compose.yaml"]);
  });

  it("passes docker compose config with a .env printed by init, with and without the caddy profile", () => {
    const without = composeConfig([selfHost], { envFile });
    expect(without.stderr).toBe("");
    expect(Object.keys(without.model?.services ?? {}).sort()).toEqual(["app", "migrate", "postgres"]);
    const withCaddy = composeConfig([selfHost], { envFile, profiles: ["caddy"] });
    expect(withCaddy.stderr).toBe("");
    expect(Object.keys(withCaddy.model?.services ?? {}).sort()).toEqual(["app", "caddy", "migrate", "postgres"]);
  });

  it("also passes with only the example image, as the CI policy check reads it", () => {
    const result = composeConfig([selfHost], { profiles: ["caddy"] });
    expect(result.status).toBe(0);
    expect(result.model?.services["app"]?.image).toBe(EXAMPLE_ENVIRONMENT.TIEHALL_IMAGE);
  });

  it("runs the image from .env in role all against stock Postgres 17", () => {
    const { services } = model();
    expect(services["app"]?.image).toBe(image);
    expect(services["app"]?.command).toEqual(["all"]);
    expect(services["migrate"]?.image).toBe(image);
    expect(services["migrate"]?.command).toEqual(["migrate"]);
    expect(services["postgres"]?.image).toMatch(/^postgres:17@sha256:[0-9a-f]{64}$/);
    expect(services["caddy"]?.["profiles"]).toEqual(["caddy"]);
  });

  it("runs Postgres with the owner's password from .env, password authentication and no published port", () => {
    const postgres = model().services["postgres"];
    expect(environmentOf(postgres)).toMatchObject({
      POSTGRES_USER: "tiehall",
      POSTGRES_DB: "tiehall",
      POSTGRES_PASSWORD: env.get("TIEHALL_DATABASE_OWNER_PASSWORD"),
      POSTGRES_HOST_AUTH_METHOD: "scram-sha-256",
    });
    expect(postgres?.ports).toBeUndefined();
  });

  it("gives the owner's credentials to the one-shot migrate step only, and the app role's to the app", () => {
    const { services } = model();
    expect(services["migrate"]?.["restart"]).toBe("no");
    expect(environmentOf(services["migrate"])).toMatchObject({
      TIEHALL_DATABASE_OWNER_PASSWORD: env.get("TIEHALL_DATABASE_OWNER_PASSWORD"),
      TIEHALL_DATABASE_APP_PASSWORD: env.get("TIEHALL_DATABASE_APP_PASSWORD"),
    });
    const app = environmentOf(services["app"]);
    expect(app).toMatchObject({
      TIEHALL_URL: "https://tiehall.example.com",
      TIEHALL_DATABASE_APP_PASSWORD: env.get("TIEHALL_DATABASE_APP_PASSWORD"),
      TIEHALL_SECRET_KEY: env.get("TIEHALL_SECRET_KEY"),
      TIEHALL_AUTH_SECRET: env.get("TIEHALL_AUTH_SECRET"),
      TIEHALL_TRUSTED_PROXIES: "caddy",
      TIEHALL_CLIENT_METADATA_FETCH: "on",
    });
    expect(Object.keys(app).filter((name) => /OWNER|POSTGRES_PASSWORD/.test(name))).toEqual([]);
    expect(JSON.stringify(services["app"])).not.toContain(env.get("TIEHALL_DATABASE_OWNER_PASSWORD"));
  });

  it("starts the app only after the migrate step has finished", () => {
    expect(model().services["app"]?.["depends_on"]).toMatchObject({
      migrate: { condition: "service_completed_successfully" },
      postgres: { condition: "service_healthy" },
    });
  });

  it("publishes the app's one port on 127.0.0.1 by default, and only Caddy publishes 80 and 443", () => {
    const { services } = model();
    expect(services["app"]?.ports).toEqual([
      { mode: "ingress", host_ip: "127.0.0.1", target: 3000, published: "3000", protocol: "tcp" },
    ]);
    expect(services["migrate"]?.ports).toBeUndefined();
    expect((services["caddy"]?.ports ?? []).map((port) => (port as { published: string }).published).sort()).toEqual([
      "443",
      "443",
      "80",
    ]);
  });

  it("puts Caddy in front with the Caddyfile, for TIEHALL_URL", () => {
    const caddy = model().services["caddy"];
    expect(environmentOf(caddy)).toEqual({ TIEHALL_URL: "https://tiehall.example.com" });
    expect(JSON.stringify(caddy?.["volumes"])).toContain("/etc/caddy/Caddyfile");
    expect(readFileSync(join(deploy, "Caddyfile"), "utf8")).toMatch(/^\{\$TIEHALL_URL\} \{\n\treverse_proxy app:3000\n\}$/m);
  });

  it("trusts the caddy profile's proxy by the name .env gives it, which resolves inside the install with or without the profile", () => {
    expect(env.get("TIEHALL_TRUSTED_PROXIES")).toBe("caddy");
    for (const profiles of [[], ["caddy"]]) {
      const { services } = model({ profiles });
      expect(services["app"]?.networks?.["default"], profiles.join()).toMatchObject({ aliases: ["caddy"] });
    }
  });

  it("connects to an external Postgres through the two URLs in .env", () => {
    const external = join(folder, "external.env");
    const owner = "postgres://tiehall:owner-secret@db.example.com:5432/tiehall";
    const app = "postgres://tiehall_app:app-secret@db.example.com:5432/tiehall";
    writeFileSync(external, `${readFileSync(envFile, "utf8")}TIEHALL_DATABASE_OWNER_URL=${owner}\nTIEHALL_DATABASE_APP_URL=${app}\n`);
    const { services } = model({ envFile: external });
    expect(environmentOf(services["migrate"])).toMatchObject({ TIEHALL_DATABASE_OWNER_URL: owner, TIEHALL_DATABASE_APP_URL: app });
    expect(environmentOf(services["app"])).toMatchObject({ TIEHALL_DATABASE_APP_URL: app });
    expect(JSON.stringify(services["app"])).not.toContain("owner-secret");
  });

  it("runs the image's services confined: non-root, a read-only root filesystem, a tmpfs /tmp, no capabilities, no new privileges", () => {
    const { services } = model();
    for (const name of ["app", "migrate"]) {
      const service = services[name];
      expect(service?.["user"], name).toBe("1000:1000");
      expect(service?.["read_only"], name).toBe(true);
      expect(service?.["tmpfs"], name).toEqual(["/tmp"]);
      expect(service?.["cap_drop"], name).toEqual(["ALL"]);
      expect(service?.["security_opt"], name).toEqual(["no-new-privileges:true"]);
    }
    expect(JSON.stringify(services["app"]?.["healthcheck"])).toContain("/healthz");
  });
});
