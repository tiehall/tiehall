// tiehall: the command line of Tiehall (agent-surfaces: The CLI package;
// agent-surfaces: CLI request commands). It takes its request commands from
// the OpenAPI document through @tiehall/client, and imports no server code
// (public-api: The license map). `run()` runs one command with the arguments
// after `tiehall`; the `tiehall` command runs it with the process's own.

export { run } from "./run.ts";
export { CliError, type CliEnvironment } from "./environment.ts";
export { CLI_VERSION, NODE_MAJOR_MINIMUM, OASDIFF_MINIMUM } from "./version.ts";
