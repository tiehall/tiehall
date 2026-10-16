import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeProblems, jpegSize } from "../src/film.ts";
import { isPublic, loadPublicPaths, trackedFiles } from "../src/public-paths.ts";

// The film the README shows (task 30.11; design.md, Decisions this change
// rests on: D38 (1), (2)), "05 · Every Team's Line", which the maintainer
// chose on 2026-10-16. The repository holds its poster alone, the film's
// title frame, as the maintainer answered on 2026-10-16: the encode, made
// from a 114 MB source that also stays outside the repository, is uploaded at
// the switch as the README's attachment, where GitHub's player plays it (GP-4
// and GP-19 of docs/maintainers/going-public.md). Before that upload,
// tools/repo-checks/src/check-film.ts checks the encode, given its path
// outside the repository: an H.264 track of 1280 by 720 and an AAC track, the
// index before the media data, about 53 seconds, no metadata of the source,
// and a size GitHub's free plan takes. The check reads the poster in the tree,
// and the encode's checks on encodes it builds box by box.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FOLDER = "docs/assets/film";
const ENCODE = `${FOLDER}/every-teams-line.mp4`;
const POSTER = `${FOLDER}/every-teams-line-poster.jpg`;
const CHECK = "tools/repo-checks/src/check-film.ts";

describe("the film in the repository", () => {
  it("is its poster alone in docs/assets/film/, which the allowlist holds, while the encode stays out", () => {
    const listed = existsSync(join(root, FOLDER)) ? readdirSync(join(root, FOLDER)).filter((file) => !file.startsWith(".")) : [];
    expect(listed).toEqual(["every-teams-line-poster.jpg"]);
    const { patterns } = loadPublicPaths();
    expect(isPublic(POSTER, patterns)).toBe(true);
    expect([ENCODE, `${FOLDER}/source.mov`, `${FOLDER}/notes.md`, `${FOLDER}/every-teams-line.png`].filter((path) => isPublic(path, patterns))).toEqual([]);
  });

  it("holds no video anywhere: the encode is the README's attachment, uploaded at the switch", () => {
    expect(trackedFiles(root).filter((path) => /\.(?:mp4|m4v|mov|webm|mkv|avi)$/i.test(path))).toEqual([]);
  });
});

describe("the film's poster", () => {
  it("is a JPEG of 1280 by 720 pixels under 300 KB", () => {
    const bytes = existsSync(join(root, POSTER)) ? new Uint8Array(readFileSync(join(root, POSTER))) : new Uint8Array();
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThan(300_000);
    expect(jpegSize(bytes)).toEqual({ width: 1280, height: 720 });
  });
});

// Encodes built box by box: the boxes the check reads, with the media data's
// box sized to make the file as large as a real encode.

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
/** A box: its size, its type of four latin1 characters, then its content. */
const box = (type: string, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([u32(8 + body.byteLength), Buffer.from(type, "latin1"), body]);
};
/** A full box's version and flags. */
const VERSION_0 = Buffer.alloc(4);

interface Track {
  handler: string;
  format: string;
  width: number;
  height: number;
}

/** A track: its header, ending with its width and height as 16.16 numbers, its handler, and its first sample entry. */
const trak = ({ handler, format, width, height }: Track) =>
  box(
    "trak",
    box("tkhd", VERSION_0, Buffer.alloc(20 + 8 + 8 + 36), u32(width * 65536), u32(height * 65536)),
    box(
      "mdia",
      box("hdlr", VERSION_0, u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(12), Buffer.from([0])),
      box("minf", box("stbl", box("stsd", VERSION_0, u32(1), box(format, Buffer.alloc(6), u16(1))))),
    ),
  );

const VIDEO: Track = { handler: "vide", format: "avc1", width: 1280, height: 720 };
const AUDIO: Track = { handler: "soun", format: "mp4a", width: 0, height: 0 };

