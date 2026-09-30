import manifest from "../package.json" with { type: "json" };

/** The CLI's version, from its package.json. */
export const CLI_VERSION: string = manifest.version;

/** The oldest Node.js release line the CLI runs on, as its package.json's engines field says (agent-surfaces: The CLI package). */
export const NODE_MAJOR_MINIMUM = 22;
