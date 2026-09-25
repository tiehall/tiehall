import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeConfig, EXAMPLE_ENVIRONMENT, type ComposeModel } from "../src/compose.ts";

// The self-host Compose file (tasks 2.8 and 3.1; self-host-install: Compose
// runs Tiehall and Postgres). deploy/compose.yaml is the one Compose file an
// install runs, and CI boots it; there is no hosted overlay.

const deploy = fileURLToPath(new URL("../../../deploy/", import.meta.url));
const selfHost = fileURLToPath(new URL("../../../deploy/compose.yaml", import.meta.url));

function model(files: string[]): ComposeModel {
  // Caddy is the optional TLS profile.
  const result = composeConfig(files, { profiles: ["caddy"] });
  if (result.model === undefined) throw new Error(`docker compose config failed: ${result.stderr}`);
  return result.model;
}

describe("the self-host Compose file", () => {
  it("is the only Compose file in deploy/, with no overlay beside it", () => {
    const composeFiles = readdirSync(deploy).filter((name) => /^(docker-)?compose\b.*\.ya?ml$/.test(name));
    expect(composeFiles).toEqual(["compose.yaml"]);
  });

  it("passes docker compose config, with and without Caddy", () => {
    expect(composeConfig([selfHost]).status).toBe(0);
    expect(composeConfig([selfHost], { profiles: ["caddy"] }).status).toBe(0);
  });

  it("runs the image in role all against stock Postgres 17, with optional Caddy", () => {
    const { services } = model([selfHost]);
    expect(Object.keys(services).sort()).toEqual(["app", "caddy", "migrate", "postgres"]);
    expect(services["app"]?.image).toBe(EXAMPLE_ENVIRONMENT.TIEHALL_IMAGE);
    expect(services["app"]?.command).toEqual(["all"]);
    expect(services["postgres"]?.image).toMatch(/^postgres:17@sha256:[0-9a-f]{64}$/);
    expect(services["caddy"]?.["profiles"]).toEqual(["caddy"]);
    expect(Object.keys(composeConfig([selfHost]).model?.services ?? {}).sort()).toEqual(["app", "migrate", "postgres"]);
  });

  it("finishes the one-shot migrate step before the app starts", () => {
    const { services } = model([selfHost]);
    expect(services["migrate"]?.image).toBe(EXAMPLE_ENVIRONMENT.TIEHALL_IMAGE);
    expect(services["migrate"]?.command).toEqual(["migrate"]);
    expect(services["migrate"]?.["restart"]).toBe("no");
    expect(services["app"]?.["depends_on"]).toMatchObject({
      migrate: { condition: "service_completed_successfully" },
      postgres: { condition: "service_healthy" },
    });
  });

  it("runs the image's services on a read-only root filesystem with a tmpfs /tmp, and checks /healthz", () => {
    const { services } = model([selfHost]);
    for (const name of ["app", "migrate"]) {
      expect(services[name]?.["read_only"], name).toBe(true);
      expect(services[name]?.["tmpfs"], name).toEqual(["/tmp"]);
    }
    expect(JSON.stringify(services["app"]?.["healthcheck"])).toContain("/healthz");
  });
});
