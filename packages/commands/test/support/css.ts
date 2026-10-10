// A small reader of the install's stylesheet for its tests (web-ui: One
// stylesheet with named design tokens; design.md, Design: The design tokens;
// D57 (1)): it reads the rules, with the at-rules each sits in, and their
// declarations. It reads plain CSS as the stylesheet is written, comments,
// strings and nested at-rules included, and nothing more: no preprocessor
// syntax, no nesting of style rules.

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

export interface CssRule {
  /** The rule's selector, such as ":root" or ".chip.open", or the at-rule's name for a block of declarations, such as "@font-face". */
  selector: string;
  /** The preludes of the at-rules the rule sits in, outermost first, such as ["@media (prefers-color-scheme: dark)"]. */
  context: string[];
  declarations: Declaration[];
}

export interface Stylesheet {
  rules: CssRule[];
  /** The at-rules without a block, such as @import. */
  statements: string[];
}

/** The text without its comments, strings kept. */
function withoutComments(css: string): string {
  let out = "";
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index] ?? "";
    if (character === '"' || character === "'") {
      const end = css.indexOf(character, index + 1);
      out += css.slice(index, end + 1);
      index = end;
    } else if (character === "/" && css[index + 1] === "*") {
      index = css.indexOf("*/", index + 2) + 1;
    } else {
      out += character;
    }
  }
  return out;
}

/** The index of the brace that closes the block opened at `open`, strings skipped. */
function closing(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const character = css[index];
    if (character === '"' || character === "'") index = css.indexOf(character, index + 1);
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("The stylesheet has a block that is not closed.");
}

/** The declarations of a block's text, split on the semicolons outside strings and parentheses. */
function declarationsOf(block: string): Declaration[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < block.length; index += 1) {
    const character = block[index] ?? "";
    if (character === '"' || character === "'") {
      const end = block.indexOf(character, index + 1);
      current += block.slice(index, end + 1);
      index = end;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === ";" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const colon = part.indexOf(":");
      if (colon === -1) throw new Error(`The stylesheet has a declaration without a colon: ${part}`);
      const raw = part.slice(colon + 1).trim();
      const important = /!\s*important$/i.test(raw);
      return { property: part.slice(0, colon).trim().toLowerCase(), value: raw.replace(/\s*!\s*important$/i, "").trim(), important };
    });
}

/** Reads the stylesheet's text into its rules. */
export function parseCss(text: string): Stylesheet {
  const rules: CssRule[] = [];
  const statements: string[] = [];
  const walk = (css: string, context: string[]) => {
    let index = 0;
    while (index < css.length) {
      const open = css.indexOf("{", index);
      const semicolon = css.indexOf(";", index);
      // A statement at-rule, such as @import, before the next block.
      if (semicolon !== -1 && (open === -1 || semicolon < open) && css.slice(index, semicolon).trim().startsWith("@")) {
        statements.push(css.slice(index, semicolon).trim());
        index = semicolon + 1;
        continue;
      }
      if (open === -1) {
        if (css.slice(index).trim() !== "") throw new Error(`The stylesheet ends with text outside a rule: ${css.slice(index).trim()}`);
        return;
      }
      const prelude = css.slice(index, open).trim().replace(/\s+/g, " ");
      const close = closing(css, open);
      const body = css.slice(open + 1, close);
      if (prelude.startsWith("@") && !prelude.startsWith("@font-face") && !prelude.startsWith("@page")) walk(body, [...context, prelude]);
      else rules.push({ selector: prelude, context, declarations: declarationsOf(body) });
      index = close + 1;
    }
  };
  walk(withoutComments(text), []);
  return { rules, statements };
}

/** The selectors of a rule, split on the commas outside parentheses. */
export function selectorsOf(rule: CssRule): string[] {
  const selectors: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of rule.selector) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      selectors.push(current.trim());
      current = "";
    } else current += character;
  }
  selectors.push(current.trim());
  return selectors;
}

/** The relative luminance of a color in #RRGGBB, as WCAG 2.2 defines it. */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [value >> 16, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** The contrast ratio of two colors in #RRGGBB, as WCAG 2.2 defines it. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
