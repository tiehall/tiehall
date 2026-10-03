import { dockerOk } from "./docker.ts";

// The packages an image holds (self-host-install: No model calls;
// self-host-install: No telemetry and a documented list of outbound
// connections), for the check that runs the denylists of tools/repo-checks
// over the built image as well as over the package.json files and the
// lockfile. A package can reach the image three ways, and each leaves a trace
// under /app that this finds:
// - installed: a package.json in a node_modules folder, with its name and
//   version;
// - bundled into the server's bundle or a route's: a source map whose sources
//   go through a node_modules folder;
// - bundled where no source map is kept, as in the web app's chunks: a path
//   through a node_modules folder that the bundler left in the code, such as
//   the module ids Next.js writes, with the version where the path goes
//   through pnpm's store (node_modules/.pnpm/<name>@<version>/).
// A bundle that keeps none of these, such as a prebuilt browser bundle a
// package ships, is seen only as the package that ships it.

/** One trace of a package in the image: where it was found, the package's name, and its version where the trace gives one. */
export interface ImagePackage {
  file: string;
  name: string;
  version: string;
}

/** The script that walks /app in the image and prints each trace it finds as a line of JSON. */
const LIST_PACKAGES = String.raw`
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const seen = new Set();
const print = (file, name, version) => {
  if (!/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)) return;
  const key = file + " " + name + " " + version;
  if (seen.has(key)) return;
  seen.add(key);
  console.log(JSON.stringify({ file, name, version }));
};
const STORE = /node_modules\/\.pnpm\/((?:@[^\/+]+\+)?[^\/@]+)@([^\/_(]+)[^\/]*\/node_modules\//g;
const PLAIN = /node_modules\/((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)\//gi;
const tracesIn = (file, text) => {
  for (const match of text.matchAll(STORE)) print(file, match[1].replace("+", "/"), match[2]);
  for (const match of text.matchAll(PLAIN)) if (match[1] !== ".pnpm") print(file, match[1], "");
};
const walk = (folder) => {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) {
      if (entry.name === "package.json" && path.includes("/node_modules/")) {
        try {
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          if (typeof manifest.name === "string") print(path, manifest.name, typeof manifest.version === "string" ? manifest.version : "");
        } catch {}
      } else if (entry.name.endsWith(".map")) {
        try {
          const map = JSON.parse(readFileSync(path, "utf8"));
          const sources = [...(map.sources || []), ...(map.sections || []).flatMap((section) => (section.map && section.map.sources) || [])];
          tracesIn(path, sources.join("\n") + "\n");
        } catch {}
      } else if (/\.(c|m)?js$/.test(entry.name) && statSync(path).size < 64 * 1024 * 1024) {
        tracesIn(path, readFileSync(path, "utf8"));
      }
    }
  }
};
walk("/app");
`;

/** Every trace of a package under /app in the image, read by running the image's own node, with no network. */
export function imagePackages(image: string): ImagePackage[] {
  const output = dockerOk(["run", "--rm", "--network", "none", "--entrypoint", "node", image, "--eval", LIST_PACKAGES], 300);
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ImagePackage);
}
