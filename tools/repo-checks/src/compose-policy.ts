import { OWNER_SENTINEL, roleOf, type ComposeModel, type ComposeService } from "./compose.ts";

// The Compose rules CI enforces before merge (self-host-install: Tiehall's
// containers are confined; self-host-install: Only the migrate step holds the
// database owner's credentials; self-host-install: `TIEHALL_URL` and TLS):
// - ports: Postgres and migrate publish nothing, the app publishes only on
//   127.0.0.1, and only the reverse proxy of the caddy profile publishes 80
//   and 443; no service joins the host network;
// - owner-secrets: no service but migrate, and Postgres itself, receives the
//   database owner's password or URL, under its own name or any other, or a
//   Compose secret named for the owner. The check reads the file with stand-in
//   owner credentials and looks for them in every other service;
// - confined: migrate and the app run as a non-root user, on a read-only root
//   filesystem with a tmpfs /tmp, with every capability dropped, none added,
//   not privileged, and with no-new-privileges; and each has a memory limit and
//   a process limit (decisions-from-groups-15-28, D55 (55)), whose values an
//   operator may change but not remove.

export type PolicyRule = "ports" | "owner-secrets" | "confined";

export interface PolicyViolation {
  service: string;
  rule: PolicyRule;
  detail: string;
}

/** The reverse proxy of the optional `caddy` profile: the only service that may publish 80 and 443. */
export const REVERSE_PROXY = "caddy";
const REVERSE_PROXY_PROFILE = "caddy";
const REVERSE_PROXY_PORTS = new Set(["80", "443"]);

/** Roles of the Tiehall image that run the web server or the worker; `all` runs both. */
const APP_ROLES = new Set(["web", "worker", "all"]);
/** Every role of the Tiehall image that runs as a service. */
const TIEHALL_ROLES = new Set([...APP_ROLES, "migrate"]);

interface Port {
  host_ip?: string;
  published?: string | number;
  target?: number;
  protocol?: string;
}

export function checkComposePolicy(model: ComposeModel): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const [service, definition] of Object.entries(model.services).sort(([a], [b]) => a.localeCompare(b))) {
    const add = (rule: PolicyRule, detail: string) => violations.push({ service, rule, detail });
    for (const detail of portProblems(service, definition)) add("ports", detail);
    for (const detail of ownerSecretProblems(definition)) add("owner-secrets", detail);
    if (TIEHALL_ROLES.has(roleOf(definition) ?? "")) {
      for (const detail of confinementProblems(definition)) add("confined", detail);
    }
  }
  return violations;
}

function portProblems(service: string, definition: ComposeService): string[] {
  const problems: string[] = [];
  const ports = (definition.ports ?? []) as Port[];
  if (service === REVERSE_PROXY) {
    const profiles = (definition["profiles"] ?? []) as string[];
    if (!profiles.includes(REVERSE_PROXY_PROFILE) && ports.length > 0) {
      problems.push(`publishes ${list(ports.map(describePort))} outside the ${REVERSE_PROXY_PROFILE} profile`);
    }
    for (const port of ports) {
      if (!REVERSE_PROXY_PORTS.has(String(port.published))) {
        problems.push(`publishes ${describePort(port)}; the ${REVERSE_PROXY_PROFILE} profile publishes only 80 and 443`);
      }
    }
  } else {
    for (const port of ports) {
      if (REVERSE_PROXY_PORTS.has(String(port.published))) {
        problems.push(`publishes ${describePort(port)}; only the ${REVERSE_PROXY_PROFILE} profile publishes 80 and 443`);
      } else if (APP_ROLES.has(roleOf(definition) ?? "")) {
        if (port.host_ip !== "127.0.0.1") {
          problems.push(`publishes ${describePort(port)}; the app may publish only a port bound to 127.0.0.1`);
        }
      } else {
        problems.push(`publishes ${describePort(port)}; it may publish no port`);
      }
    }
  }
  if (definition["network_mode"] === "host") problems.push("uses the host network");
  return problems;
}

function ownerSecretProblems(definition: ComposeService): string[] {
  // The migrate step connects as the owner; the bundled Postgres is the owner's database.
  if (roleOf(definition) === "migrate" || String(definition.image ?? "").startsWith("postgres:")) return [];
  const problems: string[] = [];
  const environment = Object.keys((definition["environment"] ?? {}) as Record<string, unknown>);
  if (JSON.stringify(definition).includes(OWNER_SENTINEL) || environment.some((name) => /OWNER/.test(name))) {
    problems.push("receives the database owner's password or URL; only migrate may");
  }
  for (const { source } of definition.secrets ?? []) {
    if (/owner/i.test(source)) problems.push(`receives the secret ${source}; only migrate may`);
  }
  return problems;
}

function confinementProblems(definition: ComposeService): string[] {
  const problems: string[] = [];
  const user = definition["user"];
  if (typeof user !== "string" || user === "") {
    problems.push("does not name its user; set user to the image's unprivileged uid");
  } else if (/^(0|root)(:|$)/.test(user)) {
    problems.push("runs as root; set user to the image's unprivileged uid");
  }
  if (definition["read_only"] !== true) problems.push("has a writable root filesystem (read_only: true)");
  const tmpfs = [definition["tmpfs"] ?? []].flat() as string[];
  if (!tmpfs.some((mount) => mount === "/tmp" || mount.startsWith("/tmp:"))) {
    problems.push("has no memory-backed /tmp (tmpfs: /tmp)");
  }
  const capDrop = (definition["cap_drop"] ?? []) as string[];
  if (!capDrop.some((capability) => capability.toUpperCase() === "ALL")) {
    problems.push("does not drop every capability (cap_drop: ALL)");
  }
  const capAdd = (definition["cap_add"] ?? []) as string[];
  if (capAdd.length > 0) problems.push(`adds the capabilities ${list(capAdd)}`);
  if (definition["privileged"] === true) problems.push("runs privileged");
  const securityOptions = (definition["security_opt"] ?? []) as string[];
  if (!securityOptions.some((option) => /^no-new-privileges(:true|=true)?$/.test(option))) {
    problems.push("can gain privileges (security_opt: no-new-privileges:true)");
  }
  // Compose writes mem_limit in bytes; 0, as -1 for pids_limit, means no limit.
  if (!(Number(definition["mem_limit"] ?? 0) > 0)) problems.push("has no memory limit (mem_limit)");
  if (!(Number(definition["pids_limit"] ?? 0) > 0)) problems.push("has no process limit (pids_limit)");
  return problems;
}

function describePort({ host_ip, published, target, protocol }: Port): string {
  const host = host_ip === undefined || host_ip === "" ? "" : `${host_ip}:`;
  const suffix = protocol === undefined || protocol === "tcp" ? "" : `/${protocol}`;
  return `${host}${published ?? ""}:${target ?? ""}${suffix}`;
}

/** "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
