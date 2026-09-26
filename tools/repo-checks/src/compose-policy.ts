import { roleOf, type ComposeModel, type ComposeService } from "./compose.ts";

// The Compose rules CI enforces before merge (self-host-install: Tiehall's
// containers are confined; self-host-install: Only the migrate step holds the
// database owner's credentials). Task 5.4 extends them for the `.env` file.

export interface PolicyViolation {
  service: string;
  rule: "ports-only-on-caddy" | "app-secrets";
  detail: string;
}

/** The reverse proxy of the optional `caddy` profile: the only service that may publish ports. */
export const REVERSE_PROXY = "caddy";

/** Roles of the Tiehall image that run the web server or the worker; `all` runs both. */
const APP_ROLES = new Set(["web", "worker", "all"]);

/** The only secret the app (the web and worker roles) may receive: the app database password. */
export const APP_SECRETS = new Set(["app_database_password"]);

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
        // The app's one port may be published on the host's loopback address, for a reverse proxy in front.
        if (roleOf(definition) === "all" && (port as Port).host_ip === "127.0.0.1") continue;
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
