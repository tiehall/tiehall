import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { BlockList, connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { JIRA_SITE_URL } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";

// Tiehall's outbound calls (agent-safety: Outbound fetches refuse internal
// addresses; self-host-install: No telemetry and a documented list of outbound
// connections; design.md, Technical decisions: T14; design.md, Self-hosting
// decisions: S8 and S13).
//
// The fetcher is for the one kind of content Tiehall fetches from an address
// a caller names: Client ID Metadata Documents (webhooks may use it later). A
// caller could name an address inside the install's network, such as the
// cloud's metadata service, so the fetcher:
// - takes only https URLs without credentials in them;
// - resolves the host name itself, once, and refuses the host when any address
//   it resolves to is not public: loopback, private, link-local, the cloud
//   metadata addresses, the shared address space, multicast, reserved and
//   documentation ranges, and every IPv6 address outside global unicast; an
//   IPv4 address written as IPv6 is judged as IPv4;
// - connects only to the address it checked, so a name that resolves
//   elsewhere a moment later changes nothing, with TLS verified for the host
//   name;
// - follows at most three redirects, checking each target the same way before
//   it connects, so a redirect to an internal address is refused unfollowed;
// - reads at most maxBytes of the answer, within timeoutMs.
// A refused fetch throws OutboundRefused, whose message is server text.
//
// GitHub and Jira calls never go through it: they go only to GitHub's own
// hosts and to the connected Jira site. createGitHubFetch() and
// createJiraFetch() wrap the fetch those clients use and refuse any other
// origin before the call; a Jira site URL that is not of the form
// https://<name>.atlassian.net is refused as invalid input, as the input schema
// of the operation that connects Jira refuses it.

/** Why an outbound call was refused. */
export type OutboundRefusalReason = "url" | "address" | "redirect" | "size" | "timeout" | "unreachable" | "host";

/** An outbound call Tiehall refused to make or to finish. */
export class OutboundRefused extends Error {
  override name = "OutboundRefused";
  readonly reason: OutboundRefusalReason;
  constructor(reason: OutboundRefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Where the fetcher connects: the address it checked, and the host name it checked it for. */
export interface ConnectTarget {
  address: string;
  port: number;
  hostname: string;
  tls: boolean;
}

export interface OutboundFetcherOptions {
  /** Resolves a host name to its addresses; the system resolver unless a test gives one. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Opens a connection to a checked address, speaking TLS for https; the system's unless a test gives one. */
  connect?: (target: ConnectTarget) => Duplex;
  /** How long a fetch may take, all of it; 5 seconds unless given. */
  timeoutMs?: number;
  /** How many bytes of an answer it reads; 64 KiB unless given. */
  maxBytes?: number;
  /** How many redirects it follows; 3 unless given. */
  maxRedirects?: number;
}

/** A fetched document. */
export interface FetchedDocument {
  /** Where it came from, after any redirect. */
  url: string;
  status: number;
  contentType: string | undefined;
  body: string;
}

export type OutboundFetcher = (url: string) => Promise<FetchedDocument>;

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export function createOutboundFetcher(options: OutboundFetcherOptions = {}): OutboundFetcher {
  const resolve = options.resolve ?? systemResolve;
  const connect = options.connect ?? systemConnect;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;

  return async function fetchDocument(url) {
    let target = httpsUrl(url);
    for (let redirects = 0; ; redirects++) {
      const address = await checkedAddress(target.hostname.replace(/^\[|\]$/g, ""), resolve);
      const answer = await get(target, { address, port: Number(target.port || 443), hostname: target.hostname.replace(/^\[|\]$/g, ""), tls: true }, connect, timeoutMs, maxBytes);
      if (!REDIRECTS.has(answer.status)) {
        return { url: target.toString(), status: answer.status, contentType: answer.contentType, body: answer.body };
      }
      if (redirects >= maxRedirects) throw new OutboundRefused("redirect", `Tiehall follows at most ${maxRedirects} redirects.`);
      if (answer.location === undefined) throw new OutboundRefused("redirect", "A redirect names no location.");
      target = httpsUrl(new URL(answer.location, target).toString());
    }
  };
}

/** An https URL without credentials; anything else is refused. */
function httpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundRefused("url", "Tiehall fetches only https URLs.");
  }
  if (url.protocol !== "https:" || url.hostname === "") throw new OutboundRefused("url", "Tiehall fetches only https URLs.");
  if (url.username !== "" || url.password !== "") throw new OutboundRefused("url", "Tiehall fetches no URL that carries credentials.");
  return url;
}

/** The address to connect to for a host: the host itself when it is an address, or its first; refused unless every one is public. */
async function checkedAddress(host: string, resolve: (hostname: string) => Promise<string[]>): Promise<string> {
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      addresses = [];
    }
  }
  const [first] = addresses;
  if (first === undefined || !addresses.every(isPublicAddress)) {
    throw new OutboundRefused("address", "Tiehall fetches only from public addresses, and this host has another.");
  }
  return first;
}

async function systemResolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

function systemConnect({ address, port, hostname, tls }: ConnectTarget): Duplex {
  if (!tls) return netConnect({ host: address, port });
  // The certificate is checked against the host name, while the connection goes to the checked address.
  return tlsConnect({ host: address, port, ...(isIP(hostname) === 0 ? { servername: hostname } : {}), ALPNProtocols: ["http/1.1"] });
}

interface Answer {
  status: number;
  contentType: string | undefined;
  location: string | undefined;
  body: string;
}

