import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSET_FILES, assetDigest, assetUrl, createAssetRoute, mediaTypeOf, stylesheetWithVersions } from "../src/assets.ts";
import { ASSET_DIGESTS } from "../src/asset-digests.ts";

// The install's own assets (web-ui: The install serves its own assets; web-ui:
// Fonts served by the install; design.md, Design: The install's assets; D57
// (14)). The web role serves the stylesheet, the live hall's script, the icons,
// the manifest, the fonts and their license from packages/commands/assets/,
// to anyone, before setup too: an answer reads no session and sets no cookie.
// Each answer carries its exact media type, nosniff, Cross-Origin-Resource-
// Policy same-origin, a policy that makes an SVG opened as a page inert, and a
// strong ETag of its content, with 304 for a matching If-None-Match. Pages
// name each asset with ?v=<digest>, from a committed table: the current
// digest is cached for a year, any other answer is revalidated. Only the asset
// route reads the files, each once, on the first answer that needs it, from
// the folder the route is given.

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const ORIGIN = "https://tiehall.example.com";
const FONT = "/assets/fonts/IBMPlexSans-Regular-Latin1.woff2";
const LICENSE = "/assets/fonts/OFL.txt";
const STYLESHEET = "/assets/tiehall.css";
const POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";

const route = createAssetRoute({ folder: ASSETS });
const get = (path: string, init: RequestInit = {}) => route(new Request(`${ORIGIN}${path}`, init));

describe("the assets' media types", () => {
  it.each([
    ["tiehall.css", "text/css; charset=utf-8"],
    ["hall.js", "text/javascript; charset=utf-8"],
    ["icon.svg", "image/svg+xml"],
    ["icon-192.png", "image/png"],
    ["favicon.ico", "image/x-icon"],
    ["manifest.webmanifest", "application/manifest+json"],
    ["fonts/IBMPlexMono-Medium-Pi.woff2", "font/woff2"],
    ["fonts/OFL.txt", "text/plain; charset=utf-8"],
  ])("serves %s as %s", (file, type) => {
    expect(mediaTypeOf(file)).toBe(type);
  });

  it("serves the stylesheet, the fonts and their license", () => {
    expect(ASSET_FILES[STYLESHEET]).toBe("tiehall.css");
    expect(ASSET_FILES[FONT]).toBe("fonts/IBMPlexSans-Regular-Latin1.woff2");
    expect(ASSET_FILES[LICENSE]).toBe("fonts/OFL.txt");
  });
});

