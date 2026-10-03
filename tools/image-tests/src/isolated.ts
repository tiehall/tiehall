import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createActionsOidc, type ActionsOidc } from "@tiehall/testing/oidc";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import { createTestCertificate } from "@tiehall/testing/tls";
import { NODE_IMAGE } from "./github.ts";
import { quote, type Install } from "./install.ts";

// An install in a network where only the stubs of the services it may reach
// are reachable, and where every other DNS query and connection attempt is
// seen (self-host-install: No telemetry and a documented list of outbound
// connections; self-host-install: The setting that switches metadata-document
// fetching off; self-host-install: No model calls; design.md, Technical
// decisions: T17; design.md, Self-hosting decisions: S13).
//
// The install runs the release files and the image unchanged. A Compose
// override in its folder, compose.override.yaml, which `docker compose` reads
// beside compose.yaml, makes the project's default network internal, so that
// Docker gives its containers no route out of it, on a subnet of public
// addresses, as an agent vendor's host has. On that network, under the names
// the install calls, small TCP relays pass each connection on to a stub on the
// host, through a second network that only the relays join:
// - github.com and api.github.com: the GitHub stub;
// - token.actions.githubusercontent.com: the keys of a test issuer of GitHub
//   Actions OIDC tokens, which check the contract Action's reports;
// - vendor.example: an agent vendor's host, serving the Client ID Metadata
//   Document of the agent client a test signs in with;
// - mail.acme.example: the SMTP test server, which .env names.
// One relay more publishes the install's port on 127.0.0.1, as the app's own
// port does on a usual install, so browsers, the CLI and agents on the host
// reach the app. The app trusts the stubs' one certificate through
// NODE_EXTRA_CA_CERTS, Node's own way to add one.
//
// The watch:
// - Docker's DNS server in each container answers the names of the network,
//   the relays' among them, and passes every other query on to the DNS server
//   the override gives Postgres, the migrate step and the app: a logger on the
//   network, which answers that no such name exists and logs the query, so
//   any name another than the stubs' that the install looks up is in its log;
// - a connection attempt to an address outside the network finds no route,
//   and the kernel counts it in the container's network namespace
//   (OutNoRoutes in /proc/net/snmp, Ip6OutNoRoutes in /proc/net/snmp6), which
//   is read in the app and Postgres, whose namespaces stay up while they run,
//   and in the namespace the migrate step ran in: the step ends before the
//   app starts, and its namespace with it, so it runs in the namespace of a
//   container of its own that holds it (migrate-net), which stays up.

/** The host of GitHub Actions' OIDC issuer, whose published keys check the contract Action's tokens. */
export const ACTIONS_OIDC_HOST = "token.actions.githubusercontent.com";
/** The SMTP server's host, as .env names it. */
export const SMTP_HOST = "mail.acme.example";
/** The agent vendor's host, which serves its client's metadata document. */
export const VENDOR_HOST = "vendor.example";
/** The agent client's id: the URL of its Client ID Metadata Document. */
export const CLIENT_METADATA_URL = `https://${VENDOR_HOST}/oauth/client.json`;

/**
 * The services whose network namespaces are watched for connection attempts that find no route, each with the
 * container whose namespace it runs in: its own, or, for the migrate step, which ends, the one that holds its namespace.
 */
export const WATCHED_SERVICES = { app: "app", postgres: "postgres", migrate: "migrate-net" } as const;

/** A DNS query the logger received: the name, the record type's number and the address that asked. */
export interface DnsQuery {
  name: string;
  type: number;
  from: string;
}

/** A request one of the HTTPS stubs on the host, other than GitHub's, received. */
export interface StubRequest {
  host: string;
  path: string;
}

export interface Isolation {
  github: GitHubStub;
  smtp: SmtpSink;
  oidc: ActionsOidc;
  /** The launch arguments that send a browser's calls to github.com to the stub and trust its certificate. */
  browserArgs: string[];
  /** What the keys of the OIDC issuer and the vendor's host received, in order. */
  readonly received: readonly StubRequest[];
  /** Sets the metadata document the vendor's host serves. */
  serveClientMetadata(document: Record<string, unknown>): void;
  /** Every query the DNS logger received so far. */
  dnsQueries(): DnsQuery[];
  /** The connection attempts that found no route, so far, in each watched service, as the kernel counts them. */
  noRouteAttempts(): Record<keyof typeof WATCHED_SERVICES, number>;
  close(): Promise<void>;
}

