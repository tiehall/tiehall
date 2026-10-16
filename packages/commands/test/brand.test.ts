import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_IMAGES, BRAND_SVGS, FONT_SANS, SOCIAL_PREVIEW_COLORS, TAGLINE } from "../src/brand.ts";
import { ICON_MARK, ICON_TILE, iconSvg, MARK_CIRCLES, MARK_PATHS } from "../src/mark.ts";
import { parseCss } from "./support/css.ts";
import { attributesOf, iconColors, isColor, pngPixels, pngSize, rgb } from "./support/images.ts";

// The brand's images in docs/assets/brand/ (task 30.10; design.md, Decisions
// this change rests on: D38), which the README, the organization's profile
// and the repository's social preview show: the mark TM1 on its navy tile,
// and on its own in the tile's navy for light backgrounds and in gold for
// dark ones, each as an SVG and a PNG; the organization's avatar; and the
// social preview, with the name and the tagline. They are drawn from the
// mark's own source, packages/commands/src/mark.ts, so they match the
// install's icons, and `pnpm brand:generate` renders the PNG images in the
// installed Chrome, as `pnpm icons:generate` renders the icons. The social
// preview sets its text in the web UI's system font stack, in the dark
// theme's colors.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FOLDER = `${ROOT}docs/assets/brand/`;
const read = (file: string) => new Uint8Array(readFileSync(`${FOLDER}${file}`));
const text = (file: string) => readFileSync(`${FOLDER}${file}`, "utf8");

const NAVY = rgb(ICON_TILE);
const GOLD = rgb(ICON_MARK);

/** The paths' d attributes and the circles of an SVG's text. */
function shapes(svg: string): { paths: string[]; circles: Record<string, string>[] } {
  return {
    paths: [...svg.matchAll(/<path d="([^"]+)"\/>/g)].map(([, d = ""]) => d),
    circles: [...svg.matchAll(/<circle /g)].map((_, index) => attributesOf(svg, "circle", index)),
  };
}

const MARK_SHAPES = {
  paths: [...MARK_PATHS],
  circles: MARK_CIRCLES.map(({ cx, cy, r }) => ({ cx: String(cx), cy: String(cy), r: String(r) })),
};

/** The custom properties of a rule of the install's stylesheet, by the rule's selector and the at-rules it sits in. */
function tokens(selector: string, context: string[]): Record<string, string> {
  const sheet = parseCss(readFileSync(fileURLToPath(new URL("../assets/tiehall.css", import.meta.url)), "utf8"));
  const rules = sheet.rules.filter((rule) => rule.selector === selector && JSON.stringify(rule.context) === JSON.stringify(context));
  return Object.fromEntries(rules.flatMap(({ declarations }) => declarations.map(({ property, value }) => [property, value])));
}

describe("the brand's images", () => {
  it("are the SVG and PNG files the brand lists, and nothing else", () => {
    const files = [...Object.keys(BRAND_SVGS), ...BRAND_IMAGES.map(({ file }) => file)].sort();
    expect(files).toEqual([
      "avatar.png",
      "mark-on-dark.png",
      "mark-on-dark.svg",
      "mark-on-light.png",
      "mark-on-light.svg",
      "mark.png",
      "mark.svg",
      "social-preview.png",
    ]);
    expect(existsSync(FOLDER) ? readdirSync(FOLDER).sort() : []).toEqual(files);
  });

  it("draw the mark on its tile as the install's icon does, and on its own in navy and in gold", () => {
    expect(text("mark.svg")).toBe(`${iconSvg(128)}\n`);
    for (const [file, color] of [
      ["mark-on-light.svg", ICON_TILE],
      ["mark-on-dark.svg", ICON_MARK],
    ] as const) {
      const svg = text(file);
      expect(attributesOf(svg, "svg"), file).toMatchObject({
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 32 32",
        fill: "none",
        stroke: color,
        "stroke-width": "2.5",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      expect(shapes(svg), file).toEqual(MARK_SHAPES);
      expect(svg.match(/<(\w+)\b/g)?.sort(), file).toEqual(["<circle", "<circle", "<path", "<path", "<svg"]);
    }
    for (const [file, svg] of Object.entries(BRAND_SVGS)) expect(text(file), file).toBe(`${svg}\n`);
  });

  it.each([
    ["mark.png", 512, 512],
    ["mark-on-light.png", 512, 512],
    ["mark-on-dark.png", 512, 512],
    ["avatar.png", 500, 500],
    ["social-preview.png", 1280, 640],
  ])("render %s at %s by %s pixels", (file, width, height) => {
    expect(pngSize(read(file))).toEqual({ width, height });
    expect(BRAND_IMAGES.find((image) => image.file === file)).toMatchObject({ width, height });
  });

  it("render the mark gold on its navy tile, the avatar's tile a full square that GitHub rounds", () => {
    for (const file of ["mark.png", "avatar.png"]) {
      const { tile, brightest } = iconColors(read(file));
      expect(isColor(tile, NAVY), `${file}: tile ${tile.join(",")}`).toBe(true);
      expect(isColor(brightest, GOLD), `${file}: mark ${brightest.join(",")}`).toBe(true);
    }
    expect(pngPixels(read("mark.png")).at(0, 0)[3]).toBe(0);
    expect(isColor(pngPixels(read("avatar.png")).at(0, 0), NAVY)).toBe(true);
  });

  it.each([
    ["mark-on-light.png", ICON_TILE],
    ["mark-on-dark.png", ICON_MARK],
  ])("render %s as the mark alone in %s, on a transparent ground", (file, color) => {
    const { width, height, at } = pngPixels(read(file));
    expect(at(0, 0)[3]).toBe(0);
    let inColor = 0;
    let other = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const pixel = at(x, y);
      if (pixel[3] === 255) isColor(pixel, rgb(color)) ? (inColor += 1) : (other += 1);
    }
    // The mark's stroke covers a few percent of the square; its edges are partly transparent, never another color.
    expect(inColor).toBeGreaterThan(width * height * 0.03);
    expect(other).toBe(0);
  });

  it("render the social preview under 1 MB: the mark on its tile, the name and the tagline, on the navy ground", () => {
    expect(statSync(`${FOLDER}social-preview.png`).size).toBeLessThan(1_000_000);
    const { width, height, at } = pngPixels(read("social-preview.png"));
    expect(isColor(at(2, 2), rgb(SOCIAL_PREVIEW_COLORS.ground))).toBe(true);
    const seen = (color: string) => {
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (isColor(at(x, y), rgb(color))) return true;
      return false;
    };
    expect(seen(ICON_MARK), "the mark's gold").toBe(true);
    expect(seen(SOCIAL_PREVIEW_COLORS.name), "the name's ink").toBe(true);
    expect(TAGLINE).toBe("Every team’s line, in one hall.");
  });

  it("set the social preview's text in the web UI's fonts and colors: the system font stack and the dark theme's inks", () => {
    expect(FONT_SANS).toBe(tokens(":root", [])["--font-sans"]);
    const dark = tokens(":root", ["@media (prefers-color-scheme: dark)"]);
    expect(SOCIAL_PREVIEW_COLORS).toEqual({ ground: dark["--ground"], name: dark["--ink"], tagline: dark["--ink-2"], edge: dark["--border"] });
    expect(tokens(":root", [])).toMatchObject({ "--mark-tile": ICON_TILE, "--mark-ink": ICON_MARK });
  });

  it("are written by `pnpm brand:generate`", () => {
    const { scripts } = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { scripts: Record<string, string> };
    expect(scripts["brand:generate"]).toBe("node packages/commands/src/write-brand.ts");
  });
});
