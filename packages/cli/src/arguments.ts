import { readFileSync } from "node:fs";
import type { CommandEntry, CommandField } from "@tiehall/client";
import { CliError } from "./environment.ts";

// A request command's arguments, as the command table gives them
// (agent-surfaces: CLI request commands; design.md, Self-hosting decisions:
// S16). A command takes the fields its table entry names as positional
// arguments, in order, and every other field of its operation, and each
// header, as an option named after it, such as --question-id or --if-match;
// an option is `--name value` or `--name=value`, and an option whose field
// takes only true or false is a flag. A value takes the JSON type its field
// does: a number for a number, true or false for a flag, null for a field
// that takes null, and JSON for an object or a list, given as the JSON
// itself, as @<file> for a file that holds it, or as - for standard input.
// The input the command sets itself, such as the kind of an answer, is no
// option; the input it sets by default yields to an option. The install
// checks the input against the operation's schema, as it does on every
// surface.

/** The call a command makes: its path parameters, its query, its headers and its JSON body. */
export interface CommandCall {
  path: Record<string, string>;
  query: Record<string, unknown>;
  header: Record<string, string>;
  /** The JSON body, for a method that takes one. */
  body: Record<string, unknown> | undefined;
}

/** The option a field is given by: its name in lower-case words joined by hyphens, such as --question-id. */
export function optionOf(field: string): string {
  return `--${field
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()}`;
}

/** The fields a command takes as options: every field but those it sets itself. */
export function optionsOf(entry: CommandEntry): CommandField[] {
  return entry.fields.filter(({ name }) => !Object.hasOwn(entry.input, name));
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** The call a command makes for these arguments, after `tiehall <command>`. */
export async function callOf(entry: CommandEntry, tokens: readonly string[], stdin: () => Promise<string>): Promise<CommandCall> {
  const options = optionsOf(entry);
  const byOption = new Map(options.map((field) => [optionOf(field.name), field]));
  const given = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      positional.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith("--") || token.length === 2) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const field = byOption.get(name);
    if (field === undefined) throw usage(entry, `tiehall ${entry.command} has no option ${name}.`);
    if (given.has(field.name)) throw usage(entry, `tiehall ${entry.command} takes ${name} once.`);
    if (equals !== -1) given.set(field.name, token.slice(equals + 1));
    else if (isFlag(field)) given.set(field.name, true);
    else {
      const value = tokens[index + 1];
      if (value === undefined) throw usage(entry, `${name} needs a value.`);
      given.set(field.name, value);
      index += 1;
    }
  }
  if (positional.length > entry.arguments.length) {
    const takes = entry.arguments.length === 0 ? "no arguments" : `at most ${entry.arguments.length}: ${entry.arguments.map((name) => `<${name}>`).join(" ")}`;
    throw usage(entry, `tiehall ${entry.command} takes ${takes}.`);
  }
  positional.forEach((value, index) => {
    const name = entry.arguments[index] ?? "";
    if (given.has(name)) throw usage(entry, `<${name}> is given twice, as an argument and as ${optionOf(name)}.`);
    given.set(name, value);
  });

  const input: Record<string, unknown> = {};
  for (const field of entry.fields) {
    if (Object.hasOwn(entry.input, field.name)) {
      input[field.name] = entry.input[field.name];
      continue;
    }
    const raw = given.get(field.name);
    if (raw !== undefined) input[field.name] = await valueOf(entry, field, raw, stdin);
    else if (Object.hasOwn(entry.defaults, field.name)) input[field.name] = entry.defaults[field.name];
  }

  const call: CommandCall = { path: {}, query: {}, header: {}, body: BODY_METHODS.has(entry.method) ? {} : undefined };
  for (const field of entry.fields) {
    const value = input[field.name];
    if (value === undefined) {
      if (field.in === "path") throw usage(entry, `tiehall ${entry.command} needs <${field.name}>.`);
      continue;
    }
    if (field.in === "path") call.path[field.name] = String(value);
    else if (field.in === "query") call.query[field.name] = value;
    else if (field.in === "header") call.header[field.name] = headerValue(field.name, String(value));
    else if (call.body !== undefined) call.body[field.name] = value;
  }
  return call;
}

/** Whether a field takes only true or false, so that its option is a flag. */
function isFlag(field: CommandField): boolean {
  return field.types.length > 0 && field.types.every((type) => type === "boolean");
}

/** A value given for a field, as the JSON type the field takes. */
async function valueOf(entry: CommandEntry, field: CommandField, raw: string | true, stdin: () => Promise<string>): Promise<unknown> {
  const name = entry.arguments.includes(field.name) ? `<${field.name}>` : optionOf(field.name);
  if (raw === true) return true;
  const { types } = field;
  if (types.includes("object") || types.includes("array")) {
    const text = raw === "-" ? await stdin() : raw.startsWith("@") ? readFile(raw.slice(1), name) : raw;
    try {
      return JSON.parse(text);
    } catch {
      throw usage(entry, `${name} is JSON: give the JSON itself, @<file> for a file that holds it, or - for standard input.`);
    }
  }
  if (raw === "null" && types.includes("null")) return null;
  if (types.includes("boolean") && !types.includes("string")) {
    if (raw === "true" || raw === "false") return raw === "true";
    throw usage(entry, `${name} is true or false.`);
  }
  if ((types.includes("integer") || types.includes("number")) && !types.includes("string")) {
    const number = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(number)) throw usage(entry, `${name} is a number.`);
    return number;
  }
  if (field.values !== undefined && !field.values.includes(raw)) {
    throw usage(entry, `${name} is one of ${field.values.filter((value) => value !== null).join(", ")}.`);
  }
  return raw;
}

function readFile(path: string, name: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliError(`${name} names the file ${path}, which the CLI cannot read.`);
  }
}

/** A header's value: If-Match names a revision by its ETag, so a bare number such as 3 is sent as "3". */
function headerValue(name: string, value: string): string {
  return name.toLowerCase() === "if-match" && /^\d+$/.test(value) ? `"${value}"` : value;
}

function usage(entry: CommandEntry, text: string): CliError {
  return new CliError(`${text} Run tiehall ${entry.command} --help for its arguments and options.`);
}
