import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSET_FILES, createAssetRoute } from "../src/assets.ts";
import { FAVICON_SIDES, ICONS, MARK_CIRCLES, MARK_PATHS, markStroke, markSvg } from "../src/mark.ts";

// The mark, the favicon and the app icon (web-ui: The mark, the favicon and
// the app icon; web-ui: The install serves its own assets; design.md,
// Design: The mark and the icons; D57 (2), (10)). The mark TM1 is two paths
// and two circles in a 32 by 32 view box, drawn with round caps and joins; its
// stroke depends on the size it is drawn at, so the ring and the jack stay
// open, and its geometry never changes. The icon is the mark in white on an
// ink rounded square, the mark at 64 percent of the side. `pnpm
// icons:generate` renders the PNG icons and the favicon's images in the
// installed Chrome, each with the stroke of the size its mark is drawn at,
// and packs the favicon's three sizes into an ICO file.

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const read = (file: string) => readFileSync(`${ASSETS}${file}`);

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The attributes of the first element of this name in an SVG's text. */
function attributesOf(svg: string, element: string, index = 0): Record<string, string> {
  const tag = [...svg.matchAll(new RegExp(`<${element}\\b([^>]*)>`, "g"))][index]?.[1] ?? "";
  return Object.fromEntries([...tag.matchAll(/([A-Za-z-]+)="([^"]*)"/g)].map(([, name = "", value = ""]) => [name, value]));
}

describe("the mark", () => {
  it("is TM1: the two paths and the two circles of radius 2.4 in a 32 by 32 view box", () => {
    expect(MARK_PATHS).toEqual(["M6.5 16 V7 L16 15.5 L25.5 7 V16", "M16 17.9 V24"]);
    expect(MARK_CIRCLES).toEqual([
      { cx: 16, cy: 15.5, r: 2.4 },
      { cx: 16, cy: 26.6, r: 2.4 },
    ]);
  });

  it.each([
    [54, 2.5],
    [40, 2.5],
    [32, 2.5],
    [115.2, 2.5],
    [28, 2.75],
    [26, 2.75],
    [20.48, 2.75],
    [30.72, 2.75],
    [20, 2.75],
    [18, 2.75],
    [24, 3],
    [16, 3.5],
    [10.24, 3.5],
  ])("is drawn at %s pixels with a stroke of %s", (size, stroke) => {
    expect(markStroke(size)).toBe(stroke);
  });

  it("is drawn in its context's color, hidden from assistive technology, at the stroke of its size", () => {
    const svg = markSvg(18);
    expect(attributesOf(svg, "svg")).toMatchObject({
      viewBox: "0 0 32 32",
      width: "18",
      height: "18",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2.75",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    });
    expect([...svg.matchAll(/<path d="([^"]+)"/g)].map(([, d]) => d)).toEqual([...MARK_PATHS]);
    expect(svg).not.toContain("style");
  });
});

describe("the icons", () => {
  it("draw the mark in white on an ink rounded square, a quarter of its side round, the mark at 64 percent of it", () => {
    const svg = read("icon.svg").toString("utf8");
    const root = attributesOf(svg, "svg");
    const side = Number(root["width"]);
    expect(root["viewBox"]).toBe(`0 0 ${side} ${side}`);
    expect(attributesOf(svg, "rect")).toEqual({ width: String(side), height: String(side), rx: String(side / 4), fill: "#14161B" });
    const group = attributesOf(svg, "g");
    const [, x = "", y = "", scale = "1"] = /^translate\(([\d.]+) ([\d.]+)\)(?: scale\(([\d.]+)\))?$/.exec(group["transform"] ?? "") ?? [];
    expect((32 * Number(scale)) / side).toBeCloseTo(0.64, 10);
    expect(Number(x)).toBeCloseTo((side - 32 * Number(scale)) / 2, 10);
    expect(Number(y)).toBeCloseTo((side - 32 * Number(scale)) / 2, 10);
    expect(group).toMatchObject({ fill: "none", stroke: "#FFFFFF", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round" });
    expect([...svg.matchAll(/<path d="([^"]+)"\/>/g)].map(([, d]) => d)).toEqual([...MARK_PATHS]);
    expect([...svg.matchAll(/<circle ([^>]+)\/>/g)].map((_, index) => attributesOf(svg, "circle", index))).toEqual(
      MARK_CIRCLES.map(({ cx, cy, r }) => ({ cx: String(cx), cy: String(cy), r: String(r) })),
    );
    expect(svg.match(/<(path|circle|rect|g|svg)\b/g)?.sort()).toEqual(["<circle", "<circle", "<g", "<path", "<path", "<rect", "<svg"]);
  });

  it("are drawn by write-icons.ts at each size with the stroke of the size its mark is drawn at", () => {
    expect(ICONS).toEqual([
      { file: "icon-180.png", side: 180, rounded: false, stroke: 2.5 },
      { file: "icon-192.png", side: 192, rounded: true, stroke: 2.5 },
      { file: "icon-512.png", side: 512, rounded: true, stroke: 2.5 },
    ]);
    expect(FAVICON_SIDES.map((side) => [side, markStroke(side * 0.64)])).toEqual([
      [16, 3.5],
      [32, 2.75],
      [48, 2.75],
    ]);
  });

  it.each([
    ["icon-180.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ])("%s is %s pixels square", (file, side) => {
    expect(pngSize(read(file))).toEqual({ width: side, height: side });
  });

  it("put the favicon's PNG images of 16, 32 and 48 pixels in its ICO directory", () => {
    const ico = new Uint8Array(read("favicon.ico"));
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 3]);
    const images = [0, 1, 2].map((index) => {
      const entry = 6 + index * 16;
      const size = view.getUint32(entry + 8, true);
      const offset = view.getUint32(entry + 12, true);
      return { width: ico[entry] ?? 0, height: ico[entry + 1] ?? 0, planes: view.getUint16(entry + 4, true), bits: view.getUint16(entry + 6, true), png: ico.subarray(offset, offset + size) };
    });
    expect(images.map(({ width, height }) => [width, height])).toEqual([
      [16, 16],
      [32, 32],
      [48, 48],
    ]);
    for (const { width, planes, bits, png } of images) {
      expect([planes, bits]).toEqual([1, 32]);
      expect(pngSize(png)).toEqual({ width, height: width });
    }
  });

  it("are named by the manifest, which opens the install in the browser", () => {
    expect(JSON.parse(read("manifest.webmanifest").toString("utf8"))).toEqual({
      name: "Tiehall",
      short_name: "Tiehall",
      start_url: "/",
      scope: "/",
      display: "browser",
      background_color: "#F6F7F9",
      theme_color: "#14161B",
      icons: [
        { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  });

  it.each([
    ["/assets/icon.svg", "image/svg+xml"],
    ["/assets/icon-180.png", "image/png"],
    ["/assets/icon-192.png", "image/png"],
    ["/assets/icon-512.png", "image/png"],
    ["/assets/favicon.ico", "image/x-icon"],
    ["/assets/manifest.webmanifest", "application/manifest+json"],
  ])("are served by the asset route: %s as %s", async (path, type) => {
    expect(ASSET_FILES[path]).toBe(path.slice("/assets/".length));
    const answer = await createAssetRoute({ folder: ASSETS })(new Request(`https://tiehall.example.com${path}`));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe(type);
    expect(answer.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
  });
});