describe("the stylesheet's answer", () => {
  it("names each font by its served URL with its current digest", async () => {
    const answer = await get(assetUrl(STYLESHEET));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(answer.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const text = await answer.text();
    const urls = [...text.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(urls).toHaveLength(34);
    for (const url of urls) {
      const [path = "", version] = url.split("?v=");
      expect(ASSET_FILES[path], url).toBeDefined();
      expect(version, url).toBe(ASSET_DIGESTS[path]);
      expect(url).toBe(assetUrl(path));
    }
  });

  it("is the file with its url()s rewritten, and its ETag is the committed digest of what it serves", async () => {
    const file = await readFile(join(ASSETS, "tiehall.css"), "utf8");
    const answer = await get(STYLESHEET);
    const text = await answer.text();
    expect(text).toBe(stylesheetWithVersions(file));
    expect(text.replace(/\?v=[A-Za-z0-9_-]+/g, "").replaceAll('url("/assets/fonts/', 'url("fonts/')).toBe(file);
    expect(answer.headers.get("etag")).toBe(`"${ASSET_DIGESTS[STYLESHEET]}"`);
  });

  it("rewrites only url()s that name an asset of the install", () => {
    expect(stylesheetWithVersions('a { b: url("fonts/OFL.txt") } c { d: url("nothing.png") } e { f: url("/x.png") }', { "/assets/fonts/OFL.txt": "abc" })).toBe(
      'a { b: url("/assets/fonts/OFL.txt?v=abc") } c { d: url("nothing.png") } e { f: url("/x.png") }',
    );
  });
});

describe("an asset's answer", () => {
  it("is the file with its media type, nosniff, same-origin, an inert policy and a strong ETag of its content", async () => {
    const answer = await get(FONT);
    const body = new Uint8Array(await answer.arrayBuffer());
    expect(answer.status).toBe(200);
    expect(body).toEqual(new Uint8Array(await readFile(join(ASSETS, "fonts/IBMPlexSans-Regular-Latin1.woff2"))));
    expect(answer.headers.get("content-type")).toBe("font/woff2");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(answer.headers.get("content-security-policy")).toBe(POLICY);
    expect(answer.headers.get("etag")).toBe(`"${assetDigest(body)}"`);
    expect(answer.headers.get("etag")).not.toMatch(/^W\//);
  });

  it("serves the fonts' license as plain text with IBM's copyright notice", async () => {
    const answer = await get(LICENSE);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await answer.text()).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
  });

  it("is cached for a year at the current digest, and revalidated at any other URL of the asset", async () => {
    expect(assetUrl(FONT)).toBe(`${FONT}?v=${ASSET_DIGESTS[FONT]}`);
    expect((await get(assetUrl(FONT))).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const other of [FONT, `${FONT}?v=0000`, `${FONT}?v=`]) {
      const answer = await get(other);
      expect(answer.status, other).toBe(200);
      expect(answer.headers.get("cache-control"), other).toBe("no-cache");
    }
  });

  it("answers 304 with no body to an If-None-Match that names its ETag", async () => {
    const etag = (await get(FONT)).headers.get("etag") ?? "";
    for (const ifNoneMatch of [etag, `"other", ${etag}`, "*"]) {
      const again = await get(FONT, { headers: { "if-none-match": ifNoneMatch } });
      expect(again.status, ifNoneMatch).toBe(304);
      expect(await again.text()).toBe("");
      expect(again.headers.get("etag")).toBe(etag);
      expect(again.headers.get("content-security-policy")).toBe(POLICY);
    }
    expect((await get(FONT, { headers: { "if-none-match": '"other"' } })).status).toBe(200);
  });

  it("answers HEAD with the headers and no body", async () => {
    const answer = await get(LICENSE, { method: "HEAD" });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(answer.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(await answer.text()).toBe("");
  });

  it("reads no session and sets no cookie, whatever cookie the browser sends", async () => {
    const plain = await get(LICENSE);
    const withSession = await get(LICENSE, { headers: { cookie: "tiehall.session_token=abc.def; tiehall-setup=xyz" } });
    expect(withSession.headers.get("set-cookie")).toBeNull();
    expect(plain.headers.get("set-cookie")).toBeNull();
    expect(await withSession.text()).toBe(await plain.text());
  });

  it.each([
    ["GET", "/assets/nothing.css"],
    ["GET", "/assets/fonts/SOURCES.json"],
    ["GET", "/assets/fonts/../fonts/OFL.txt/x"],
    ["GET", "/assets/"],
    ["POST", LICENSE],
    ["PUT", FONT],
    ["DELETE", FONT],
  ])("answers %s %s with 404 route-not-found, as the error model gives it", async (method, path) => {
    const answer = await get(path, { method });
    expect(answer.status).toBe(404);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
    expect(answer.headers.get("content-security-policy")).toBe(POLICY);
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/route-not-found", status: 404 });
  });
});

describe("the files the route reads", () => {
  let folder: string;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "tiehall-assets-"));
    cpSync(join(ASSETS, "fonts"), join(folder, "fonts"), { recursive: true });
  });

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("are read from the folder the route is given, each once, on the first answer that needs it", async () => {
    writeFileSync(join(folder, "fonts", "OFL.txt"), "A license of the test's own.\n");
    const reads: string[] = [];
    const counted = createAssetRoute({
      folder,
      read: (path) => {
        reads.push(path);
        return readFile(path);
      },
    });
    expect(reads).toEqual([]);
    const first = await counted(new Request(`${ORIGIN}${LICENSE}`));
    expect(await first.text()).toBe("A license of the test's own.\n");
    // Its digest is not the committed one, so the committed URL is revalidated rather than kept for a year.
    expect((await counted(new Request(`${ORIGIN}${assetUrl(LICENSE)}`))).headers.get("cache-control")).toBe("no-cache");
    writeFileSync(join(folder, "fonts", "OFL.txt"), "Changed after the first answer.\n");
    expect(await (await counted(new Request(`${ORIGIN}${LICENSE}`))).text()).toBe("A license of the test's own.\n");
    await counted(new Request(`${ORIGIN}${LICENSE}`, { method: "HEAD" }));
    expect(reads).toEqual([join(folder, "fonts", "OFL.txt")]);
    await counted(new Request(`${ORIGIN}${FONT}`));
    expect(reads).toEqual([join(folder, "fonts", "OFL.txt"), join(folder, "fonts", "IBMPlexSans-Regular-Latin1.woff2")]);
  });

  it("are not read when the module is imported", () => {
    const module = pathToFileURL(fileURLToPath(new URL("../src/assets.ts", import.meta.url))).href;
    const probe = [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const read = [];",
      'for (const name of ["readFileSync", "readFile", "openSync", "open", "createReadStream"]) {',
      "  const original = fs[name];",
      "  fs[name] = (...args) => { read.push(String(args[0])); return original(...args); };",
      "}",
      "const readFile = fs.promises.readFile;",
      "fs.promises.readFile = (...args) => { read.push(String(args[0])); return readFile(...args); };",
      "syncBuiltinESMExports();",
      `await import(${JSON.stringify(module)});`,
      // Node reads the modules' own sources too, which are not assets.
      'console.log(JSON.stringify(read.filter((path) => path.includes("/packages/commands/assets/"))));',
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8", timeout: 20_000 });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual([]);
  });
});
