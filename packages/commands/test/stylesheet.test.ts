import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, parseCss, selectorsOf, type CssRule } from "./support/css.ts";

// The install's one stylesheet (web-ui: One stylesheet with named design
// tokens; web-ui: A request's state looks the same everywhere; web-ui: Light
// and dark themes follow the system; web-ui: Motion, and reduced motion;
// web-ui: Fonts served by the install; web-ui: Pages are accessible;
// design.md, Design: The design tokens; design.md, Design: Request states;
// design.md, Design: Light and dark themes; design.md, Design: Motion and
// reduced motion; design.md, Design: Type and the self-hosted fonts; D57 (1),
// (3), (5), (6), (8)). Every color is a named token, with its value in the
// light theme, the dark theme and the live hall; every pair of text and
// background contrasts at least 4.5:1 and every lamp at least 3:1 on each
// background it may sit on, computed here from the tokens; motion outside the
// live hall ends within 5 seconds, the hall's loops run only once its script
// runs, and reduced motion stops everything; IBM's fonts are declared as IBM
// declares them, with no local() source.

const STYLESHEET = fileURLToPath(new URL("../assets/tiehall.css", import.meta.url));
const SOURCES = fileURLToPath(new URL("../assets/fonts/SOURCES.json", import.meta.url));
const css = parseCss(readFileSync(STYLESHEET, "utf8"));

/** The design tokens' values, light and dark, as design.md's tables give them; the live hall takes the dark ones. */
const TOKENS: Readonly<Record<string, readonly [light: string | undefined, dark: string]>> = {
  "--ink": ["#14161B", "#E8EAF0"],
  "--ink-2": ["#4A5060", "#8A93A6"],
  "--line": ["#2B4ACB", "#9DB2FF"],
  "--line-hover": ["#1E3596", "#C9D4FF"],
  "--button": ["#2B4ACB", "#4C69E6"],
  "--button-ink": ["#FFFFFF", "#FFFFFF"],
  "--signal": ["#F2B33D", "#F2B33D"],
  "--on-signal": ["#14161B", "#14161B"],
  "--lamp-open": ["#7A8294", "#8A93A6"],
  "--lamp-claimed": ["#4C69E6", "#9DB2FF"],
  "--lamp-in-progress": ["#2B4ACB", "#4C69E6"],
  "--lamp-needs-info": ["#B26B00", "#F2B33D"],
  "--lamp-done": ["#1E8A4C", "#4ADE80"],
  "--ground": ["#F6F7F9", "#0E1117"],
  "--surface": ["#FFFFFF", "#151A23"],
  "--surface-2": ["#EEF0F4", "#1C2230"],
  "--border": ["#E3E6EB", "#2A3040"],
  "--control-border": ["#7A8294", "#6B7385"],
  "--notice": ["#FCEFD2", "#3A2C10"],
  "--notice-ink": ["#7A4A00", "#F2C66D"],
  // The live hall is always dark, so the light theme has no "Live" lamp.
  "--live": [undefined, "#4ADE80"],
  "--chip-open": ["#EEF0F4", "#232938"],
  "--chip-open-ink": ["#3B4252", "#C9CFDB"],
  "--chip-claimed": ["#E6EBFB", "#1A2340"],
  "--chip-claimed-ink": ["#1E3596", "#B7C6FF"],
  "--chip-in-progress": ["#2B4ACB", "#4C69E6"],
  "--chip-in-progress-ink": ["#FFFFFF", "#FFFFFF"],
  "--chip-needs-info": ["#FCEFD2", "#3A2C10"],
  "--chip-needs-info-ink": ["#7A4A00", "#F2C66D"],
  "--chip-done": ["#DDF1E6", "#12301F"],
  "--chip-done-ink": ["#145A37", "#7EE2A3"],
  "--chip-declined": ["#F1F2F4", "#202530"],
  "--chip-declined-ink": ["#5B6170", "#A3ABBD"],
  "--chip-withdrawn": ["#F1F2F4", "#202530"],
  "--chip-withdrawn-ink": ["#5B6170", "#A3ABBD"],
  "--mark-tile": ["#14161B", "#2B4ACB"],
  "--mark-ink": ["#FFFFFF", "#FFFFFF"],
};

const STATES = ["open", "claimed", "in-progress", "needs-info", "done", "declined", "withdrawn"] as const;
const LAMP_STATES = ["open", "claimed", "in-progress", "needs-info", "done"] as const;

