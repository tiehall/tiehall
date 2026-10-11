import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, lightness, parseCss, selectorsOf, type CssRule } from "./support/css.ts";

// The install's one stylesheet (web-ui: One stylesheet with named design
// tokens; web-ui: A request's state looks the same everywhere; web-ui: Light
// and dark themes follow the system; web-ui: Motion, and reduced motion;
// web-ui: Pages are accessible;
// design.md, Design: The design tokens; design.md, Design: Request states;
// design.md, Design: Light and dark themes; design.md, Design: Motion and
// reduced motion; design.md, Design: Type and the self-hosted fonts; D57 (1),
// (3), (5), (6), (8); D59). Every color is a named token of the Navy & Gold
// palette, with its value in the light theme, the dark theme and the live
// hall; every pair of text and background contrasts at least 4.5:1, and every
// lamp, edge of a field or outline button, checked checkbox's fill, focus ring
// and the mark at least 3:1 on each background it may sit on, computed here
// from the tokens; the lamps of a theme differ in
// lightness as well as hue; gold marks only what asks for attention; motion
// outside the live hall ends within 5 seconds, the hall's loops run only once
// its script runs, and reduced motion stops everything; IBM's fonts are
// declared as IBM declares them, with no local() source.

const STYLESHEET = fileURLToPath(new URL("../assets/tiehall.css", import.meta.url));
const SOURCES = fileURLToPath(new URL("../assets/fonts/SOURCES.json", import.meta.url));
const css = parseCss(readFileSync(STYLESHEET, "utf8"));

/** The brand's gold, D59's broken warm gold. */
const GOLD = "#E3B341";

/**
 * The design tokens' values in the light theme, the dark theme and the live
 * hall, as design.md's tables give them; undefined where a theme has none,
 * such as the live hall's own tokens, which no other page uses.
 */
const TOKENS: Readonly<Record<string, readonly [light: string | undefined, dark: string | undefined, hall: string | undefined]>> = {
  "--ink": ["#0B1B3A", "#E9EDF5", "#E9EDF5"],
  "--ink-2": ["#4A5672", "#A9B3C8", "#A9B3C8"],
  "--line": ["#1F45A3", "#9DB6EE", "#9DB6EE"],
  "--line-hover": ["#14306E", "#C4D3F6", "#C4D3F6"],
  "--focus": ["#1F45A3", "#F0CB6A", "#F0CB6A"],
  "--button": [GOLD, GOLD, GOLD],
  "--button-hover": ["#D9AA38", "#F0CB6A", "#F0CB6A"],
  "--button-ink": ["#0B1B3A", "#0A1428", "#0A1428"],
  "--strong": ["#14306E", "#2A4A9E", "#2A4A9E"],
  "--strong-hover": ["#102A61", "#3557B5", "#3557B5"],
  "--strong-ink": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "--signal": [GOLD, GOLD, GOLD],
  "--on-signal": ["#0B1B3A", "#0A1428", "#0A1428"],
  "--lamp-open": ["#6A748D", "#7A849D", "#7A849D"],
  "--lamp-claimed": ["#364EA0", "#93A9DD", "#93A9DD"],
  "--lamp-in-progress": ["#14306E", "#6E95F0", "#6E95F0"],
  "--lamp-needs-info": ["#A98000", GOLD, GOLD],
  "--lamp-done": ["#0B724B", "#8FE9BB", "#8FE9BB"],
  "--ground": ["#F6F7FA", "#0A1428", "#071026"],
  "--surface": ["#FFFFFF", "#111E38", "#0E1A33"],
  "--surface-2": ["#EEF1F6", "#182748", "#16264A"],
  "--border": ["#DFE3EC", "#24345A", "#22325A"],
  "--control-border": ["#7D869C", "#65749C", "#65749C"],
  "--notice": ["#FBF1D6", "#2A2208", "#241D0B"],
  "--notice-ink": ["#6E4B07", "#F0CB6A", "#F0CB6A"],
  "--success-ink": ["#145A37", "#86E0B2", "#86E0B2"],
  "--danger": ["#FBE3E1", "#451E1C", "#451E1C"],
  "--danger-ink": ["#9B1E22", "#FBB7B1", "#FBB7B1"],
  "--chip-open": ["#FFFFFF", "#182748", "#182748"],
  "--chip-open-ink": ["#3E4A63", "#C4CBD8", "#C4CBD8"],
  "--chip-claimed": ["#E6EBF7", "#1B2D5D", "#1B2D5D"],
  "--chip-claimed-ink": ["#1F3F8F", "#C1D4FE", "#C1D4FE"],
  "--chip-in-progress": ["#14306E", "#2A4A9E", "#2A4A9E"],
  "--chip-in-progress-ink": ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
  "--chip-needs-info": ["#F2CA5B", GOLD, GOLD],
  "--chip-needs-info-ink": ["#0B1B3A", "#0A1428", "#0A1428"],
  "--chip-done": ["#D7F1E3", "#0F3A27", "#0F3A27"],
  "--chip-done-ink": ["#145A37", "#86E0B2", "#86E0B2"],
  "--chip-declined": ["#FBE3E1", "#451E1C", "#451E1C"],
  "--chip-declined-ink": ["#9B1E22", "#FBB7B1", "#FBB7B1"],
  "--chip-withdrawn": ["#EEF0F4", "#191F2E", "#191F2E"],
  "--chip-withdrawn-ink": ["#555B66", "#9FA5B2", "#9FA5B2"],
  "--mark-tile": ["#0A1428", GOLD, GOLD],
  "--mark-ink": [GOLD, "#0A1428", "#0A1428"],
  // The live hall's own: the "Live" pill and its lamp, the chips of the people and agents at work, the border of one
  // waiting on a question, and the glows of a team at work and of a team with a question waiting.
  "--live": [undefined, undefined, "#86E0B2"],
  "--live-pill": [undefined, undefined, "#10301F"],
  "--agent-chip": [undefined, undefined, "#111E38"],
  "--agent-chip-border": [undefined, undefined, "#2A3C66"],
  "--ask-border": [undefined, undefined, "#5E4A17"],
  "--attention-glow": [undefined, undefined, "#E3B34140"],
  "--attention-glow-strong": [undefined, undefined, "#E3B34173"],
  "--glow": [undefined, undefined, "#6E95F059"],
  "--glow-strong": [undefined, undefined, "#6E95F08C"],
  "--live-glow": [undefined, undefined, "#86E0B299"],
  "--live-glow-end": [undefined, undefined, "#86E0B200"],
};

