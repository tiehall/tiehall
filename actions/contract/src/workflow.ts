import { appendFileSync } from "node:fs";

// What a step of GitHub Actions hands its runner (contract-changes: The
// contract Action): its inputs, as INPUT_<NAME> variables; annotations, as
// workflow commands on its standard output; its outputs, into the file
// GITHUB_OUTPUT names; and its job summary, markdown appended to the file
// GITHUB_STEP_SUMMARY names. Only Node.js's own modules are used, so the Action
// runs from the repository at the commit a workflow pins, with nothing to
// install.

/** An input of the step, as the runner hands it: INPUT_ and the input's name in upper case, hyphens kept. */
export function inputOf(env: Readonly<Record<string, string | undefined>>, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** A boolean input: true, false or empty, which is the default; anything else is refused. */
export function booleanInputOf(env: Readonly<Record<string, string | undefined>>, name: string, fallback: boolean): boolean {
  const value = inputOf(env, name).toLowerCase();
  if (value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InputError(`The input ${name} is true or false, not ${JSON.stringify(inputOf(env, name))}.`);
}

/** An input the workflow gave that the Action cannot use: the step fails and says why. */
export class InputError extends Error {
  override name = "InputError";
}

/** A workflow command's message, escaped as the runner reads it. */
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A workflow command's property, escaped as the runner reads it. */
function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** An annotation, as a workflow command: an error, a warning or a notice, with a title. */
export function annotation(level: "error" | "warning" | "notice", title: string, message: string): string {
  return `::${level} title=${escapeProperty(title)}::${escapeData(message)}\n`;
}

/** Sets the step's outputs, in the file GITHUB_OUTPUT names; nothing when the runner names none. */
export function setOutputs(env: Readonly<Record<string, string | undefined>>, outputs: Readonly<Record<string, string>>): void {
  const file = env["GITHUB_OUTPUT"];
  if (file === undefined || file === "") return;
  const lines = Object.entries(outputs).map(([name, value]) => {
    const delimiter = `tiehall_${Math.random().toString(36).slice(2)}`;
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  });
  appendFileSync(file, lines.join(""));
}

/** Appends markdown to the job summary, in the file GITHUB_STEP_SUMMARY names; nothing when the runner names none. */
export function appendSummary(env: Readonly<Record<string, string | undefined>>, markdown: string): void {
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file === undefined || file === "") return;
  appendFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

/** Text in a fenced code block of the job summary, whose fence is longer than any run of backticks in it. */
export function codeBlock(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.endsWith("\n") ? text : `${text}\n`}${fence}\n`;
}
