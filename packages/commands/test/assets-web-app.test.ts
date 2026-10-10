import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetUrl } from "../src/assets.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The install's assets in the web app as the image runs it (web-ui: The
// install serves its own assets; web-ui: Fonts served by the install;
// self-host-install: The setup code guards the setup screen; design.md,
// Design: The install's assets; D57 (14)). The asset route reads the files
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
  it("serves a font and the fonts' license from the standalone output, to a browser without a session", async () => {
    const font = await web.fetch("/assets/fonts/IBMPlexSans-Regular-Latin1.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("x-content-type-options")).toBe("nosniff");
    expect(font.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(font.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(font.headers.get("cache-control")).toBe("no-cache");
    expect(font.headers.get("set-cookie")).toBeNull();
    expect(new TextDecoder().decode((await font.arrayBuffer()).slice(0, 4))).toBe("wOF2");
    const license = await web.fetch("/assets/fonts/OFL.txt");
    expect(license.status).toBe(200);
    expect(await license.text()).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
  });

  it("serves the stylesheet, which names each font by its current digest, and each of them", async () => {
    const stylesheet = await web.fetch(assetUrl("/assets/tiehall.css"));
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(stylesheet.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const urls = [...(await stylesheet.text()).matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(urls).toHaveLength(34);
    for (const url of urls) {
      const font = await web.fetch(url);
      expect(font.status, url).toBe(200);
      expect(font.headers.get("cache-control"), url).toBe("public, max-age=31536000, immutable");
    }
  });

  it("keeps the current version for a year, and answers a revalidation with 304", async () => {
    const current = await web.fetch(assetUrl("/assets/fonts/IBMPlexMono-Regular-Latin1.woff2"));
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = current.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const again = await web.fetch("/assets/fonts/IBMPlexMono-Regular-Latin1.woff2", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("answers a path that names no asset, and a POST, with 404, and leads no asset path to /setup", async () => {
    for (const answer of [await web.fetch("/assets/nothing.css"), await web.fetch("/assets/fonts/OFL.txt", { method: "POST", body: "x" })]) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get("content-type")).toBe("application/problem+json");
      expect(answer.headers.get("location")).toBeNull();
    }
    // Every other page still leads to the setup screen.
    expect((await web.fetch("/inbox")).headers.get("location")).toMatch(/\/setup$/);
  });
});