/** The DNS logger: answers every query it receives with "no such name", and logs it as a line of JSON, over UDP and TCP. */
const DNS_LOGGER = [
  'const dgram = require("node:dgram"); const net = require("node:net");',
  "function answer(query, from) {",
  "  let at = 12; const labels = [];",
  "  while (at < query.length && query[at] !== 0) { labels.push(query.subarray(at + 1, at + 1 + query[at]).toString('latin1')); at += query[at] + 1; }",
  "  const type = at + 2 < query.length ? query.readUInt16BE(at + 1) : 0;",
  "  console.log(JSON.stringify({ name: labels.join('.'), type, from }));",
  "  const reply = Buffer.from(query.subarray(0, Math.min(query.length, at + 5)));",
  "  if (reply.length < 12) return reply;",
  "  reply.writeUInt16BE(0x8000 | (query.readUInt16BE(2) & 0x7900) | 0x0080 | 0x0003, 2);",
  "  reply.writeUInt16BE(1, 4); reply.writeUInt16BE(0, 6); reply.writeUInt16BE(0, 8); reply.writeUInt16BE(0, 10);",
  "  return reply;",
  "}",
  'const udp = dgram.createSocket("udp4");',
  'udp.on("message", (query, from) => { try { udp.send(answer(query, from.address), from.port, from.address); } catch {} });',
  "udp.bind(53);",
  "net.createServer((socket) => {",
  "  let buffer = Buffer.alloc(0);",
  '  socket.on("data", (chunk) => {',
  "    buffer = Buffer.concat([buffer, chunk]);",
  "    while (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {",
  "      const query = buffer.subarray(2, 2 + buffer.readUInt16BE(0)); buffer = buffer.subarray(2 + query.length);",
  "      try { const reply = answer(query, socket.remoteAddress); const length = Buffer.alloc(2); length.writeUInt16BE(reply.length); socket.write(Buffer.concat([length, reply])); } catch {}",
  "    }",
  "  });",
  '  socket.on("error", () => {});',
  "}).listen(53);",
].join(" ");

/** A relay: listens on LISTEN_PORT and passes each connection on to TARGET_HOST:TARGET_PORT. */
const RELAY = [
  'const net = require("node:net");',
  "net.createServer((client) => {",
  "  const upstream = net.connect(Number(process.env.TARGET_PORT), process.env.TARGET_HOST);",
  "  client.pipe(upstream).pipe(client);",
  '  client.on("error", () => upstream.destroy());',
  '  upstream.on("error", () => client.destroy());',
  "}).listen(Number(process.env.LISTEN_PORT));",
].join(" ");

/** A subnet of public addresses for the install's network, which reaches nowhere, so it can be any. */
function publicSubnet(): { subnet: string; dns: string } {
  const prefix = `11.${randomInt(0, 256)}.${randomInt(0, 256)}`;
  return { subnet: `${prefix}.0/24`, dns: `${prefix}.53` };
}

/**
 * Starts the stubs on the host, listening where the relays reach them through
 * the host's gateway, and writes the install's Compose override that puts the
 * install in a network where only they are reachable.
 */
