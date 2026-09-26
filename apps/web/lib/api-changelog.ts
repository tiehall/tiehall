import { createHash } from "node:crypto";
import { releaseItems, type Changelog, type ChangelogItem, type ChangelogRelease } from "@tiehall/catalog/changelog";

// The API changelog page at /docs/api/changelog (public-api: The changelog
// page and the release notes; D28 #28). It lists the API changes of every
// release in openapi/changelog.json, newest first, which the build carries,
// so an install lists every release up to the one it runs; entries no release
// carries yet are listed first, as not released. Each release shows the same
// items as its release notes (releaseItems). Anyone may read it, without
// signing in. The page is plain HTML: it runs no script and loads nothing,
// under a policy that allows only its one style element, by its hash.

const STYLE = [
  "body{margin:0;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1b1b;background:#fff}",
  "main{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 4rem}",
  "h1{font-size:1.75rem;margin:0 0 .5rem}h2{font-size:1.25rem;margin:2.5rem 0 .25rem}",
  ".meta{color:#5c5c5c;margin:0 0 .75rem}ul{padding-left:1.25rem}li{margin:.35rem 0}",
  "code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f2f2;border-radius:3px;padding:0 .25em}",
  ".label{font-weight:600}.label.breaking{color:#b3261e}.label.warning{color:#8a5a00}",
  "@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#141414}.meta{color:#a6a6a6}code{background:#262626}",
  ".label.breaking{color:#ff8a80}.label.warning{color:#ffcc80}}",
].join("");

const POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": POLICY,
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const LABELS: Readonly<Record<ChangelogItem["kind"], { text: string; tone: string } | undefined>> = {
  breaking: { text: "Breaking", tone: "breaking" },
  note: { text: "Note", tone: "note" },
  error: { text: "Breaking", tone: "breaking" },
  warning: { text: "Warning", tone: "warning" },
  info: undefined,
};

/** The page for this changelog. */
export function changelogPage(changelog: Changelog): Response {
  const sections: string[] = [];
  if (changelog.unreleased.length > 0) {
    sections.push(section("Not released yet", "These entries are in no release yet: this install runs a build made between releases.", releaseItems({ entries: changelog.unreleased, changes: [] })));
  }
  for (const release of changelog.releases) sections.push(releaseSection(release));
  if (changelog.releases.length === 0 && changelog.unreleased.length === 0) sections.push("<p>No release has changed the API yet.</p>");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tiehall API changelog</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>API changelog</h1>
<p>The changes to the REST API under <code>/api/v1</code>, release by release, newest first. A breaking change to a beta operation is announced by deprecating it with a sunset date at least 14 days ahead, and to a stable one at least 180 days ahead, before it is removed; only an urgent security fix skips that notice, and it is listed here. The reference is at <a href="/docs/api">/docs/api</a>, and the OpenAPI document at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>
${sections.join("\n")}
</main>
</body>
</html>
`;
  return new Response(html, { headers: HEADERS });
}

function releaseSection(release: ChangelogRelease): string {
  const items = releaseItems(release);
  return section(`Release ${release.version}`, `${release.date} · API version ${release.apiVersion}`, items, `release-${release.version}`);
}

function section(title: string, meta: string, items: ChangelogItem[], id?: string): string {
  const list = items.length === 0 ? "<p>No change to the API.</p>" : `<ul>\n${items.map((item) => `<li>${line(item)}</li>`).join("\n")}\n</ul>`;
  return `<section${id === undefined ? "" : ` id="${escape(id)}"`}>\n<h2>${escape(title)}</h2>\n<p class="meta">${escape(meta)}</p>\n${list}\n</section>`;
}

function line(item: ChangelogItem): string {
  const label = LABELS[item.kind];
  const lead = [
    ...(label === undefined ? [] : [`<span class="label ${label.tone}">${label.text}</span>`]),
    ...(item.method !== undefined && item.path !== undefined ? [`<code>${escape(`${item.method} ${item.path}`)}</code>`] : []),
    ...(item.operationIds !== undefined && item.operationIds.length > 0 ? [`(${escape(item.operationIds.join(", "))})`] : []),
  ];
  return `${lead.length === 0 ? "" : `${lead.join(" ")}: `}${withCode(item.text)}`;
}

/** Text with its `backticked` names and values as code, everything escaped. */
function withCode(text: string): string {
  return escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
