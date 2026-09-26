import { pathToFileURL } from "node:url";
import type { AppSettings } from "@tiehall/commands";
import { installRequestGuard } from "./request-guard.ts";
import { TrustedProxies } from "./trusted-proxies.ts";

// The web role (design.md, Technical decisions: T1): the Next.js standalone
// server, loaded into this process behind the request guard, which rewrites
// each request's forwarded headers to the client the install trusts
// (self-host-install: `TIEHALL_URL` and TLS).

export interface WebRoleOptions {
  /** The standalone server that `next build` writes, which starts listening when it is loaded. */
  serverModule: string;
}

export async function runWebRole(settings: AppSettings, options: WebRoleOptions): Promise<void> {
  // Docker sets HOSTNAME to the container id; the server must listen on every interface.
  process.env["HOSTNAME"] = "0.0.0.0";
  process.env["PORT"] = String(settings.port);
  const proxies = new TrustedProxies(settings.trustedProxies);
  await proxies.refresh();
  installRequestGuard({ proxies });
  // The Next.js server handles SIGTERM itself: it finishes in-flight requests, then exits.
  await import(pathToFileURL(options.serverModule).href);
}
