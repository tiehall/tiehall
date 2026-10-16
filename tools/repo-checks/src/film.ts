// The README's film (task 30.11; design.md, Decisions this change rests on:
// D38 (1), (2)), "05 · Every Team's Line". The repository holds its poster
// alone; the encode stays outside it and is uploaded at the switch to public
// as the README's attachment, where GitHub's player plays it (GP-4 and GP-19
// of docs/maintainers/going-public.md). These read what the checks need: an
// encode's ISO base media boxes, from which encodeProblems() says whether it
// is the film the README can play, and a JPEG's frame size, for the poster.
// They use only Node built-ins.

/** What an encode of the film must be: GitHub's free plan takes a video in a Markdown page only under 10 MB. */
export const FILM = {
  maxBytes: 10_000_000,
  /** Below this the picture of 53 seconds at 1280 by 720 suffers. */
  minBytes: 5_000_000,
  width: 1280,
  height: 720,
  seconds: 53.3,
} as const;

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

const typeAt = (bytes: Uint8Array, at: number) => new TextDecoder("latin1").decode(bytes.subarray(at, at + 4));
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The boxes of an ISO base media file between two offsets, with the children of every container; throws on a box that runs past its end. */
function boxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Box[] {
  const data = view(bytes);
  const found: Box[] = [];
  for (let at = start; at + 8 <= end; ) {
    let size = data.getUint32(at);
    const type = typeAt(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) throw new Error(`the ${type} box at byte ${at} runs past the end of its file or box`);
      size = Number(data.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new Error(`the ${type} box at byte ${at} runs past the end of its file or box`);
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
  const hdlr = child(trak, "mdia", "hdlr");
  const stsd = child(trak, "mdia", "minf", "stbl", "stsd");
  const tkhd = child(trak, "tkhd");
  if (hdlr === undefined || stsd === undefined || tkhd === undefined) return { handler: "none", format: "none", width: 0, height: 0 };
  // hdlr: version and flags, pre_defined, then the handler type. stsd: version and flags, the entry count, then the first entry's size and format.
  // tkhd ends with the width and height, each a 16.16 number.
  const end = tkhd.start + tkhd.size;
  return {
    handler: typeAt(bytes, hdlr.body + 8),
    format: typeAt(bytes, stsd.body + 12),
    width: view(bytes).getUint32(end - 8) / 65536,
    height: view(bytes).getUint32(end - 4) / 65536,
  };
}

/** The film's length in seconds, from its movie header. */
function seconds(bytes: Uint8Array, moov: Box): number | undefined {
  const mvhd = child(moov, "mvhd");
  if (mvhd === undefined) return undefined;
  const data = view(bytes);
  return bytes[mvhd.body] === 1
    ? Number(data.getBigUint64(mvhd.body + 24)) / data.getUint32(mvhd.body + 20)
    : data.getUint32(mvhd.body + 16) / data.getUint32(mvhd.body + 12);
}

/** The tag boxes that name a title, an author, an encoder or the like: a type that starts with © or names one. */
const TAGS = new Set(["name", "titl", "auth", "cprt", "desc", "date", "loci", "XMP_"]);

/**
 * What keeps this encode from being the film the README plays, each in a
 * sentence, or nothing: a size GitHub's free plan takes and the picture keeps,
 * the index (`moov`) before the media data (`mdat`) so that it plays while it
 * downloads, one H.264 track of 1280 by 720 and one AAC track, about 53
 * seconds, and none of its source's metadata.
 */
export function encodeProblems(bytes: Uint8Array): string[] {
  let top: Box[];
  try {
    top = boxes(bytes);
  } catch (error) {
    return [`It is no whole MP4 file: ${(error as Error).message}.`];
  }
  const problems: string[] = [];
  const megabytes = (bytes.byteLength / 1_000_000).toFixed(1);
  if (bytes.byteLength >= FILM.maxBytes) problems.push(`It is ${megabytes} MB; GitHub's free plan takes a video in a Markdown page only under 10 MB.`);
  if (bytes.byteLength <= FILM.minBytes) problems.push(`It is ${megabytes} MB; an encode over 5 MB keeps the film's picture.`);

  const types = top.map(({ type }) => type);
  if (types[0] !== "ftyp") problems.push("It does not start with an ftyp box.");
  const moov = top.find(({ type }) => type === "moov");
  if (moov === undefined || !types.includes("mdat") || types.indexOf("moov") > types.indexOf("mdat")) {
    problems.push("Its index (moov) does not come before its media data (mdat), so it would not play while it downloads: encode it with -movflags +faststart.");
  }
  if (moov === undefined) return problems;

  const tracks = moov.children.filter(({ type }) => type === "trak").map((trak) => track(bytes, trak));
  const video = tracks.filter(({ handler }) => handler === "vide");
  const audio = tracks.filter(({ handler }) => handler === "soun");
  if (tracks.length !== 2 || video.length !== 1 || audio.length !== 1) {
    problems.push(`It holds ${video.length} video and ${audio.length} audio tracks of ${tracks.length}; the film has one H.264 track and one AAC track.`);
  }
  for (const { format, width, height } of video) {
    if (format !== "avc1") problems.push(`Its video track is ${format}, not H.264 (avc1).`);
    if (width !== FILM.width || height !== FILM.height) problems.push(`Its video track is ${width} by ${height}, not 1280 by 720.`);
  }
  for (const { format } of audio) if (format !== "mp4a") problems.push(`Its audio track is ${format}, not AAC (mp4a).`);

  const length = seconds(bytes, moov);
  if (length === undefined || Math.abs(length - FILM.seconds) >= 0.5) {
    problems.push(`It is ${length === undefined ? "of no length its movie header gives" : `${length.toFixed(1)} seconds long`}, not about 53.3 seconds, the film's length.`);
  }

  const under = all(moov.children);
  // An empty list of tags, which the muxer writes, is a box of 8 bytes.
  const tags = under.filter(({ type, size }) => (type === "ilst" && size !== 8) || type.startsWith("©") || TAGS.has(type));
  if (tags.length > 0) {
    problems.push(`It carries metadata of its source (${[...new Set(tags.map(({ type }) => type))].join(", ")}): encode it with -map_metadata -1.`);
  }
  return problems;
}

/** A JPEG's width and height, from its start-of-frame segment; throws when it holds none. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("no JPEG: it does not start with a start-of-image marker");
  const data = view(bytes);
  for (let at = 2; at + 4 <= bytes.byteLength; ) {
    if (bytes[at] !== 0xff) throw new Error(`no JPEG segment at byte ${at}`);
    const marker = bytes[at + 1] ?? 0;
    const length = data.getUint16(at + 2);
    // SOF0 to SOF15, but DHT (C4), JPG (C8) and DAC (CC): precision, then the height and the width.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: data.getUint16(at + 5), width: data.getUint16(at + 7) };
    at += 2 + length;
  }
  throw new Error("no start-of-frame segment");
}