const DARK = "@media (prefers-color-scheme: dark)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";
const FORCED = "@media (forced-colors: active)";

/** The custom properties the rules that match `which` declare, by name. */
function tokensOf(which: (rule: CssRule) => boolean): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const rule of css.rules.filter(which)) for (const { property, value } of rule.declarations) if (property.startsWith("--")) tokens[property] = value;
  return tokens;
}

const light = tokensOf((rule) => rule.selector === ":root" && rule.context.length === 0);
const dark = tokensOf((rule) => rule.selector === ":root" && rule.context.length === 1 && rule.context[0] === DARK);
const hall = tokensOf((rule) => rule.selector === ".hall" && rule.context.length === 0);
const THEMES = { light, dark, hall } as const;

/** A token's value as a color, upper case; it fails the test when the theme has none. */
function color(theme: Record<string, string>, token: string): string {
  const value = theme[token];
  expect(value, token).toMatch(/^#[0-9A-Fa-f]{6}$/);
  return (value ?? "").toUpperCase();
}

/** Whether a rule is the live hall's own: one whose every selector starts with .hall. */
const inHall = (rule: CssRule) => selectorsOf(rule).every((selector) => selector.startsWith(".hall"));

describe("the design tokens", () => {
  it.each(Object.entries(TOKENS))("%s has its value in the light theme, the dark theme and the live hall", (token, [lightValue, darkValue]) => {
    if (lightValue === undefined) expect(light[token]).toBeUndefined();
    else expect(light[token]?.toUpperCase(), "light").toBe(lightValue);
    expect(dark[token]?.toUpperCase(), "dark").toBe(darkValue);
    expect(hall[token]?.toUpperCase(), "the live hall").toBe(darkValue);
  });

  it("are the only place a color is written: every color literal is a token's value", () => {
    const literal = /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|gray|grey)\b/;
    const outside = css.rules.flatMap((rule) =>
      rule.declarations.filter(({ property, value }) => !property.startsWith("--") && literal.test(value)).map(({ property, value }) => `${rule.selector} { ${property}: ${value} }`),
    );
    expect(outside).toEqual([]);
  });

  it("set the type families with the system's fonts as fallbacks", () => {
    expect(light["--font-sans"]).toBe('"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif');
    expect(light["--font-mono"]).toBe('"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
  });

  it("set no text smaller than 12 pixels", () => {
    const sizes = css.rules.flatMap((rule) => rule.declarations.filter(({ property }) => property === "font-size").map(({ value }) => value));
    for (const size of sizes) {
      const pixels = /^(\d+(?:\.\d+)?)px$/.exec(size)?.[1];
      if (pixels !== undefined) expect(Number(pixels), size).toBeGreaterThanOrEqual(12);
      else expect(size, size).toMatch(/^(inherit|1em|100%|var\(--[a-z0-9-]+\))$/);
    }
  });
});

describe("contrast", () => {
  it.each(Object.keys(THEMES) as (keyof typeof THEMES)[])("is at least 4.5:1 for every pair of text and background in the %s tokens", (name) => {
    const theme = THEMES[name];
    const pairs: [string, string][] = [
      ...["--ink", "--ink-2", "--line", "--line-hover"].flatMap((text) => ["--ground", "--surface", "--surface-2"].map((background) => [text, background] as [string, string])),
      ["--button-ink", "--button"],
      ["--notice-ink", "--notice"],
      ["--ink", "--notice"],
      ...STATES.map((state) => [`--chip-${state}-ink`, `--chip-${state}`] as [string, string]),
    ];
    for (const [text, background] of pairs) expect(contrast(color(theme, text), color(theme, background)), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
  });

  it("is at least 4.5:1 for the inbox's badge and the live hall's initials", () => {
    for (const theme of Object.values(THEMES)) expect(contrast(color(theme, "--button-ink"), color(theme, "--button"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color(hall, "--on-signal"), color(hall, "--signal"))).toBeGreaterThanOrEqual(4.5);
    expect(color(hall, "--on-signal")).toBe("#14161B");
    expect(color(hall, "--button")).toBe("#4C69E6");
  });

  it("is at least 3:1 for every lamp against each background it may sit on in its theme", () => {
    const backgrounds = { light: ["#FFFFFF", "#F6F7F9", "#EEF0F4"], dark: ["#151A23", "#0E1117", "#1C2230"], hall: ["#151A23", "#0E1117", "#1C2230"] } as const;
    for (const [name, theme] of Object.entries(THEMES) as [keyof typeof THEMES, Record<string, string>][]) {
      for (const state of LAMP_STATES) {
        for (const background of backgrounds[name]) expect(contrast(color(theme, `--lamp-${state}`), background), `${name} --lamp-${state} on ${background}`).toBeGreaterThanOrEqual(3);
      }
      expect([color(theme, "--surface"), color(theme, "--ground"), color(theme, "--surface-2")]).toEqual([...backgrounds[name]]);
    }
    expect(contrast(color(hall, "--live"), color(hall, "--surface"))).toBeGreaterThanOrEqual(3);
  });

  it("is at least 3:1 for the focus ring and the edges of form controls against both grounds", () => {
    for (const theme of Object.values(THEMES)) {
      for (const background of ["--ground", "--surface"]) {
        expect(contrast(color(theme, "--line"), color(theme, background))).toBeGreaterThanOrEqual(3);
        expect(contrast(color(theme, "--control-border"), color(theme, background))).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("signal amber and the lamps", () => {
  it("never colors text, nor a lamp, in the light theme: its lamps and text take other tokens", () => {
    for (const state of LAMP_STATES) expect(color(light, `--lamp-${state}`)).not.toBe("#F2B33D");
    const lightRules = css.rules.filter((rule) => rule.context.length === 0 && !inHall(rule));
    const amberText = lightRules.flatMap((rule) =>
      rule.declarations.filter(({ property, value }) => ["color", "fill", "stroke", "-webkit-text-fill-color"].includes(property) && value.includes("var(--signal)")).map(() => rule.selector),
    );
    expect(amberText).toEqual([]);
    const amberLamps = lightRules.filter((rule) => /lamp/.test(rule.selector) && rule.declarations.some(({ value }) => value.includes("var(--signal)")));
    expect(amberLamps.map(({ selector }) => selector)).toEqual([]);
  });

  it("draws each state's lamp and chip in that state's tokens", () => {
    for (const state of LAMP_STATES) {
      const lamp = css.rules.find((rule) => selectorsOf(rule).includes(`.lamp.${state}`) && rule.context.length === 0);
      expect(lamp?.declarations, `.lamp.${state}`).toContainEqual(expect.objectContaining({ property: "background", value: `var(--lamp-${state})` }));
    }
    for (const state of STATES) {
      const chip = css.rules.find((rule) => selectorsOf(rule).includes(`.chip.${state}`) && rule.context.length === 0);
      expect(chip?.declarations, `.chip.${state}`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "background", value: `var(--chip-${state})` }),
          expect.objectContaining({ property: "color", value: `var(--chip-${state}-ink)` }),
        ]),
      );
    }
    const waits = css.rules.find((rule) => selectorsOf(rule).includes(".chip.waits"));
    expect(waits?.declarations).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--notice)" }), expect.objectContaining({ property: "color", value: "var(--notice-ink)" })]),
    );
  });

  it("puts no lamp on the notice fill", () => {
    const filled = new Set(
      css.rules
        .filter((rule) => rule.declarations.some(({ property, value }) => /^background(-color)?$/.test(property) && value.includes("var(--notice)")))
        .flatMap((rule) => selectorsOf(rule).flatMap((selector) => selector.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? [])),
    );
    expect(filled.size).toBeGreaterThan(0);
    const onNotice = css.rules
      .filter((rule) => /\.lamp\b/.test(rule.selector))
      .flatMap(selectorsOf)
      .filter((selector) => /\.lamp\b/.test(selector) && (selector.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? []).some((part) => part !== ".lamp" && filled.has(part) && !LAMP_STATES.some((state) => part === `.${state}`)));
    expect(onNotice).toEqual([]);
  });

  it("dims a team node of the live hall that has nothing live by its border only", () => {
    const dimmed = css.rules.filter((rule) => /\.dimmed\b/.test(rule.selector));
    expect(dimmed.length).toBeGreaterThan(0);
    for (const rule of dimmed) {
      expect(rule.selector).toMatch(/^\.hall /);
      for (const { property } of rule.declarations) expect(property, rule.selector).toMatch(/^border(-color)?$/);
    }
  });
});

describe("the themes", () => {
  it("follow the system: color-scheme light dark, the dark tokens under prefers-color-scheme: dark, and the live hall dark", () => {
    const root = css.rules.find((rule) => rule.selector === ":root" && rule.context.length === 0);
    expect(root?.declarations).toContainEqual(expect.objectContaining({ property: "color-scheme", value: "light dark" }));
    const hallRule = css.rules.find((rule) => rule.selector === ".hall" && rule.context.length === 0);
    expect(hallRule?.declarations).toContainEqual(expect.objectContaining({ property: "color-scheme", value: "dark" }));
    const body = css.rules.find((rule) => selectorsOf(rule).includes("body") && rule.context.length === 0);
    expect(body?.declarations).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--ground)" }), expect.objectContaining({ property: "color", value: "var(--ink)" })]),
    );
  });
});

/** Each animation a declaration of the shorthand runs: its name, duration and delay in seconds, and how often it runs. */
function animationsOf(value: string): { name: string; duration: number; delay: number; count: number }[] {
  if (value === "none") return [];
  return value.split(",").map((one) => {
    const parts = one.trim().split(/\s+/);
    const times = parts.filter((part) => /^-?\d*\.?\d+m?s$/.test(part)).map((part) => (part.endsWith("ms") ? Number(part.slice(0, -2)) / 1000 : Number(part.slice(0, -1))));
    const count = parts.includes("infinite") ? Number.POSITIVE_INFINITY : Number(parts.find((part) => /^\d+(\.\d+)?$/.test(part)) ?? "1");
    const keywords = new Set(["infinite", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "both", "forwards", "backwards", "none", "normal", "reverse", "alternate", "running", "paused"]);
    const name = parts.find((part) => !/^-?\d*\.?\d+m?s$/.test(part) && !/^\d+(\.\d+)?$/.test(part) && !keywords.has(part) && !part.startsWith("cubic-bezier") && !part.startsWith("var(") && !part.startsWith("steps(")) ?? "";
    return { name, duration: times[0] ?? 0, delay: times[1] ?? 0, count };
  });
}

describe("motion", () => {
  const animated = css.rules.flatMap((rule) =>
    rule.declarations.filter(({ property }) => property === "animation").flatMap(({ value }) => animationsOf(value).map((animation) => ({ rule, ...animation }))),
  );

  it("names only keyframes the stylesheet defines, and sets no separate iteration count, duration or delay", () => {
    expect(animated.length).toBeGreaterThan(0);
    const keyframes = new Set(css.rules.flatMap((rule) => rule.context.filter((context) => context.startsWith("@keyframes ")).map((context) => context.slice("@keyframes ".length))));
    for (const { name, rule } of animated) expect(keyframes, `${rule.selector}: ${name}`).toContain(name);
    const separate = css.rules.flatMap((rule) => rule.declarations.filter(({ property }) => /^animation-(iteration-count|duration|delay|name)$/.test(property)).map(() => rule.selector));
    expect(separate).toEqual([]);
  });

  it("ends every repeating animation outside the live hall within 5 seconds", () => {
    for (const { rule, name, duration, delay, count } of animated.filter(({ rule }) => !rule.selector.startsWith(".hall.live"))) {
      expect(count, `${rule.selector}: ${name}`).not.toBe(Number.POSITIVE_INFINITY);
      expect(delay + duration * count, `${rule.selector}: ${name}`).toBeLessThanOrEqual(5);
    }
  });

  it("repeats the live hall's animations only once its script has put the class live on its body", () => {
    const repeating = animated.filter(({ count }) => count === Number.POSITIVE_INFINITY);
    expect(repeating.length).toBeGreaterThan(0);
    for (const { rule } of repeating) for (const selector of selectorsOf(rule)) expect(selector).toMatch(/^\.hall\.live /);
    expect(css.rules.find((rule) => rule.selector.startsWith(".hall.paused"))?.declarations).toContainEqual(expect.objectContaining({ property: "animation-play-state", value: "paused" }));
  });

  it("blinks nothing faster than once in 1.2 seconds", () => {
    for (const { rule, name, duration } of animated.filter(({ name }) => /blink|pulse/.test(name))) expect(duration, `${rule.selector}: ${name}`).toBeGreaterThanOrEqual(1.2);
  });

  it("stops every animation and transition under prefers-reduced-motion: reduce", () => {
    const reduced = css.rules.filter((rule) => rule.context.includes(REDUCED));
    const everything = reduced.find((rule) => selectorsOf(rule).includes("*") && selectorsOf(rule).includes("*::before") && selectorsOf(rule).includes("*::after"));
    expect(everything?.declarations).toEqual(
      expect.arrayContaining([{ property: "animation", value: "none", important: true }, { property: "transition", value: "none", important: true }]),
    );
  });

  it("keeps the borders and the focus outline under forced colors", () => {
    const forced = css.rules.filter((rule) => rule.context.includes(FORCED));
    const focus = forced.find((rule) => rule.selector.includes(":focus-visible"));
    expect(focus?.declarations.find(({ property }) => property === "outline")?.value).toMatch(/^2px solid \w+$/);
    const bordered = forced.filter((rule) => rule.declarations.some(({ property }) => property === "border" || property === "border-color"));
    const selectors = bordered.flatMap(selectorsOf);
    for (const shown of [".chip", ".lamp", ".badge", ".button", "button"]) expect(selectors, shown).toContain(shown);
  });
});

interface FontSource {
  path: string;
  sha256: string;
  unicodeRange?: string;
}

describe("the fonts", () => {
  const sources = (JSON.parse(readFileSync(SOURCES, "utf8")) as { packages: { files: FontSource[] }[] }).packages.flatMap(({ files }) => files).filter(({ path }) => path.endsWith(".woff2"));
  const faces = css.rules.filter((rule) => rule.selector === "@font-face");
  const property = (rule: CssRule, name: string) => rule.declarations.find((declaration) => declaration.property === name)?.value;
  const WEIGHTS: Readonly<Record<string, string>> = { Regular: "400", Medium: "500", SemiBold: "600", Bold: "700" };

  it("are declared once each: the 34 files of SOURCES.json, 4 weights by 6 subsets of Plex Sans and 2 by 5 of Plex Mono", () => {
    const files = faces.map((face) => /^url\("fonts\/([^"]+)"\) format\("woff2"\)$/.exec(property(face, "src") ?? "")?.[1]);
    expect(files.sort()).toEqual(sources.map(({ path }) => path).sort());
    expect(faces).toHaveLength(34);
    expect(faces.filter((face) => property(face, "font-family") === '"IBM Plex Sans"')).toHaveLength(24);
    expect(faces.filter((face) => property(face, "font-family") === '"IBM Plex Mono"')).toHaveLength(10);
  });

  it("each with IBM's unicode-range, its weight, font-display: swap and no local() source", () => {
    for (const face of faces) {
      const file = /fonts\/([^"]+)"/.exec(property(face, "src") ?? "")?.[1] ?? "";
      const [, family, weight] = /^IBMPlex(Sans|Mono)-([A-Za-z]+)-/.exec(file) ?? [];
      expect(property(face, "font-family"), file).toBe(`"IBM Plex ${family}"`);
      expect(property(face, "font-weight"), file).toBe(WEIGHTS[weight ?? ""]);
      expect(property(face, "font-style"), file).toBe("normal");
      expect(property(face, "font-display"), file).toBe("swap");
      expect(property(face, "unicode-range"), file).toBe(sources.find(({ path }) => path === file)?.unicodeRange);
      expect(property(face, "src"), file).not.toContain("local(");
    }
  });

  it("set Turkish in the Latin1 and Latin2 subsets: ı in Latin1, and ğ, ş and İ in Latin2", () => {
    const covers = (file: string, codePoint: number) =>
      (sources.find(({ path }) => path === file)?.unicodeRange ?? "").split(",").some((range) => {
        const [start = "", end = start] = range.trim().replace(/^U\+/, "").split("-");
        return codePoint >= Number.parseInt(start, 16) && codePoint <= Number.parseInt(end, 16);
      });
    expect(covers("IBMPlexSans-Regular-Latin1.woff2", "ı".codePointAt(0) ?? 0)).toBe(true);
    for (const character of ["ğ", "ş", "İ", "Ş", "Ğ"]) expect(covers("IBMPlexSans-Regular-Latin2.woff2", character.codePointAt(0) ?? 0), character).toBe(true);
  });
});

describe("what the stylesheet loads", () => {
  it("imports nothing and names no other host: every url() is a font of the install, by its path in the assets folder", () => {
    expect(css.statements.filter((statement) => statement.startsWith("@import"))).toEqual([]);
    const urls = css.rules.flatMap((rule) => rule.declarations.flatMap(({ value }) => [...value.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1] ?? "")));
    expect(urls.length).toBe(34);
    for (const url of urls) expect(url).toMatch(/^"fonts\/IBMPlex(Sans|Mono)-[A-Za-z]+-[A-Za-z0-9]+\.woff2"$/);
    expect(readFileSync(STYLESHEET, "utf8")).not.toMatch(/https?:|\/\//);
  });
});
