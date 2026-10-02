import manifest from "../package.json" with { type: "json" };

/** The CLI's version, from its package.json. */
export const CLI_VERSION: string = manifest.version;

/**
 * The header in which every call of the CLI names its version, so the install
 * can tell a CLI older than it supports to upgrade (public-api: The CLI sends
 * its version and the server keeps a minimum).
 */
export const CLI_VERSION_HEADER = "tiehall-cli-version";

/** The oldest Node.js release line the CLI runs on, as its package.json's engines field says (agent-surfaces: The CLI package). */
export const NODE_MAJOR_MINIMUM = 22;

/**
 * The oldest diff engine `tiehall contract diff` runs: oasdiff at the release
 * Tiehall pins, which the contract Action runs too (contract-changes:
 * Attaching a contract diff to a request by hand; design.md, Technical
 * decisions: T12). An older oasdiff on the developer's PATH is refused.
 */
export const OASDIFF_MINIMUM = "1.32.1";
