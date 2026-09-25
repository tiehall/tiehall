import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeConfig, EXAMPLE_ENVIRONMENT, type ComposeModel, type ComposeService } from "../src/compose.ts";

// The two Compose files (task 2.9; operations: Production runs the self-host
// Compose file and image). deploy/compose.yaml is what a self-hosting customer
// runs; production runs it plus deploy/compose.saas.yaml, and the overlay may
// change only what the spec lets it change.

const selfHost = fileURLToPath(new URL("../../../deploy/compose.yaml", import.meta.url));
const overlay = fileURLToPath(new URL("../../../deploy/compose.saas.yaml", import.meta.url));

function model(files: string[]): ComposeModel {
  // Caddy is optional for self-hosting and always on in production.
  const result = composeConfig(files, { profiles: ["caddy"] });
  if (result.model === undefined) throw new Error(`docker compose config failed: ${result.stderr}`);
  return result.model;
}

/** A copy of a service without the given keys (dotted paths reach into mappings). */
function without(service: ComposeService | undefined, ...paths: string[]): unknown {
  const copy = structuredClone(service ?? {}) as Record<string, unknown>;
  for (const path of paths) {
    const keys = path.split(".");
    let parent: Record<string, unknown> | undefined = copy;
    for (const key of keys.slice(0, -1)) parent = parent?.[key] as Record<string, unknown> | undefined;
    if (parent !== undefined) delete parent[keys.at(-1) ?? ""];
  }
  return copy;
}

const secretsOf = (service: ComposeService | undefined) => (service?.secrets ?? []).map((secret) => secret.source).sort();
const networksOf = (service: ComposeService | undefined) => Object.keys(service?.networks ?? {}).sort();

describe("the self-host Compose file", () => {
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

describe("the SaaS overlay", () => {
  it("passes docker compose config on top of the self-host file", () => {
    expect(composeConfig([selfHost, overlay]).status).toBe(0);
  });

  it("splits the app into web-a, web-b and worker, and keeps migrate, Postgres and Caddy", () => {
    const { services } = model([selfHost, overlay]);
    expect(Object.keys(services).sort()).toEqual(["caddy", "migrate", "postgres", "web-a", "web-b", "worker"]);
    expect(services["web-a"]?.command).toEqual(["web"]);
    expect(services["web-b"]?.command).toEqual(["web"]);
    expect(services["worker"]?.command).toEqual(["worker"]);
    expect(services["postgres"]?.image).toBe(EXAMPLE_ENVIRONMENT.TIEHALL_POSTGRES_IMAGE);
  });

  it("gives each service only its own secrets", () => {
    const { services } = model([selfHost, overlay]);
    const app = ["app_database_password", "app_signing_keys", "error_tracking_dsn", "integration_master_key"];
    expect(secretsOf(services["web-a"])).toEqual(app);
    expect(secretsOf(services["web-b"])).toEqual(app);
    expect(secretsOf(services["worker"])).toEqual(app);
    expect(secretsOf(services["migrate"])).toEqual(["owner_database_password"]);
    expect(secretsOf(services["postgres"])).toEqual([
      "backup_database_password",
      "backup_repo1_passphrase",
      "backup_repo1_storage_key",
      "backup_repo2_passphrase",
      "backup_repo2_storage_key",
      "canary_database_password",
      "dump_public_key",
    ]);
    expect(secretsOf(services["caddy"])).toEqual([]);
  });

  it("puts the services on the edge, app and migrate networks", () => {
    const merged = model([selfHost, overlay]);
    expect(Object.keys(merged.networks ?? {}).sort()).toEqual(["app", "edge", "migrate"]);
    expect(networksOf(merged.services["caddy"])).toEqual(["edge"]);
    expect(networksOf(merged.services["web-a"])).toEqual(["app", "edge"]);
    expect(networksOf(merged.services["web-b"])).toEqual(["app", "edge"]);
    expect(networksOf(merged.services["worker"])).toEqual(["app"]);
    expect(networksOf(merged.services["postgres"])).toEqual(["app", "migrate"]);
    expect(networksOf(merged.services["migrate"])).toEqual(["migrate"]);
  });

  it("changes no other key", () => {
    const base = model([selfHost]);
    const merged = model([selfHost, overlay]);
    const app = base.services["app"];

    // web-a, web-b and worker are the all-in-one app with another role, secrets and networks;
    // the worker serves no HTTP, so it does not inherit the app's /healthz check.
    for (const name of ["web-a", "web-b"]) {
      expect(without(merged.services[name], "command", "secrets", "networks"), name).toEqual(
        without(app, "command", "secrets", "networks"),
      );
    }
    expect(without(merged.services["worker"], "command", "secrets", "networks", "healthcheck")).toEqual(
      without(app, "command", "secrets", "networks", "healthcheck"),
    );
    // migrate connects as the schema owner, with the owner's password.
    expect(
      without(merged.services["migrate"], "secrets", "networks", "environment.DATABASE_URL", "environment.DATABASE_PASSWORD_FILE"),
    ).toEqual(without(base.services["migrate"], "secrets", "networks", "environment.DATABASE_URL", "environment.DATABASE_PASSWORD_FILE"));
    // The database image is swapped for Tiehall's, with the backup tooling.
    expect(without(merged.services["postgres"], "image", "secrets", "networks")).toEqual(
      without(base.services["postgres"], "image", "secrets", "networks"),
    );
    expect(without(merged.services["caddy"], "networks")).toEqual(without(base.services["caddy"], "networks"));

    // Top level: the same project and volumes; the self-host secrets unchanged, per-service ones added.
    expect(merged.name).toBe(base.name);
    expect(merged.volumes).toEqual(base.volumes);
    for (const [name, secret] of Object.entries(base.secrets ?? {})) expect(merged.secrets?.[name], name).toEqual(secret);
  });
});
