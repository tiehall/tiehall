// Small readers of images for the tests of the icons and the brand's images
// (web-ui: The mark, the favicon and the app icon; task 30.10): a PNG's size
// from its IHDR chunk, its pixels, decoded from the 8-bit, non-interlaced RGB
// or RGBA image data that Chrome writes, and the attributes of an SVG's
// elements.
import { inflateSync } from "node:zlib";
import { expect } from "vitest";

/** A pixel as red, green, blue and alpha, each 0 to 255. */
export type Pixel = [number, number, number, number];

/** A PNG's width and height, from its IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A PNG's pixels as RGBA, decoded from its 8-bit, non-interlaced RGB or RGBA image data, as Chrome writes them. */
export function pngPixels(bytes: Uint8Array): { width: number; height: number; at: (x: number, y: number) => Pixel } {
  const { width, height } = pngSize(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [depth, colorType, interlace] = [bytes[24], bytes[25], bytes[28]];
  expect([depth, interlace]).toEqual([8, 0]);
  expect([2, 6]).toContain(colorType);
  const channels = colorType === 6 ? 4 : 3;
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.byteLength; ) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const data = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const raw = data[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      const paeth = () => {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      };
      const predicted = [0, left, up, (left + up) >> 1, paeth()][filter ?? 0] ?? 0;
      pixels[y * stride + x] = (raw + predicted) & 255;
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const start = y * stride + x * channels;
      return [pixels[start] ?? 0, pixels[start + 1] ?? 0, pixels[start + 2] ?? 0, channels === 4 ? (pixels[start + 3] ?? 0) : 255];
    },
  };
}

/** Whether a pixel is this color, opaque, within a step or two of rounding. */
export const isColor = ([r, g, b, a]: readonly number[], color: readonly number[]) =>
  a === 255 && [r, g, b].every((channel, index) => Math.abs((channel ?? 0) - (color[index] ?? 0)) <= 2);

/** A color written as #RRGGBB, as its red, green and blue. */
export function rgb(hex: string): [number, number, number] {
  const value = /^#([0-9A-Fa-f]{6})$/.exec(hex)?.[1];
  if (value === undefined) throw new Error(`not a color: ${hex}`);
  return [0, 2, 4].map((start) => Number.parseInt(value.slice(start, start + 2), 16)) as [number, number, number];
}

/** The colors of an icon or an image, read from its pixels: the pixel at this point, by default on the tile above the mark, and the brightest opaque pixel. */
export function iconColors(bytes: Uint8Array, point?: { x: number; y: number }): { tile: Pixel; brightest: Pixel } {
  const { width, height, at } = pngPixels(bytes);
  let brightest: Pixel = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const pixel = at(x, y);
    if (pixel[3] === 255 && pixel[0] + pixel[1] + pixel[2] > brightest[0] + brightest[1] + brightest[2]) brightest = pixel;
  }
  // The middle of the side, a tenth of the way down: on the tile, above the mark, which starts at 32 percent.
  return { tile: point === undefined ? at(Math.floor(width / 2), Math.floor(height / 10)) : at(point.x, point.y), brightest };
}

/** The attributes of the first element of this name in an SVG's text, or of the one at this index. */
export function attributesOf(svg: string, element: string, index = 0): Record<string, string> {
  const tag = [...svg.matchAll(new RegExp(`<${element}\\b([^>]*)>`, "g"))][index]?.[1] ?? "";
  return Object.fromEntries([...tag.matchAll(/([A-Za-z-]+)="([^"]*)"/g)].map(([, name = "", value = ""]) => [name, value]));
}
