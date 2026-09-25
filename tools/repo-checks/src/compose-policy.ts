import { roleOf, type ComposeModel, type ComposeService } from "./compose.ts";

// The Compose rules CI enforces before merge (operations: Releases are built
// once in CI and pulled by the servers). The servers check a wider, fixed
// policy of their own before each release (task 5.2).

export interface PolicyViolation {
  service: string;
  rule: "ports-only-on-caddy" | "app-secrets";
  detail: string;
}

/** The reverse proxy: the only service that may publish ports (operations: Only the reverse proxy is reachable). */
export const REVERSE_PROXY = "caddy";

/** Roles of the Tiehall image that run the web server or the worker; `all` runs both. */
const APP_ROLES = new Set(["web", "worker", "all"]);

/**
 * The only secrets web and worker may receive (operations: Secrets are never
 * stored in plaintext): the app database password, the integration-secret
 * master key, the app's signing keys and the error-tracking key.
 */
export const APP_SECRETS = new Set([
  "app_database_password",
  "integration_master_key",
  "app_signing_keys",
  "error_tracking_dsn",
]);

interface Port {
  host_ip?: string;
  published?: string | number;
  target?: number;
  protocol?: string;
}

export function checkComposePolicy(model: ComposeModel): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const [service, definition] of Object.entries(model.services).sort(([a], [b]) => a.localeCompare(b))) {
    if (service !== REVERSE_PROXY) {
      for (const port of definition.ports ?? []) {
        violations.push({ service, rule: "ports-only-on-caddy", detail: `publishes ${describePort(port as Port)}` });
      }
      if (definition["network_mode"] === "host") {
        violations.push({ service, rule: "ports-only-on-caddy", detail: "uses the host network" });
      }
    }
    if (APP_ROLES.has(roleOf(definition) ?? "")) {
      for (const secret of secretsOf(definition)) {
        if (!APP_SECRETS.has(secret)) violations.push({ service, rule: "app-secrets", detail: `receives ${secret}` });
      }
    }
  }
  return violations;
}

function secretsOf(service: ComposeService): string[] {
  return (service.secrets ?? []).map((secret) => secret.source);
}

function describePort({ host_ip, published, target, protocol }: Port): string {
  const host = host_ip === undefined || host_ip === "" ? "" : `${host_ip}:`;
  const suffix = protocol === undefined || protocol === "tcp" ? "" : `/${protocol}`;
  return `${host}${published ?? ""}:${target ?? ""}${suffix}`;
}
