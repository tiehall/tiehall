import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetUrl } from "../src/assets.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The install's assets in the web app as the image runs it (web-ui: The
// install serves its own assets; web-ui: Text in the system's fonts;
// self-host-install: The setup code guards the setup screen; design.md,
// Design: The install's assets; D57 (14); D61 (1)). The asset route reads the files
// from packages/commands/assets/, which next.config.ts carries into the
// standalone output beside apps/web, two folders up from the folder the
// standalone server runs in; the setup gate lets them through before setup,
// to a browser without a session, so the setup screen has its look.

let install: TestInstall;
let web: WebApp;

beforeAll(async () => {
  install = await startTestInstall();
  // As at an install's first start: the org exists, unnamed, and setup is not complete.
  await install.owner.query("UPDATE orgs SET name = NULL, setup_completed_at = NULL");
  web = await startWebApp(install);
}, 300_000);

afterAll(async () => {
  await web?.close();
  await install?.close();
}, 60_000);

describe("the web app's assets, before setup", () => {
  it("serves the stylesheet from the standalone output, to a browser without a session, naming no font and no other file", async () => {
    const stylesheet = await web.fetch(assetUrl("/assets/tiehall.css"));
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(stylesheet.headers.get("x-content-type-options")).toBe("nosniff");
    expect(stylesheet.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(stylesheet.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(stylesheet.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(stylesheet.headers.get("set-cookie")).toBeNull();
    const text = await stylesheet.text();
    expect(text).toContain("--font-sans: system-ui,");
    expect(text).not.toMatch(/@font-face|url\(/);
  });

  it("serves no font and no font license", async () => {
    for (const path of ["/assets/fonts/OFL.txt", "/assets/fonts/IBMPlexSans-Regular-Latin1.woff2"]) {
      const answer = await web.fetch(path);
      expect(answer.status, path).toBe(404);
      expect(answer.headers.get("location"), path).toBeNull();
    }
  });

  it("serves /favicon.ico, rewritten to the asset route with its query, and the icons and the manifest", async () => {
    for (const path of ["/favicon.ico", assetUrl("/favicon.ico")]) {
      const favicon = await web.fetch(path);
      expect(favicon.status, path).toBe(200);
      expect(favicon.headers.get("content-type"), path).toBe("image/x-icon");
      expect(favicon.headers.get("content-security-policy"), path).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
      expect(favicon.headers.get("cache-control"), path).toBe(path === "/favicon.ico" ? "no-cache" : "public, max-age=31536000, immutable");
    }
    for (const [path, type] of [
      ["/assets/icon.svg", "image/svg+xml"],
      ["/assets/icon-180.png", "image/png"],
      ["/assets/manifest.webmanifest", "application/manifest+json"],
    ]) {
      const answer = await web.fetch(path ?? "");
      expect(answer.status, path).toBe(200);
      expect(answer.headers.get("content-type"), path).toBe(type);
    }
  });

  it("keeps the current version for a year, and answers a revalidation with 304", async () => {
    const current = await web.fetch(assetUrl("/assets/icon-192.png"));
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = current.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const again = await web.fetch("/assets/icon-192.png", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("answers a path that names no asset, and a POST, with 404, and leads no asset path to /setup", async () => {
    for (const answer of [await web.fetch("/assets/nothing.css"), await web.fetch("/assets/tiehall.css", { method: "POST", body: "x" })]) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get("content-type")).toBe("application/problem+json");
      expect(answer.headers.get("location")).toBeNull();
    }
    // Every other page still leads to the setup screen.
    expect((await web.fetch("/inbox")).headers.get("location")).toMatch(/\/setup$/);
  });
});
