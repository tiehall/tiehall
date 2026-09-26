import { parseArgs } from "node:util";
import { SettingsError } from "@tiehall/commands";
import { initEnv, type ImageBuild } from "./env-file.ts";

// The init role (self-host-install: `init` prints a complete `.env`):
//   docker run --rm <image> init --url https://tiehall.example.com > .env
// prints every install setting with fresh random secrets. Its standard output
// is the file, so it logs nothing there: a refusal is one plain line on
// standard error, and then nothing is printed. It reads no other setting and
// connects to nothing.

export const INIT_USAGE = "Usage: main.mjs init --url <https://tiehall.example.com> [--image <image@sha256:digest>]";

export interface InitOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Runs the init role and returns its exit code: 0, 1 for a URL the install would refuse, 2 for a usage error. */
export function runInitRole(args: readonly string[], build: ImageBuild, output: InitOutput): number {
  let url: string | undefined;
  let image: string | undefined;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { url: { type: "string" }, image: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    url = values.url;
    image = values.image;
  } catch {
    url = undefined;
  }
  if (url === undefined || url === "" || image === "") {
    output.stderr(`${INIT_USAGE}\n`);
    return 2;
  }
  let env: string;
  try {
    env = initEnv({ url, build, ...(image === undefined ? {} : { image }) });
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    output.stderr(`tiehall init: ${error.message}\n`);
    return 1;
  }
  output.stdout(env);
  return 0;
}
