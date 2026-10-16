import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPublic, loadPublicPaths } from "../src/public-paths.ts";

// The film the README shows (task 30.11; design.md, Decisions this change
// rests on: D38), "05 · Every Team's Line", which the maintainer chose on
// 2026-10-16: an encode of the 114 MB source, which stays outside the
// repository, small enough that GitHub's free plan also takes it as a video
// in a Markdown page, and its poster, the film's title frame. The check reads
// the MP4's boxes: an H.264 track of 1280 by 720 and an AAC track, the index
// (`moov`) before the media data (`mdat`), so a browser plays it while it
// downloads, about 53 seconds, and no metadata of the source; and the
// poster's size from its JPEG frame header. GP-4 of
// docs/maintainers/going-public.md gives the commands that made them.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FOLDER = "docs/assets/film";
const FILM = `${FOLDER}/every-teams-line.mp4`;
const POSTER = `${FOLDER}/every-teams-line-poster.jpg`;
const read = (file: string) => (existsSync(join(root, file)) ? new Uint8Array(readFileSync(join(root, file))) : new Uint8Array());

interface Box {
  type: string;
  /** Where the box starts, its header included. */
  start: number;
  size: number;
  /** Where its content starts, after its header. */
  body: number;
  children: Box[];
}

/** The boxes that hold other boxes, and the full boxes among them, whose children follow a version and flags. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts", "dinf", "meta"]);
const FULL_BOXES = new Set(["meta"]);

/** The boxes of an ISO base media file between two offsets, with the children of every container. */
function boxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    const type = new TextDecoder("latin1").decode(bytes.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    expect(size, `the ${type} box at ${at}`).toBeGreaterThanOrEqual(header);
    const body = at + header;
    const children = CONTAINERS.has(type) ? boxes(bytes, body + (FULL_BOXES.has(type) ? 4 : 0), at + size) : [];
    found.push({ type, start: at, size, body, children });
    at += size;
  }
  return found;
}

/** Every box under these, depth first. */
const all = (list: Box[]): Box[] => list.flatMap((box) => [box, ...all(box.children)]);

/** The first child of this type, by a path of types under a box. */
function child(box: Box | undefined, ...path: string[]): Box | undefined {
  return path.reduce<Box | undefined>((current, type) => current?.children.find((found) => found.type === type), box);
}

/** A track's handler type, `vide` or `soun`, its sample entry's format, and its width and height from its header. */
function track(bytes: Uint8Array, trak: Box): { handler: string; format: string; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => new TextDecoder("latin1").decode(bytes.subarray(at, at + 4));
  const hdlr = child(trak, "mdia", "hdlr");
  const stsd = child(trak, "mdia", "minf", "stbl", "stsd");
  const tkhd = child(trak, "tkhd");
  if (hdlr === undefined || stsd === undefined || tkhd === undefined) throw new Error("a track without its handler, sample description or header");
  // hdlr: version and flags, pre_defined, then the handler type. stsd: version and flags, the entry count, then the first entry's size and format.
  // tkhd of version 0 ends with the width and height, each a 16.16 number.
  const end = tkhd.start + tkhd.size;
  return { handler: text(hdlr.body + 8), format: text(stsd.body + 12), width: view.getUint32(end - 8) / 65536, height: view.getUint32(end - 4) / 65536 };
}

/** The film's length in seconds, from its movie header. */
function seconds(bytes: Uint8Array, moov: Box): number {
  const mvhd = child(moov, "mvhd");
  if (mvhd === undefined) throw new Error("no movie header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[mvhd.body] ?? 0;
  return version === 1
    ? Number(view.getBigUint64(mvhd.body + 24)) / view.getUint32(mvhd.body + 20)
    : view.getUint32(mvhd.body + 16) / view.getUint32(mvhd.body + 12);
}

/** A JPEG's width and height, from its start-of-frame segment. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at + 4 <= bytes.byteLength; ) {
    expect(bytes[at]).toBe(0xff);
    const marker = bytes[at + 1] ?? 0;
    const length = view.getUint16(at + 2);
    // SOF0 to SOF15, but DHT (C4), JPG (C8) and DAC (CC): precision, then the height and the width.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    at += 2 + length;
  }
  throw new Error("no start-of-frame segment");
}

describe("the film", () => {
  const bytes = read(FILM);
  const top = bytes.byteLength > 0 ? boxes(bytes) : [];
  const moov = top.find(({ type }) => type === "moov");

  it("is the MP4 and its poster in docs/assets/film/, which the allowlist holds, and nothing else", () => {
    expect(existsSync(join(root, FOLDER)) ? readdirSync(join(root, FOLDER)).sort() : []).toEqual(["every-teams-line-poster.jpg", "every-teams-line.mp4"]);
    const { patterns } = loadPublicPaths();
    expect([FILM, POSTER].filter((path) => !isPublic(path, patterns))).toEqual([]);
    expect([`${FOLDER}/source.mov`, `${FOLDER}/notes.md`, `${FOLDER}/every-teams-line.png`].filter((path) => isPublic(path, patterns))).toEqual([]);
  });

  it("is under 10 MB, which GitHub's free plan takes as a video in a Markdown page, and over 5 MB, which keeps its picture", () => {
    expect(bytes.byteLength).toBeGreaterThan(5_000_000);
    expect(bytes.byteLength).toBeLessThan(10_000_000);
  });

  it("puts its index before its media data, so it plays while it downloads", () => {
    const types = top.map(({ type }) => type);
    expect(types[0]).toBe("ftyp");
    expect(types).toContain("mdat");
    expect(types.indexOf("moov")).toBeGreaterThan(-1);
    expect(types.indexOf("moov")).toBeLessThan(types.indexOf("mdat"));
  });

  it("holds one H.264 track of 1280 by 720 and one AAC track, about 53 seconds long", () => {
    const tracks = (moov?.children ?? []).filter(({ type }) => type === "trak").map((trak) => track(bytes, trak));
    expect(tracks).toEqual([
      { handler: "vide", format: "avc1", width: 1280, height: 720 },
      { handler: "soun", format: "mp4a", width: 0, height: 0 },
    ]);
    expect(moov === undefined ? 0 : seconds(bytes, moov)).toBeCloseTo(53.3, 0);
  });

  it("carries none of its source's metadata: no title, encoder or other tag", () => {
    const under = all(moov?.children ?? []);
    // An empty list of tags, which the muxer writes, is a box of 8 bytes; a tag's box type starts with © or names it.
    expect(under.filter(({ type, size }) => type === "ilst" && size !== 8).map(({ size }) => size)).toEqual([]);
    expect(under.filter(({ type }) => type.startsWith("©") || ["name", "titl", "auth", "cprt", "desc", "date", "loci", "XMP_"].includes(type)).map(({ type }) => type)).toEqual([]);
  });
});

describe("the film's poster", () => {
  it("is a JPEG of 1280 by 720 pixels under 300 KB", () => {
    const bytes = read(POSTER);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThan(300_000);
    expect(jpegSize(bytes)).toEqual({ width: 1280, height: 720 });
  });
});
