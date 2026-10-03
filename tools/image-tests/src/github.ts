import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createTestCertificate } from "@tiehall/testing/tls";
import type { Install } from "./install.ts";

// GitHub, played by the GitHub stub, for an install that Compose runs
// (self-host-install: Compose runs Tiehall and Postgres; self-host-install:
// Setup names the company and makes the first admin; design.md, Technical
// decisions: T17). The install runs the release image unchanged: it calls
// https://github.com and https://api.github.com, as it does at any install.
// A Compose override in the install's folder, compose.override.yaml, which
// `docker compose` reads beside compose.yaml, puts two small TCP relays on the
// install's network under the names github.com and api.github.com, which pass
// each connection on to the stub on the host, and has the app trust the
// stub's certificate, NODE_EXTRA_CA_CERTS being Node's own way to add one. The
// operator's browser reaches the same stub through host-resolver rules, and
// trusts its certificate by its key. So the install talks to GitHub only
// through its production code, and to nothing else.

/** The Node base image the Tiehall image is built on, pinned by digest, which runs the relays. */
export const NODE_IMAGE = (() => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../../../Dockerfile", import.meta.url)), "utf8");
  const image = /^FROM (node:\S+@sha256:[0-9a-f]{64}) AS base$/m.exec(dockerfile)?.[1];
  if (image === undefined) throw new Error("the Dockerfile names no Node base image pinned by digest");
  return image;
})();

/** A relay on the install's network that listens on 443 and passes each connection on to the host's port. */
const RELAY = [
  'const net = require("node:net");',
  "const port = Number(process.env.TARGET_PORT);",
  "net.createServer((client) => {",
  '  const upstream = net.connect(port, "host.docker.internal");',
  "  client.pipe(upstream).pipe(client);",
  '  client.on("error", () => upstream.destroy());',
  '  upstream.on("error", () => client.destroy());',
  "}).listen(443);",
].join(" ");

export interface StubbedGitHub {
  stub: GitHubStub;
  /** The launch arguments that send a browser's calls to github.com to the stub and trust its certificate. */
  browserArgs: string[];
  close(): Promise<void>;
}

/**
 * Starts the GitHub stub over HTTPS, listening where the install's containers
 * reach it through the host's gateway, and writes the install's Compose
 * override that points github.com and api.github.com at it.
 */
export async function stubGitHubFor(install: Install): Promise<StubbedGitHub> {
  const certificate = createTestCertificate({ dnsNames: ["github.com", "api.github.com"], ipAddresses: ["127.0.0.1"] });
  const stub = await startGitHubStub({ tls: { key: certificate.key, cert: certificate.cert }, listenHost: "0.0.0.0" });
  const port = (url: string) => new URL(url).port;
  writeFileSync(join(install.dir, "github-stub.pem"), certificate.cert, { mode: 0o644 });
  const relay = (name: string, alias: string, target: string) =>
    [
      `  ${name}:`,
      `    image: ${NODE_IMAGE}`,
      `    command: ["node", "--eval", ${JSON.stringify(RELAY)}]`,
      "    environment:",
      `      TARGET_PORT: "${target}"`,
      "    extra_hosts:",
      '      - "host.docker.internal:host-gateway"',
      "    networks:",
      "      default:",
      `        aliases: [${alias}]`,
    ].join("\n");
  writeFileSync(
    join(install.dir, "compose.override.yaml"),
    [
      "# Written by the operator tests: GitHub is the stub on the host (tools/image-tests/src/github.ts).",
      "services:",
      "  app:",
      "    environment:",
      "      NODE_EXTRA_CA_CERTS: /run/github-stub/github-stub.pem",
      "    volumes:",
      "      - ./github-stub.pem:/run/github-stub/github-stub.pem:ro",
      relay("github-web", "github.com", port(stub.webUrl)),
      relay("github-api", "api.github.com", port(stub.apiUrl)),
      "",
    ].join("\n"),
  );
  return {
    stub,
    browserArgs: [
      `--host-resolver-rules=MAP github.com 127.0.0.1:${port(stub.webUrl)}, MAP api.github.com 127.0.0.1:${port(stub.apiUrl)}, MAP localhost 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${certificate.spkiSha256}`,
    ],
    close: () => stub.close(),
  };
}
