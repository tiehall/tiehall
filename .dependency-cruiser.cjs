// Import rules for the monorepo (design.md, Technical decisions: T2 and
// Self-hosting decisions: S16; public-api: One definition per operation, the
// same on every surface; public-api: The license map). CI runs them with
// `pnpm lint:deps`; tools/repo-checks tests each rule against fixtures.
//
// A module shows up in a rule either by its resolved path (for example
// packages/db/src/index.ts, or node_modules/.pnpm/pg@8/node_modules/pg/...) or,
// when it cannot be resolved, by the name it was imported as (for example
// @tiehall/db or pg). Every pattern below matches both forms.

/** Matches npm packages by name, resolved or not. A name ending in "/" is a scope. */
function npm(...names) {
  const alternatives = names
    .map((name) => (name.endsWith("/") ? `${name}[^/]+` : name))
    .map((name) => name.replaceAll(".", "\\."))
    .join("|");
  return `(^|/)node_modules/(${alternatives})/|^(${alternatives})(/|$)`;
}

/** Matches Node built-in modules, with or without the node: prefix. */
function builtin(...names) {
  return `^(node:)?(${names.join("|")})(/|$)`;
}

/** Matches a workspace package by its folder or by its package name. */
function workspace(folder, name) {
  return `^${folder}/|^${name.replace("/", "\\/")}(/|$)`;
}

const DB_PACKAGE = workspace("packages/db", "@tiehall/db");
const COMMANDS_PACKAGE = workspace("packages/commands", "@tiehall/commands");
const WEB_APP = workspace("apps/web", "@tiehall/web");
const TEST_HARNESS = workspace("packages/testing", "@tiehall/testing");

const DATABASE_MODULES = npm("pg", "pg-pool", "pg-cursor", "pg-copy-streams", "postgres", "drizzle-orm", "drizzle-kit");
const QUEUE_MODULES = npm("pg-boss");
const NETWORK_MODULES = [
  builtin("net", "http", "https", "http2", "tls", "dgram", "dns"),
  npm(
    "undici",
    "ws",
    "node-fetch",
    "axios",
    "got",
    "ky",
    "octokit",
    "@octokit/",
    "@modelcontextprotocol/",
    "better-auth",
    "@better-auth/",
    "nodemailer",
    "@sentry/",
  ),
];
// packages/core holds the pure domain rules, with no I/O at all (T2).
const OTHER_IO_MODULES = builtin("fs", "child_process", "cluster", "worker_threads");

// The Apache-2.0 client pieces of S16, by folder and package name. Every other
// workspace package is AGPL-3.0 server code, the command catalog included.
const APACHE_2_0_PACKAGES = [
  { folder: "packages/cli", name: "tiehall" },
  { folder: "packages/client", name: "@tiehall/client" },
  { folder: "packages/claude-plugin", name: "@tiehall/claude-plugin" },
  { folder: "actions/contract", name: "@tiehall/contract-action" },
  // The packet schema directory, from which @tiehall/packet is built.
  { folder: "packages/packet", name: "@tiehall/packet" },
];
const APACHE_2_0_FOLDERS = APACHE_2_0_PACKAGES.map(({ folder }) => `^${folder}/`);
const APACHE_2_0_MODULES = APACHE_2_0_PACKAGES.flatMap(({ folder, name }) => [`^${folder}/`, npm(name)]);
// Every workspace package, by folder or by package name.
const WORKSPACE_MODULES = ["^(apps|packages|actions|tools)/", npm("@tiehall/", "tiehall")];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "db-only-from-commands-and-migrations",
      comment:
        "Only packages/commands and the migrations (which live in packages/db) may import packages/db, so every " +
        "domain command the UI runs passes the same authorization as an agent's (design.md, T2).",
      severity: "error",
      from: { pathNot: ["^packages/db/", "^packages/commands/"] },
      to: { path: DB_PACKAGE },
    },
    {
      name: "catalog-holds-no-database-code",
      comment: "packages/catalog holds the command definitions and no database code (design.md, T2).",
      severity: "error",
      from: { path: "^packages/catalog/" },
      to: { path: [DB_PACKAGE, COMMANDS_PACKAGE, DATABASE_MODULES, QUEUE_MODULES] },
    },
    {
      name: "core-does-no-io",
      comment:
        "packages/core imports no database, queue or network module, and no workspace package that does I/O " +
        "(design.md, T2).",
      severity: "error",
      from: { path: "^packages/core/" },
      to: {
        path: [
          DATABASE_MODULES,
          QUEUE_MODULES,
          ...NETWORK_MODULES,
          OTHER_IO_MODULES,
          DB_PACKAGE,
          COMMANDS_PACKAGE,
          WEB_APP,
          TEST_HARNESS,
        ],
      },
    },
    {
      name: "apache-2.0-imports-no-agpl-3.0",
      comment:
        "An Apache-2.0 client piece imports no AGPL-3.0 code: of the workspace packages it may import only the " +
        "other Apache-2.0 pieces, so the CLI takes its commands from the OpenAPI document through @tiehall/client " +
        "and never imports the catalog (design.md, S16; public-api: The license map).",
      severity: "error",
      from: { path: APACHE_2_0_FOLDERS },
      to: { path: WORKSPACE_MODULES, pathNot: APACHE_2_0_MODULES },
    },
  ],
  options: {
    // Record imports of npm packages, but never read inside them.
    doNotFollow: { path: "(^|/)node_modules/" },
    // Not code, or not ours: agent state, spikes, the OpenSpec plan, build
    // output (Next.js and the bundled entrypoint) and the fixtures that break
    // these rules on purpose.
    exclude: {
      path: [
        "^\\.claude/",
        "^spikes/",
        "^openspec/",
        "(^|/)\\.next/",
        "^(apps|packages|actions|tools)/[^/]+/dist/",
        "^tools/repo-checks/test/fixtures/",
      ],
    },
    // Type-only imports count too.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
  },
};