export async function isolate(install: Install): Promise<Isolation> {
  const certificate = createTestCertificate({ dnsNames: ["github.com", "api.github.com", ACTIONS_OIDC_HOST, VENDOR_HOST], ipAddresses: ["127.0.0.1"] });
  const github = await startGitHubStub({ tls: { key: certificate.key, cert: certificate.cert }, listenHost: "0.0.0.0" });
  const smtp = await startSmtpSink({ listenHost: "0.0.0.0" });
  const oidc = createActionsOidc();
  const received: StubRequest[] = [];
  let clientMetadata: Record<string, unknown> | undefined;
  // The keys of the OIDC issuer and the vendor's host: one server, which tells them apart by the Host header.
  const others: Server = createServer({ key: certificate.key, cert: certificate.cert }, (incoming, outgoing) => {
    const host = (incoming.headers.host ?? "").replace(/:\d+$/, "");
    const path = incoming.url ?? "/";
    received.push({ host, path });
    if (host === ACTIONS_OIDC_HOST && path === "/.well-known/jwks") {
      outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(oidc.jwks));
    } else if (host === VENDOR_HOST && path === new URL(CLIENT_METADATA_URL).pathname && clientMetadata !== undefined) {
      outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(clientMetadata));
    } else {
      outgoing.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => others.listen(0, "0.0.0.0", resolve));
  const othersPort = (others.address() as { port: number }).port;
  writeFileSync(join(install.dir, "stubs.pem"), certificate.cert, { mode: 0o644 });

  const { subnet, dns } = publicSubnet();
  const portOf = (url: string) => new URL(url).port;
  const relay = (name: string, input: { aliases?: string[]; listen: number; target: string; port: string | number; publish?: string }) =>
    [
      `  ${name}:`,
      `    image: ${NODE_IMAGE}`,
      `    command: ["node", "--eval", ${JSON.stringify(RELAY)}]`,
      "    environment:",
      `      LISTEN_PORT: "${input.listen}"`,
      `      TARGET_HOST: ${input.target}`,
      `      TARGET_PORT: "${input.port}"`,
      "    extra_hosts:",
      '      - "host.docker.internal:host-gateway"',
      ...(input.publish === undefined ? [] : ["    ports:", `      - "${input.publish}"`]),
      "    networks:",
      "      default:",
      ...(input.aliases === undefined ? [] : [`        aliases: [${input.aliases.join(", ")}]`]),
      "      outside: {}",
      "    restart: unless-stopped",
    ].join("\n");
  const relays = [
    relay("github-web", { aliases: ["github.com"], listen: 443, target: "host.docker.internal", port: portOf(github.webUrl) }),
    relay("github-api", { aliases: ["api.github.com"], listen: 443, target: "host.docker.internal", port: portOf(github.apiUrl) }),
    relay("actions-oidc", { aliases: [ACTIONS_OIDC_HOST], listen: 443, target: "host.docker.internal", port: othersPort }),
    relay("vendor", { aliases: [VENDOR_HOST], listen: 443, target: "host.docker.internal", port: othersPort }),
    relay("smtp", { aliases: [SMTP_HOST], listen: 25, target: "host.docker.internal", port: smtp.port }),
    relay("inbound", { listen: 3000, target: "app", port: 3000, publish: `127.0.0.1:${install.port}:3000` }),
  ];
  const watchedDns = (service: string, extra: string[] = []) =>
    [`  ${service}:`, `    dns: [${dns}]`, "    depends_on:", "      dns:", "        condition: service_started", ...extra].join("\n");
  writeFileSync(
    join(install.dir, "compose.override.yaml"),
    [
      "# Written by the egress test: the install in a network where only the stubs are reachable (tools/image-tests/src/isolated.ts).",
      "networks:",
      "  default:",
      "    internal: true",
      "    ipam:",
      "      config:",
      `        - subnet: ${subnet}`,
      "  outside: {}",
      "services:",
      watchedDns("postgres"),
      // The namespace the migrate step runs in, held by a container that stays up after the step ends.
      watchedDns("migrate-net", [`    image: ${NODE_IMAGE}`, '    command: ["node", "--eval", "setInterval(() => {}, 2 ** 30)"]', "    restart: unless-stopped"]),
      "  migrate:",
      '    network_mode: "service:migrate-net"',
      "    depends_on:",
      "      migrate-net:",
      "        condition: service_started",
      watchedDns("app", [
        ...["github-web", "github-api", "actions-oidc", "vendor", "smtp"].flatMap((name) => [`      ${name}:`, "        condition: service_started"]),
        "    ports: !reset []",
        "    environment:",
        "      NODE_EXTRA_CA_CERTS: /run/stubs/stubs.pem",
        "    volumes:",
        "      - ./stubs.pem:/run/stubs/stubs.pem:ro",
      ]),
      "  dns:",
      `    image: ${NODE_IMAGE}`,
      `    command: ["node", "--eval", ${JSON.stringify(DNS_LOGGER)}]`,
      "    networks:",
      "      default:",
      `        ipv4_address: ${dns}`,
      "    restart: unless-stopped",
      ...relays,
      "",
    ].join("\n"),
  );

  const webPort = portOf(github.webUrl);
  const apiPort = portOf(github.apiUrl);
  return {
    github,
    smtp,
    oidc,
    browserArgs: [
      `--host-resolver-rules=MAP github.com 127.0.0.1:${webPort}, MAP api.github.com 127.0.0.1:${apiPort}, MAP localhost 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${certificate.spkiSha256}`,
    ],
    received,
    serveClientMetadata(document) {
      clientMetadata = document;
    },
    dnsQueries() {
      return install
        .logs("dns")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as DnsQuery);
    },
    noRouteAttempts() {
      const counts = {} as Record<keyof typeof WATCHED_SERVICES, number>;
      for (const [service, container] of Object.entries(WATCHED_SERVICES) as [keyof typeof WATCHED_SERVICES, string][]) {
        const read = install.shell(`docker compose exec -T ${quote(container)} sh -c 'cat /proc/net/snmp; cat /proc/net/snmp6 2>/dev/null; true'`);
        if (read.status !== 0) throw new Error(`reading the network counters of ${service} failed: ${read.stderr}`);
        counts[service] = noRoutesIn(read.stdout);
      }
      return counts;
    },
    async close() {
      await new Promise((resolve) => others.close(resolve));
      await smtp.close();
      await github.close();
    },
  };
}

/** The connection attempts that found no route, IPv4's and IPv6's, from the text of /proc/net/snmp and /proc/net/snmp6. */
export function noRoutesIn(text: string): number {
  const lines = text.split("\n");
  const ip = lines.filter((line) => line.startsWith("Ip: "));
  const names = ip[0]?.trim().split(/\s+/) ?? [];
  const values = ip[1]?.trim().split(/\s+/) ?? [];
  const ipv4 = Number(values[names.indexOf("OutNoRoutes")]);
  if (!Number.isInteger(ipv4)) throw new Error(`no OutNoRoutes counter in /proc/net/snmp:\n${text}`);
  const ipv6 = Number(/^Ip6OutNoRoutes\s+(\d+)$/m.exec(text)?.[1] ?? "0");
  return ipv4 + ipv6;
}
