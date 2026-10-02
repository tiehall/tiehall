import { REFUSAL_ISSUES_MAX, type RefusalIssue } from "@tiehall/core";
import { z } from "zod";

// Arrays longer than their schemas allow (public-api: Input and output follow
// the published schemas; public-api: Request bodies have a size limit;
// request-body-limit: design.md, Design rules: Request body limit). A body
// within its size limit is bounded work, but zod judges every element of an
// array before it checks the array's length, and gives an issue for each
// element that fails: a report of 16 MiB holding millions of empty changes
// would make it judge, and list, every one of them. So execute() first asks
// overlongArrays() where the input holds an array longer than its schema
// allows, and refuses such input with zod's own issue for the array's length,
// before zod judges any element of it. The walk follows the input through the
// schema's objects, records, arrays within their maximum, optional, nullable
// and default fields, and the variant of a discriminated union that the input
// names; it judges nothing else, which zod then does.

/**
 * Where the input holds an array longer than its schema allows, at most `limit`
 * of them, each with the issue zod gives for the array's length; none when it
 * holds none. No element of such an array is judged.
 */
export function overlongArrays(schema: z.ZodType, input: unknown, limit: number = REFUSAL_ISSUES_MAX): RefusalIssue[] {
  const found: RefusalIssue[] = [];
  walk(schema, input, [], found, limit);
  return found;
}

/** The parts of a schema's definition the walk reads. */
interface Definition {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: readonly z.ZodType[];
  discriminator?: string;
  checks?: readonly { _zod: { def: { check: string; maximum?: number; length?: number } } }[];
}

function walk(schema: z.ZodType, input: unknown, path: (string | number)[], found: RefusalIssue[], limit: number): void {
  if (found.length >= limit) return;
  const def = schema.def as unknown as Definition;
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      if (def.innerType !== undefined) walk(def.innerType, input, path, found, limit);
      return;
    case "pipe":
      if (def.in !== undefined) walk(def.in, input, path, found, limit);
      return;
    case "object":
      if (!isRecord(input) || def.shape === undefined) return;
      for (const [key, field] of Object.entries(def.shape)) {
        if (Object.hasOwn(input, key)) walk(field, input[key], [...path, key], found, limit);
      }
      return;
    case "record":
      if (!isRecord(input) || def.valueType === undefined) return;
      for (const [key, value] of Object.entries(input)) walk(def.valueType, value, [...path, key], found, limit);
      return;
    case "array": {
      if (!Array.isArray(input) || def.element === undefined) return;
      const maximum = maximumOf(def);
      if (maximum !== undefined && input.length > maximum) {
        found.push({ path, message: lengthMessageOf(schema, input.slice(0, maximum + 1)) });
        return;
      }
      for (let index = 0; index < input.length && found.length < limit; index += 1) walk(def.element, input[index], [...path, index], found, limit);
      return;
    }
    case "union": {
      // A discriminated union's variant is the one whose discriminator the input names; any other union is zod's alone.
      const { discriminator, options } = def;
      if (discriminator === undefined || options === undefined || !isRecord(input)) return;
      const variant = options.find((option) => option._zod.propValues?.[discriminator]?.has(input[discriminator] as never) === true);
      if (variant !== undefined) walk(variant, input, path, found, limit);
      return;
    }
    default:
      return;
  }
}

/** The most items an array's schema allows: its maximum, or its exact length; undefined when it sets neither. */
function maximumOf(def: Definition): number | undefined {
  let maximum: number | undefined;
  for (const check of def.checks ?? []) {
    const { check: kind, maximum: max, length } = check._zod.def;
    const bound = kind === "max_length" ? max : kind === "length_equals" ? length : undefined;
    if (bound !== undefined && (maximum === undefined || bound < maximum)) maximum = bound;
  }
  return maximum;
}

/**
 * The message zod gives for an array too long for its schema, its own where
 * the schema sets one: the array's checks judge the first items beyond its
 * maximum, as items that need no judging.
 */
function lengthMessageOf(schema: z.ZodType, items: unknown[]): string {
  const lengthOnly = schema.clone({ ...(schema.def as z.ZodArray["def"]), element: z.unknown() } as never) as z.ZodType;
  const issue = lengthOnly.safeParse(items).error?.issues.find(({ path }) => path.length === 0);
  return issue?.message ?? "Too big: the array has more items than its schema allows.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