interface Encode {
  tracks?: Track[];
  /** The length in milliseconds. */
  length?: number;
  /** The boxes of the list of tags, which the muxer writes empty. */
  tags?: Buffer[];
  /** The media data's size in bytes. */
  media?: number;
  /** Whether the index comes after the media data. */
  indexLast?: boolean;
}

/** An encode as ffmpeg writes the film's: ftyp, the index, then the media data. */
function encode({ tracks = [VIDEO, AUDIO], length = 53_300, tags = [], media = 9_000_000, indexLast = false }: Encode = {}): Uint8Array {
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(512), Buffer.from("isomiso2avc1mp41", "latin1"));
  const moov = box(
    "moov",
    box("mvhd", VERSION_0, u32(0), u32(0), u32(1000), u32(length), Buffer.alloc(80)),
    ...tracks.map(trak),
    box("udta", box("meta", VERSION_0, box("hdlr", VERSION_0, u32(0), Buffer.from("mdir", "latin1"), Buffer.alloc(12), Buffer.from([0])), box("ilst", ...tags))),
  );
  const mdat = box("mdat", Buffer.alloc(media));
  return new Uint8Array(Buffer.concat(indexLast ? [ftyp, mdat, moov] : [ftyp, moov, mdat]));
}

describe("the check of the film's encode", () => {
  it("passes an encode like the film's", () => {
    expect(encodeProblems(encode())).toEqual([]);
  });

  it("wants it under 10 MB, which GitHub's free plan takes as a video in a Markdown page, and over 5 MB, which keeps its picture", () => {
    expect(encodeProblems(encode({ media: 10_000_000 })).join("\n")).toMatch(/under 10 MB/);
    expect(encodeProblems(encode({ media: 1_000_000 })).join("\n")).toMatch(/over 5 MB/);
  });

  it("wants its index before its media data, so it plays while it downloads", () => {
    expect(encodeProblems(encode({ indexLast: true })).join("\n")).toMatch(/index .*before .*media data/);
  });

  it("wants one H.264 track of 1280 by 720 and one AAC track, about 53 seconds long", () => {
    expect(encodeProblems(encode({ tracks: [{ ...VIDEO, width: 1920, height: 1080 }, AUDIO] })).join("\n")).toMatch(/1280 by 720/);
    expect(encodeProblems(encode({ tracks: [{ ...VIDEO, format: "hvc1" }, AUDIO] })).join("\n")).toMatch(/H\.264/);
    expect(encodeProblems(encode({ tracks: [VIDEO] })).join("\n")).toMatch(/AAC/);
    expect(encodeProblems(encode({ length: 60_000 })).join("\n")).toMatch(/53\.3 seconds/);
  });

  it("wants none of its source's metadata: no title, encoder or other tag", () => {
    const title = box("©nam", box("data", u32(1), u32(0), Buffer.from("Every Team's Line", "latin1")));
    expect(encodeProblems(encode({ tags: [title] })).join("\n")).toMatch(/metadata/);
  });

  it("names a box that runs past the end of the file, as a cut-off upload would", () => {
    const whole = encode();
    expect(encodeProblems(whole.subarray(0, whole.byteLength - 10)).join("\n")).toMatch(/runs past the end/);
  });
});

describe("the film's check on an encode outside the repository", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-film-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, CHECK), ...args], { cwd: root, encoding: "utf8" });

  it("passes an encode like the film's, and fails one that GitHub would not play while it downloads", () => {
    const good = join(scratch, "every-teams-line.mp4");
    writeFileSync(good, encode());
    const passed = run(good);
    expect(passed.stderr).toBe("");
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("every-teams-line.mp4");

    const late = join(scratch, "late-index.mp4");
    writeFileSync(late, encode({ indexLast: true }));
    const failed = run(late);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/index .*before .*media data/);
  });

  it("refuses an encode inside the repository, which holds the poster alone, and a call without one", () => {
    const inside = run(join(root, ENCODE));
    expect(inside.status).toBe(2);
    expect(inside.stderr).toMatch(/outside the repository/);
    expect(run().status).toBe(2);
  });
});
