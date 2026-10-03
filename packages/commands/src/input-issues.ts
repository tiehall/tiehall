import { REFUSAL_ISSUES_MAX, type RefusalIssue } from "@tiehall/core";
import type { z } from "zod";

// Where an input fails its schema, as a refusal names it (public-api: One
// error model for Tiehall's own refusals): by path and by the schema's own
// message, never with the value, and at most REFUSAL_ISSUES_MAX places, so a
// refusal stays small whatever the input holds.

/** How many of one place's unknown keys an issue names, and how many characters of each. */
const UNKNOWN_KEYS_NAMED = 10;
const KEY_CHARACTERS = 64;

/** A key the caller chose, as an issue names it: quoted, and cut short when it is long. */
function namedKey(key: string): string {
  return `"${key.length > KEY_CHARACTERS ? `${key.slice(0, KEY_CHARACTERS)}…` : key}"`;
}

/**
 * Where the input fails its schema, the first places a refusal names, by path
 * and by the schema's own message, never with the value. The keys of fields
 * the schema does not know are the caller's own text, so an issue about them
 * names the first 10, each cut to 64 characters, and how many more there are,
 * and stays short however many or long they are.
 */
export function issuesOf(error: z.ZodError): RefusalIssue[] {
  return error.issues.slice(0, REFUSAL_ISSUES_MAX).map((issue) => ({
    path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
    message:
      issue.code === "unrecognized_keys"
        ? `Unrecognized key${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.slice(0, UNKNOWN_KEYS_NAMED).map(namedKey).join(", ")}${
            issue.keys.length > UNKNOWN_KEYS_NAMED ? `, and ${issue.keys.length - UNKNOWN_KEYS_NAMED} more` : ""
          }`
        : issue.message,
  }));
}