const STATES = ["open", "claimed", "in-progress", "needs-info", "done", "declined", "withdrawn"] as const;
const LAMP_STATES = ["open", "claimed", "in-progress", "needs-info", "done"] as const;
const BACKGROUNDS = ["--ground", "--surface", "--surface-2"] as const;

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
type Theme = keyof typeof THEMES;
const THEME_NAMES = Object.keys(THEMES) as Theme[];

/** A token's value as a color, upper case; it fails the test when the theme has none. */
function color(theme: Record<string, string>, token: string): string {
  const value = theme[token];
  expect(value, token).toMatch(/^#[0-9A-Fa-f]{6}$/);
  return (value ?? "").toUpperCase();
}

/** Whether a rule is the live hall's own: one whose every selector starts with .hall. */
const inHall = (rule: CssRule) => selectorsOf(rule).every((selector) => selector.startsWith(".hall"));

/** The declarations of the rule whose selectors include this one, outside any at-rule. */
function declarationsOf(selector: string): CssRule["declarations"] | undefined {
  return css.rules.find((rule) => rule.context.length === 0 && selectorsOf(rule).includes(selector))?.declarations;
}

describe("the design tokens", () => {
  it.each(Object.entries(TOKENS))("%s has its value in the light theme, the dark theme and the live hall", (token, values) => {
    THEME_NAMES.forEach((name, index) => {
      const value = values[index];
      if (value === undefined) expect(THEMES[name][token], name).toBeUndefined();
      else expect(THEMES[name][token]?.toUpperCase(), name).toBe(value);
    });
  });

  it("are the only place a color is written: every color literal is a token's value", () => {
    const literal = /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|gray|grey)\b/;
    const outside = css.rules.flatMap((rule) =>
      rule.declarations.filter(({ property, value }) => !property.startsWith("--") && literal.test(value)).map(({ property, value }) => `${rule.selector} { ${property}: ${value} }`),
    );
    expect(outside).toEqual([]);
  });

  it("give the setup screen's art the live hall's dark colors, whatever the system's preference", () => {
    const art = tokensOf((rule) => rule.selector === ".setup-art" && rule.context.length === 0);
    expect(Object.keys(art).length).toBeGreaterThan(0);
    for (const [token, value] of Object.entries(art)) expect(value.toUpperCase(), token).toBe(hall[token]?.toUpperCase());
  });

  it("set the type families with the system's fonts as fallbacks", () => {
    expect(light["--font-sans"]).toBe('"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif');
    expect(light["--font-mono"]).toBe('"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
  });

  it("set every size in pixels on design.md's type scale: 12, 14, 16, 18, 22, 30 and 40", () => {
    const sizes = css.rules.flatMap((rule) => rule.declarations.filter(({ property }) => property === "font-size").map(({ value }) => /^(\d+(?:\.\d+)?)px$/.exec(value)?.[1]));
    const pixels = sizes.filter((size): size is string => size !== undefined).map(Number);
    expect(pixels.length).toBeGreaterThan(0);
    expect(pixels.filter((size) => ![12, 14, 16, 18, 22, 30, 40].includes(size))).toEqual([]);
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

/** Every pair of text and its background in a theme, which must contrast at least 4.5:1. */
function textPairs(name: Theme): [text: string, background: string][] {
  return [
    ...["--ink", "--ink-2", "--line", "--line-hover", "--success-ink", "--danger-ink"].flatMap((text) => BACKGROUNDS.map((background) => [text, background] as [string, string])),
    ["--button-ink", "--button"],
    ["--button-ink", "--button-hover"],
    ["--strong-ink", "--strong"],
    ["--strong-ink", "--strong-hover"],
    ["--on-signal", "--signal"],
    ["--notice-ink", "--notice"],
    ["--ink", "--notice"],
    ["--danger-ink", "--danger"],
    ...STATES.map((state) => [`--chip-${state}-ink`, `--chip-${state}`] as [string, string]),
    ...(name === "hall"
      ? ([
          ["--live", "--live-pill"],
          ["--ink", "--agent-chip"],
          ["--ink-2", "--agent-chip"],
          ["--line", "--agent-chip"],
          ["--ink-2", "--notice"],
        ] as [string, string][])
      : []),
  ];
}

/** Every pair of a shape that carries meaning and its background in a theme, which must contrast at least 3:1. */
function shapePairs(name: Theme): [shape: string, background: string][] {
  return [
    ...["--focus", "--control-border", ...LAMP_STATES.map((state) => `--lamp-${state}`)].flatMap((shape) => BACKGROUNDS.map((background) => [shape, background] as [string, string])),
    ["--mark-ink", "--mark-tile"],
    ["--mark-tile", "--surface"],
    ...(name === "hall" ? ([["--live", "--surface"]] as [string, string][]) : []),
  ];
}

describe("contrast", () => {
  describe.each(THEME_NAMES)("in the %s tokens", (name) => {
    const theme = THEMES[name];
    it.each(textPairs(name))("is at least 4.5:1 for the text %s on %s", (text, background) => {
      expect(contrast(color(theme, text), color(theme, background))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(shapePairs(name))("is at least 3:1 for %s on %s", (shape, background) => {
      expect(contrast(color(theme, shape), color(theme, background))).toBeGreaterThanOrEqual(3);
    });
  });

  it("is at least 4.5:1 in every rule that sets both a background and a text color, in each theme the rule applies in", () => {
    const setupArt = { ...light, ...tokensOf((rule) => rule.selector === ".setup-art" && rule.context.length === 0) };
    const themes: Readonly<Record<string, Record<string, string>>> = { light, dark: { ...light, ...dark }, hall: { ...light, ...hall } };
    /** A value that names a token, followed through the tokens it names in turn, as a color. */
    const resolve = (theme: Record<string, string>, value: string): string | undefined => {
      const name = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
      const next = name === undefined ? undefined : theme[name];
      return next === undefined ? undefined : next.startsWith("var(") ? resolve(theme, next) : next.toUpperCase();
    };
    const checked: string[] = [];
    for (const rule of css.rules.filter(({ context }) => !context.some((at) => at.startsWith("@keyframes") || at.includes("forced-colors")))) {
      const background = rule.declarations.find(({ property }) => property === "background" || property === "background-color")?.value;
      const text = rule.declarations.find(({ property }) => property === "color")?.value;
      if (background === undefined || text === undefined || !background.startsWith("var(") || !text.startsWith("var(")) continue;
      const selectors = selectorsOf(rule);
      const applies = selectors.every((selector) => selector.startsWith(".hall"))
        ? { hall: themes["hall"] ?? {} }
        : selectors.every((selector) => selector.includes(".setup-art") || selector.startsWith(".sb-"))
          ? { "setup art": setupArt }
          : themes;
      for (const [name, theme] of Object.entries(applies)) {
        const [back, fore] = [resolve(theme, background), resolve(theme, text)];
        expect(back, `${name}: ${rule.selector} { background: ${background} }`).toMatch(/^#[0-9A-F]{6}$/);
        expect(fore, `${name}: ${rule.selector} { color: ${text} }`).toMatch(/^#[0-9A-F]{6}$/);
        expect(contrast(fore ?? "", back ?? ""), `${name}: ${rule.selector} { color: ${text}; background: ${background} }`).toBeGreaterThanOrEqual(4.5);
        checked.push(rule.selector);
      }
    }
    expect(checked.length).toBeGreaterThan(100);
  });

  it.each(THEME_NAMES)("is at least 3:1 for a checked checkbox or radio button on every background in the %s tokens", (name) => {
    // A checked box is filled with its accent color, which shows its state, so it is a shape that carries meaning.
    const accents = css.rules.flatMap((rule) => rule.declarations.filter(({ property }) => property === "accent-color").map(({ value }) => ({ selector: rule.selector, value })));
    expect(accents.length).toBeGreaterThan(0);
    for (const { selector, value } of accents) {
      const token = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1] ?? value;
      for (const background of BACKGROUNDS) {
        expect(contrast(color(THEMES[name], token), color(THEMES[name], background)), `${selector} { accent-color: ${value} } on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(declarationsOf('input[type="checkbox"]')).toContainEqual(expect.objectContaining({ property: "accent-color", value: "var(--line)" }));
  });

  it("edges a refused field in the danger ink of the message beside it, at least 3:1 on every background", () => {
    for (const selector of ['input[aria-invalid="true"]:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])', 'select[aria-invalid="true"]', 'textarea[aria-invalid="true"]']) {
      expect(declarationsOf(selector), selector).toContainEqual(expect.objectContaining({ property: "border-color", value: "var(--danger-ink)" }));
    }
    for (const name of THEME_NAMES) for (const background of BACKGROUNDS) expect(contrast(color(THEMES[name], "--danger-ink"), color(THEMES[name], background)), `${name}: ${background}`).toBeGreaterThanOrEqual(3);
  });

  it("draws the focus ring, the inbox's badge and the live hall's initials in their tokens", () => {
    expect(declarationsOf(":focus-visible")).toContainEqual(expect.objectContaining({ property: "outline", value: "2px solid var(--focus)" }));
    expect(declarationsOf(".badge")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--button)" }), expect.objectContaining({ property: "color", value: "var(--button-ink)" })]),
    );
    for (const selector of [".hall .map-chip.agent .initials", ".hall .worker.agent .initials", ".initials.agent"]) {
      expect(declarationsOf(selector), selector).toEqual(
        expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--strong)" }), expect.objectContaining({ property: "color", value: "var(--strong-ink)" })]),
      );
    }
    for (const selector of [".hall .map-chip.waiting .initials", ".hall .worker.waiting .initials"]) {
      expect(declarationsOf(selector), selector).toEqual(
        expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--signal)" }), expect.objectContaining({ property: "color", value: "var(--on-signal)" })]),
      );
    }
  });
});

describe("the lamps", () => {
  it.each(THEME_NAMES)("differ in lightness as well as hue in the %s tokens: every two at least 6 apart in CIE L*, and gold and green at least 10", (name) => {
    const theme = THEMES[name];
    const lamps = LAMP_STATES.map((state) => [state, lightness(color(theme, `--lamp-${state}`))] as const);
    for (const [index, [state, value]] of lamps.entries()) {
      for (const [other, otherValue] of lamps.slice(index + 1)) expect(Math.abs(value - otherValue), `${state} and ${other}`).toBeGreaterThanOrEqual(6);
    }
    // Gold and green, which readers with red-green color blindness see as one hue.
    expect(Math.abs(lightness(color(theme, "--lamp-needs-info")) - lightness(color(theme, "--lamp-done")))).toBeGreaterThanOrEqual(10);
  });

  it("draw each state's lamp and chip in that state's tokens, the open chip with an edge", () => {
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
    expect(declarationsOf(".chip.open")).toContainEqual(expect.objectContaining({ property: "border-color", value: "var(--border)" }));
    expect(declarationsOf(".chip.waits")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--notice)" }), expect.objectContaining({ property: "color", value: "var(--notice-ink)" })]),
    );
  });

  it("fill a blocking question in the notice colors only while it waits for its answer", () => {
    expect(declarationsOf(".message.blocking:not(.answered) .bubble")).toContainEqual(expect.objectContaining({ property: "background", value: "var(--notice)" }));
    const filledAnswered = css.rules
      .filter((rule) => rule.declarations.some(({ property, value }) => /^background(-color)?$/.test(property) && value.includes("var(--notice)")))
      .flatMap(selectorsOf)
      .filter((selector) => selector.includes(".blocking") && !selector.includes(":not(.answered)"));
    expect(filledAnswered).toEqual([]);
  });

  it("put no lamp on the notice fill", () => {
    // The classes of each element a rule fills with the notice color: its selector's last compound, not its ancestors'.
    const filled = new Set(
      css.rules
        .filter((rule) => rule.declarations.some(({ property, value }) => /^background(-color)?$/.test(property) && value.includes("var(--notice)")))
        .flatMap((rule) => selectorsOf(rule).flatMap((selector) => selector.split(/\s*[\s>+~]\s*/).pop()?.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? [])),
    );
    expect(filled.size).toBeGreaterThan(0);
    const onNotice = css.rules
      .filter((rule) => /\.lamp\b/.test(rule.selector))
      .flatMap(selectorsOf)
      .filter((selector) => /\.lamp\b/.test(selector) && (selector.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? []).some((part) => part !== ".lamp" && filled.has(part) && !LAMP_STATES.some((state) => part === `.${state}`)));
    expect(onNotice).toEqual([]);
  });
});

describe("gold", () => {
  const GOLD_TOKENS = ["--signal", "--button", "--button-hover", "--chip-needs-info"].map((token) => `var(${token})`);
  const lightRules = css.rules.filter((rule) => rule.context.length === 0 && !inHall(rule));

  it("is never text nor a lamp in the light theme, where it contrasts under 3:1 with the ground and the surface", () => {
    for (const state of LAMP_STATES) expect(color(light, `--lamp-${state}`)).not.toBe(GOLD);
    for (const background of ["--ground", "--surface"]) expect(contrast(GOLD, color(light, background))).toBeLessThan(3);
    const goldText = lightRules.flatMap((rule) =>
      rule.declarations
        .filter(({ property, value }) => ["color", "fill", "stroke", "-webkit-text-fill-color", "outline", "outline-color"].includes(property) && GOLD_TOKENS.some((token) => value.includes(token)))
        .map(() => rule.selector),
    );
    expect(goldText).toEqual([]);
    const goldLamps = lightRules.filter((rule) => /lamp/.test(rule.selector) && rule.declarations.some(({ value }) => GOLD_TOKENS.some((token) => value.includes(token))));
    expect(goldLamps.map(({ selector }) => selector)).toEqual([]);
  });

  it("fills a page's main action, with navy ink; a strong secondary action is navy, and a secondary one an outline", () => {
    expect(declarationsOf(".button")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--button)" }), expect.objectContaining({ property: "color", value: "var(--button-ink)" })]),
    );
    expect(declarationsOf(".button:hover")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--button-hover)" }), expect.objectContaining({ property: "color", value: "var(--button-ink)" })]),
    );
    expect(declarationsOf(".button.strong")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--strong)" }), expect.objectContaining({ property: "color", value: "var(--strong-ink)" })]),
    );
    expect(declarationsOf(".button.strong:hover")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--strong-hover)" }), expect.objectContaining({ property: "color", value: "var(--strong-ink)" })]),
    );
    expect(declarationsOf(".button.secondary")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "border-color", value: "var(--control-border)" }), expect.objectContaining({ property: "color", value: "var(--ink)" })]),
    );
  });

  it("draws the mark on its tile: gold on navy in the light theme, navy on gold in the dark theme and the live hall", () => {
    expect(declarationsOf(".mark")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--mark-tile)" }), expect.objectContaining({ property: "color", value: "var(--mark-ink)" })]),
    );
  });

  it("borders and softly lights a live hall panel whose team has a question waiting", () => {
    for (const selector of [".hall .node.asking", ".hall .team-row.asking"]) {
      const declarations = declarationsOf(selector);
      expect(declarations, selector).toContainEqual(expect.objectContaining({ property: "border-color", value: "var(--lamp-needs-info)" }));
      expect(declarations?.find(({ property }) => property === "box-shadow")?.value, selector).toContain("var(--attention-glow)");
    }
  });
});

describe("the live hall's colors", () => {
  it("draw the map on the hall's ground with a faint grid of dots, the Live pill in its own colors, and the chips of people and agents on navy", () => {
    expect(declarationsOf(".hall-map")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "background-color", value: "var(--ground)" }),
        expect.objectContaining({ property: "background-image", value: "radial-gradient(var(--surface-2) 1px, transparent 1px)" }),
      ]),
    );
    expect(declarationsOf(".hall .live-state.live")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--live-pill)" }), expect.objectContaining({ property: "color", value: "var(--live)" })]),
    );
    expect(declarationsOf(".hall .map-chip")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--agent-chip)" }), expect.objectContaining({ property: "border-color", value: "var(--agent-chip-border)" })]),
    );
    expect(declarationsOf(".hall .map-chip.waiting")).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "background", value: "var(--notice)" }), expect.objectContaining({ property: "border-color", value: "var(--ask-border)" })]),
    );
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
