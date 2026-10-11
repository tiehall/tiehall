// Tiehall's mark, TM1 (web-ui: The mark, the favicon and the app icon;
// design.md, Design: The mark and the icons; D57 (2), (10); D59 (3)): in a
// 32 by 32 view box, a sharp M whose middle vertex is a round junction ring,
// from which a T stem drops to a jack, a tie line between two switchboards.
// From afar it reads as a T, up close as an M. Its geometry never changes;
// its stroke depends on the size it is drawn at, so the ring and the jack
// stay open. The pages draw it inline, in the color of its context, beside
// the name Tiehall, hidden from assistive technology; the icons draw it in
// gold on a navy rounded square, at 64 percent of the square's side.

/** The mark's two paths: the M with its middle vertex at the ring, and the T stem down to the jack. */
export const MARK_PATHS = ["M6.5 16 V7 L16 15.5 L25.5 7 V16", "M16 17.9 V24"] as const;
/** The junction ring and the jack. */
export const MARK_CIRCLES = [
  { cx: 16, cy: 15.5, r: 2.4 },
  { cx: 16, cy: 26.6, r: 2.4 },
] as const;

/** The stroke the mark is drawn with at a size in pixels: 2.5 at 32 and more, 3 at 24, 3.5 at 16 and less, 2.75 at every other size under 32. */
export function markStroke(size: number): number {
  if (size >= 32) return 2.5;
  if (size === 24) return 3;
  if (size <= 16) return 3.5;
  return 2.75;
}

/** The mark's paths and circles, as SVG elements. */
function markElements(): string {
  return [...MARK_PATHS.map((d) => `<path d="${d}"/>`), ...MARK_CIRCLES.map(({ cx, cy, r }) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`)].join("");
}

/** The mark as a page draws it inline at this size in pixels, in the color of its context, hidden from assistive technology. */
export function markSvg(size: number): string {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${markStroke(size)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${markElements()}</svg>`;
}

/** The icon's navy tile and the mark's gold, D59's broken warm gold. */
export const ICON_TILE = "#0A1428";
export const ICON_MARK = "#E3B341";

/** The share of the icon's side the mark takes. */
const MARK_SHARE = 0.64;

/**
 * The icon at this side in pixels: the mark in gold on a navy square, with
 * corners a quarter of its side round unless the square is full, as the touch
 * icon is, which the phone rounds itself; the mark at 64 percent of the side,
 * centered, with the stroke of the size it is drawn at, or the one given.
 */
export function iconSvg(side: number, options: { rounded?: boolean; stroke?: number } = {}): string {
  const scale = (side * MARK_SHARE) / 32;
  const offset = (side - 32 * scale) / 2;
  const transform = scale === 1 ? `translate(${offset} ${offset})` : `translate(${offset} ${offset}) scale(${scale})`;
  const stroke = options.stroke ?? markStroke(side * MARK_SHARE);
  const rx = options.rounded === false ? "" : ` rx="${side / 4}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}">`,
    `<rect width="${side}" height="${side}"${rx} fill="${ICON_TILE}"/>`,
    `<g transform="${transform}" fill="none" stroke="${ICON_MARK}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">`,
    markElements(),
    "</g></svg>",
  ].join("");
}

/** The side of /assets/icon.svg, whose mark, at 32 of its 50 units, is 64 percent of it. */
export const ICON_SVG_SIDE = 50;

/** The PNG icons: the touch icon, a full square the phone rounds itself, and the manifest's two, rounded, the mark inside their middle 80 percent. */
export const ICONS: readonly { file: string; side: number; rounded: boolean; stroke: number }[] = [
  { file: "icon-180.png", side: 180, rounded: false, stroke: markStroke(180 * MARK_SHARE) },
  { file: "icon-192.png", side: 192, rounded: true, stroke: markStroke(192 * MARK_SHARE) },
  { file: "icon-512.png", side: 512, rounded: true, stroke: markStroke(512 * MARK_SHARE) },
];

/** The sides of the favicon's images, which /favicon.ico holds as PNG images. */
export const FAVICON_SIDES = [16, 32, 48] as const;
