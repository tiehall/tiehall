import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";

// The reverse proxies whose forwarded headers the install trusts
// (self-host-install: `TIEHALL_URL` and TLS; design.md, Self-hosting
// decisions: S2): the IP addresses, CIDR ranges and host names that
// TIEHALL_TRUSTED_PROXIES names. A host name, such as the Compose service
// name `caddy`, stands for the addresses it resolves to; they are looked up
// when the web role starts, and again when a request that carries forwarded
// headers arrives from an address that is not trusted, at most once every
// few seconds, so a proxy that restarts with a new address is trusted again.

export interface TrustedProxiesOptions {
  /** Resolves a host name to its addresses; the system resolver unless a test replaces it. */
  resolve?: (name: string) => Promise<string[]>;
  /** How long after one lookup of the names another may run. */
  refreshIntervalMs?: number;
}

export class TrustedProxies {
  readonly #fixed = new BlockList();
  readonly #names: readonly string[];
  readonly #resolve: (name: string) => Promise<string[]>;
  readonly #refreshIntervalMs: number;
  #resolved = new BlockList();
  #lastRefresh = 0;
  #refreshing: Promise<void> | undefined;

  constructor(entries: readonly string[], options: TrustedProxiesOptions = {}) {
    const names: string[] = [];
    for (const entry of entries) {
      const [address = "", prefix] = entry.split("/");
      const family = isIP(address) === 6 ? "ipv6" : "ipv4";
      if (prefix !== undefined) this.#fixed.addSubnet(address, Number(prefix), family);
      else if (isIP(address) !== 0) this.#fixed.addAddress(address, family);
      else names.push(entry);
    }
    this.#names = names;
    this.#resolve = options.resolve ?? resolveName;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
  }

  /** Whether an address is one of the trusted proxies, as the names last resolved. */
  isTrusted(address: string): boolean {
    const plain = unmapped(address);
    const family = isIP(plain);
    if (family === 0) return false;
    const type = family === 6 ? "ipv6" : "ipv4";
    return this.#fixed.check(plain, type) || this.#resolved.check(plain, type);
  }

  /** Looks the names up again; a name that does not resolve stands for no address. */
  async refresh(): Promise<void> {
    if (this.#names.length === 0) return;
    this.#refreshing ??= (async () => {
      this.#lastRefresh = Date.now();
      const resolved = new BlockList();
      for (const name of this.#names) {
        const addresses = await this.#resolve(name).catch(() => []);
        for (const address of addresses) {
          const plain = unmapped(address);
          if (isIP(plain) !== 0) resolved.addAddress(plain, isIP(plain) === 6 ? "ipv6" : "ipv4");
        }
      }
      this.#resolved = resolved;
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** Looks the names up again in the background, unless that happened within the refresh interval. */
  refreshSoon(): void {
    if (this.#names.length === 0 || Date.now() - this.#lastRefresh < this.#refreshIntervalMs) return;
    void this.refresh();
  }
}

async function resolveName(name: string): Promise<string[]> {
  return (await lookup(name, { all: true })).map(({ address }) => address);
}

/** An IPv4 address that a dual-stack socket reports mapped into IPv6, as plain IPv4. */
function unmapped(address: string): string {
  return address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

export interface ForwardedClient {
  /** The address of the client, as far back as the trusted proxies vouch for it. */
  address: string;
  scheme: "http" | "https";
}

/** The first value of a header, as one string. */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * The client of a request that came from `peer` over a connection that is or
 * is not TLS. Forwarded headers count only from a trusted proxy: X-Forwarded-For
 * is read from the right, one hop at a time, while each hop is a trusted proxy,
 * and the first address that is not one is the client; X-Forwarded-Proto gives
 * the scheme the client used, as its first value.
 */
export function forwardedClient(peer: string, headers: IncomingHttpHeaders, tls: boolean, proxies: TrustedProxies): ForwardedClient {
  const own: ForwardedClient = { address: unmapped(peer), scheme: tls ? "https" : "http" };
  if (!proxies.isTrusted(peer)) return own;
  const hops = (header(headers, "x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  let address = own.address;
  for (const hop of hops.reverse()) {
    const plain = unmapped(hop);
    // A hop that is not an address cannot be followed: the last trusted hop is as far back as the chain goes.
    if (isIP(plain) === 0) break;
    address = plain;
    if (!proxies.isTrusted(plain)) break;
  }
  const proto = (header(headers, "x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  return { address, scheme: proto === "https" || proto === "http" ? proto : own.scheme };
}