/** One GET over a connection to the checked address. */
function get(url: URL, target: ConnectTarget, connect: (target: ConnectTarget) => Duplex, timeoutMs: number, maxBytes: number): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const socket = connect(target);
    const request = httpRequest({
      createConnection: () => socket as never,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, accept: "application/json", "user-agent": "Tiehall" },
    });
    const fail = (error: OutboundRefused) => {
      clearTimeout(timer);
      request.destroy();
      socket.destroy();
      reject(error);
    };
    const timer: NodeJS.Timeout = setTimeout(() => fail(new OutboundRefused("timeout", `The fetch took longer than ${timeoutMs} ms.`)), timeoutMs);
    request.on("error", () => fail(new OutboundRefused("unreachable", "The host could not be reached.")));
    request.on("response", (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) fail(new OutboundRefused("size", `The answer is larger than ${maxBytes} bytes.`));
        else chunks.push(chunk);
      });
      response.on("error", () => fail(new OutboundRefused("unreachable", "The answer broke off.")));
      response.on("end", () => {
        clearTimeout(timer);
        socket.destroy();
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"],
          location: typeof location === "string" ? location : undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.end();
  });
}

// Addresses that are not public. IPv4: this network, private, shared, loopback,
// link-local (the cloud metadata address 169.254.169.254 among them), the IETF
// protocol assignments, the documentation and benchmarking ranges, the old
// 6to4 relay, multicast and reserved. IPv6: everything outside global unicast
// (2000::/3), which leaves out loopback, unique local (fd00:ec2::254, a cloud
// metadata address, among them), link-local, multicast, NAT64 and addresses
// written with IPv4 inside; and, within it, Teredo and the other protocol
// assignments, 6to4, and the documentation ranges.
const IPV4_NOT_PUBLIC = subnets("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);
const IPV6_GLOBAL_UNICAST = subnets("ipv6", [["2000::", 3]]);
const IPV6_NOT_PUBLIC = subnets("ipv6", [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]);

function subnets(type: "ipv4" | "ipv6", list: readonly [string, number][]): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix] of list) blockList.addSubnet(network, prefix, type);
  return blockList;
}

/** Whether an address is public, so that Tiehall may connect to it. */
export function isPublicAddress(address: string): boolean {
  try {
    switch (isIP(address)) {
      case 4:
        return !IPV4_NOT_PUBLIC.check(address, "ipv4");
      case 6: {
        const mapped = mappedIPv4(address);
        if (mapped !== undefined) return isPublicAddress(mapped);
        return IPV6_GLOBAL_UNICAST.check(address, "ipv6") && !IPV6_NOT_PUBLIC.check(address, "ipv6");
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d) holds; undefined for any other. */
function mappedIPv4(address: string): string | undefined {
  const normal = new URL(`http://[${address}]/`).hostname;
  const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(normal);
  if (match === null) return undefined;
  const high = Number.parseInt(match[1] ?? "", 16);
  const low = Number.parseInt(match[2] ?? "", 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** A fetch, as GitHub's and Jira's clients take one. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function urlOf(input: string | URL | Request): URL {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    throw new OutboundRefused("host", "An outbound call names a URL.");
  }
}

/** GitHub's own hosts, the only ones GitHub calls go to: its API and, for the sign-in flow, its web host. */
export const GITHUB_ORIGINS: ReadonlySet<string> = new Set(["https://api.github.com", "https://github.com"]);

/** A fetch that calls only GitHub's own hosts, over https; any other call is refused before it is made. */
export function createGitHubFetch(fetchImpl: Fetch = fetch): Fetch {
  return async (input, init) => {
    const url = urlOf(input);
    if (!GITHUB_ORIGINS.has(url.origin) || url.username !== "" || url.password !== "") {
      throw new OutboundRefused("host", "GitHub calls go only to GitHub's own hosts.");
    }
    return fetchImpl(input, init);
  };
}

/**
 * GitHub Actions' OIDC issuer, the one GitHub host besides its API and web
 * that Tiehall calls: to read the public keys that sign the tokens of CI runs
 * (agent-access: CI authenticates with GitHub Actions OIDC bound to
 * registered repositories).
 */
export const GITHUB_ACTIONS_OIDC_ORIGIN = "https://token.actions.githubusercontent.com";

/** A fetch that calls only GitHub Actions' OIDC issuer, over https; any other call is refused before it is made. */
export function createGitHubActionsFetch(fetchImpl: Fetch = fetch): Fetch {
  return async (input, init) => {
    const url = urlOf(input);
    if (url.origin !== GITHUB_ACTIONS_OIDC_ORIGIN || url.username !== "" || url.password !== "") {
      throw new OutboundRefused("host", "The keys of GitHub Actions' tokens are read only from GitHub Actions' OIDC issuer.");
    }
    return fetchImpl(input, init);
  };
}

/**
 * A fetch that calls only the connected Jira site. A site URL that is not of
 * the form https://<name>.atlassian.net is refused as invalid input, before
 * any call.
 */
export function createJiraFetch(siteUrl: string, fetchImpl: Fetch = fetch): Fetch {
  if (!JIRA_SITE_URL.test(siteUrl)) {
    const message = "A Jira site URL has the form https://<name>.atlassian.net.";
    throw new Refusal("invalid-input", message, { issues: [{ path: ["siteUrl"], message }] });
  }
  const origin = new URL(siteUrl).origin;
  return async (input, init) => {
    const url = urlOf(input);
    if (url.origin !== origin || url.username !== "" || url.password !== "") {
      throw new OutboundRefused("host", "Jira calls go only to the connected Jira site.");
    }
    return fetchImpl(input, init);
  };
}
