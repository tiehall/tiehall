// The confirmation step's rules (agent-safety: The review page of the
// confirmation step; design.md, Self-hosting decisions: S7). Before an action
// that needs the confirmation step, a person reads a review of exactly what
// will happen, in Tiehall's own words. A review is lines of server text, which
// Tiehall writes, and quotes of text Tiehall did not write, such as another
// team's proposed need, each fenced with a preamble that names where it came
// from, so the page never passes such text off as Tiehall's own. An action's
// input is compared in canonical JSON, so the same input in any key order is
// the same action.

/** Where text that Tiehall did not write came from (design.md, Decisions this change rests on: D28 #54). */
export const TEXT_ORIGINS = ["same team", "other team", "external"] as const;
export type TextOrigin = (typeof TEXT_ORIGINS)[number];

/** One line of a review: a sentence in Tiehall's own words, or a quote of text someone else wrote. */
export type ReviewLine = { text: string } | { quote: string; origin: TextOrigin };

/** What an action will do, as its review page shows it. */
export interface Review {
  /** The action in a few words, such as "Create a personal access token". */
  title: string;
  lines: readonly ReviewLine[];
}

/** The sentence that introduces a quote, naming where its text came from. */
export function quotePreamble(origin: TextOrigin): string {
  switch (origin) {
    case "same team":
      return "Text a member of your team wrote, quoted as data:";
    case "other team":
      return "Text another team wrote, quoted as data:";
    case "external":
      return "Text from outside Tiehall, quoted as data:";
  }
}

/**
 * A value as JSON with the keys of every object in sorted order, so that the
 * same input always has the same text, whatever order its keys arrived in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // A value that says how it is written as JSON, such as a Date, is written so.
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return sortKeys(toJSON.call(value));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

