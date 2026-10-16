// The brand's images in docs/assets/brand/ (task 30.10; design.md, Decisions
// this change rests on: D38), which the README, the organization's profile
// and the repository's social preview show. Each is drawn from the mark's own
// source, mark.ts, so it matches the install's icons: the mark on its navy
// tile, as the icons draw it; the mark on its own, in the tile's navy for
// light backgrounds and in gold for dark ones; the organization's avatar, the
// mark on a full navy square, which GitHub rounds itself; and the social
// preview, the mark on its tile beside the name Tiehall, with the tagline of
// the setup screen and the film below, on the dark theme's navy ground, its
// text set in the web UI's system font stack (D61 (1)), so it takes the
// system font of the machine that renders it, as every page of the web UI
// does. `pnpm brand:generate` writes the SVG files and renders the PNG images
// in the installed Chrome (write-brand.ts); the files are committed.
import type { PngPage } from "./chrome-png.ts";
import { ICON_MARK, ICON_TILE, iconSvg, markElements, markStroke } from "./mark.ts";

/** The web UI's system font stack, `--font-sans` of assets/tiehall.css. */
export const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** The tagline of the setup screen and the film, with the apostrophe of set type. */
export const TAGLINE = "Every team’s line, in one hall.";

/** The social preview's colors, the dark theme's: its ground, the name's ink, the tagline's ink and the tile's edge. */
export const SOCIAL_PREVIEW_COLORS = { ground: "#0A1428", name: "#E9EDF5", tagline: "#A9B3C8", edge: "#24345A" } as const;

/** The mark on its own at this size in pixels, in one color, as a file of its own. */
export function bareMarkSvg(size: number, color: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="none" stroke="${color}"`,
    ` stroke-width="${markStroke(size)}" stroke-linecap="round" stroke-linejoin="round">${markElements()}</svg>`,
  ].join("");
}

/** The side, in pixels, that the SVG files name as their size; they scale to any other. */
const SVG_SIDE = 128;

/** The SVG files, by name: the mark on its tile, and alone in navy for light backgrounds and in gold for dark ones. */
export const BRAND_SVGS: Readonly<Record<string, string>> = {
  "mark.svg": iconSvg(SVG_SIDE),
  "mark-on-light.svg": bareMarkSvg(SVG_SIDE, ICON_TILE),
  "mark-on-dark.svg": bareMarkSvg(SVG_SIDE, ICON_MARK),
};

/** The social preview: the mark on its tile beside the name, the tagline below, on a navy ground with a faint grid of dots. */
function socialPreview(): PngPage {
  const tile = 168;
  const { ground, name, tagline, edge } = SOCIAL_PREVIEW_COLORS;
  const css = [
    `body{width:1280px;height:640px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;`,
    `background:${ground} radial-gradient(circle,${edge} 1.5px,transparent 2px) 12px 12px/32px 32px;font-family:${FONT_SANS}}`,
    `.lockup{display:flex;align-items:center;gap:44px}`,
    `.tile{border-radius:${tile / 4}px;box-shadow:0 0 0 2px ${edge},0 0 72px ${ICON_MARK}2E}`,
    `.name{margin:0;color:${name};font-size:136px;font-weight:700;letter-spacing:-0.02em;line-height:1}`,
    `.tagline{margin:52px 0 0;color:${tagline};font-size:44px;font-weight:400;line-height:1.2}`,
  ].join("");
  const body = `<div class="lockup"><div class="tile">${iconSvg(tile)}</div><p class="name">Tiehall</p></div><p class="tagline">${TAGLINE}</p>`;
  return { body, css, width: 1280, height: 640 };
}

/** A PNG image of the brand: its file and the page it is rendered from, at exactly its size. */
export interface BrandImage extends PngPage {
  file: string;
}

/** The PNG images: the mark on its tile and alone in navy and in gold, the organization's avatar and the social preview. */
export const BRAND_IMAGES: readonly BrandImage[] = [
  { file: "mark.png", width: 512, height: 512, body: iconSvg(512) },
  { file: "mark-on-light.png", width: 512, height: 512, body: bareMarkSvg(512, ICON_TILE) },
  { file: "mark-on-dark.png", width: 512, height: 512, body: bareMarkSvg(512, ICON_MARK) },
  { file: "avatar.png", width: 500, height: 500, body: iconSvg(500, { rounded: false }) },
  { file: "social-preview.png", ...socialPreview() },
];
