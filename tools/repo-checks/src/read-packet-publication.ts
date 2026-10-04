import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { packetPublication } from "./packet-publication.ts";

// Prints the packet's publication as step outputs for the CI job that
// publishes @tiehall/packet (handoff-packet: The npm package): published=true
// and the package's version once the release-URL tree holds a release, and
// published=false before, which keeps the job off. What it found goes to
// standard error, for the job's log.
// Usage: node tools/repo-checks/src/read-packet-publication.ts [repository root] >> "$GITHUB_OUTPUT"

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../", import.meta.url)));
const publication = packetPublication(root);
process.stdout.write(`published=${publication.published}\nversion=${publication.published ? publication.version : ""}\n`);
console.error(
  publication.published
    ? `The packet schema is published; @tiehall/packet is published as ${publication.version}.`
    : "No release of the packet schema is published yet, so @tiehall/packet is not published.",
);
