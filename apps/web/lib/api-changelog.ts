import { docsUrl } from "@tiehall/commands/docs-pages";
import { changelogPagePolicy, footerHtml, headHtml, shellHtml } from "@tiehall/commands/html";
import { runningVersion } from "@tiehall/commands/running-version";
import { FOCUSED_SHELL } from "@tiehall/commands/shell";
import { releaseItems, type Changelog, type ChangelogItem, type ChangelogRelease } from "@tiehall/catalog/changelog";

// The API changelog page at /docs/api/changelog (public-api: The changelog
// page and the release notes; D28 #28). It lists the API changes of every
// release in openapi/changelog.json, newest first, which the build carries,
// so an install lists every release up to the one it runs; entries no release
// carries yet are listed first, as not released. Each release shows the same
// items as its release notes (releaseItems). Anyone may read it, without
// signing in. The page is plain HTML: it runs no script, takes its look from
// the install's stylesheet and loads nothing else, and has no form to post
// anywhere (web-ui: The content security policy of each kind of page; web-ui:
// One stylesheet with named design tokens; D57 (9)).

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": changelogPagePolicy(),
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const LABELS: Readonly<Record<ChangelogItem["kind"], { text: string; tone: string } | undefined>> = {
  breaking: { text: "Breaking", tone: "breaking" },
  note: { text: "Note", tone: "note" },
  graduation: { text: "Graduated", tone: "graduation" },
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
  const main = `<div class="changelog">
<h1>API changelog</h1>
<p class="lead">The changes to the REST API under <code>/api/v1</code>, release by release, newest first. A breaking change to a beta operation is announced by deprecating it with a sunset date at least 14 days ahead, and to a stable one at least 180 days ahead, before it is removed; only an urgent security fix skips that notice, and it is listed here. The reference is at <a href="/docs/api">/docs/api</a>, and the OpenAPI document at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>
${sections.join("\n")}
</div>`;
  // The focused shell, the head and the footer every page of the web UI carries (web-ui: The page shell and its navigation).
  const html = `<!doctype html>
<html lang="en">
  <head>
${headHtml("Tiehall API changelog")}
  </head>
  <body>
${shellHtml(FOCUSED_SHELL, main)}${footerHtml({ ...runningVersion(process.env), docsUrl: docsUrl(process.env) })}  </body>
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
  return `<section class="panel"${id === undefined ? "" : ` id="${escape(id)}"`}>\n<h2>${escape(title)}</h2>\n<p class="muted">${escape(meta)}</p>\n${list}\n</section>`;
}

function line(item: ChangelogItem): string {
  const label = LABELS[item.kind];
  const lead = [
    ...(label === undefined ? [] : [`<span class="chip ${label.tone}">${label.text}</span>`]),
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
