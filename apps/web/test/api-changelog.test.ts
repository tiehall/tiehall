import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_CHANGELOG } from "@tiehall/catalog/api-changelog";
import { assetUrl } from "@tiehall/commands/assets";
import { parseChangelog } from "@tiehall/catalog/changelog";
import { GET } from "../app/docs/api/changelog/route.ts";
import { changelogPage } from "../lib/api-changelog.ts";

// The changelog page at /docs/api/changelog (public-api: The changelog page
// and the release notes). Every install lists the API changes of every
// release up to the one it runs, from openapi/changelog.json, which each
// release's oasdiff changelog is recorded in; anyone may read it. The fixture
// is the changelog after release 1.4.0 is recorded, the same file the release
// tooling's test produces: 1.4.0 deprecates requests.list with a sunset date
// and adds an optional response field to requests.get.

const fixture = parseChangelog(
  readFileSync(new URL("../../../tools/repo-checks/test/fixtures/api-changelog/changelog-after.json", import.meta.url), "utf8"),
);

async function page(changelog = fixture): Promise<{ response: Response; html: string; text: string }> {
  const response = changelogPage(changelog);
  const html = await response.text();
  const text = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#96;/g, "`")
    .replace(/\s+/g, " ");
  return { response, html, text };
}

describe("the changelog page", () => {
  it("lists a release's deprecation with its sunset date and its new optional field", async () => {
    const { response, text } = await page();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(text).toContain("Release 1.4.0");
    expect(text).toContain("GET /api/v1/requests (requests.list): endpoint deprecated with sunset date 2026-12-15 (stability: beta)");
    expect(text).toContain("GET /api/v1/requests/{key} (requests.get): added the optional property title to the response with the 200 status");
    expect(text).toContain("Note (requests.list): requests.list is deprecated: read a team's requests with its search operation instead.");
  });

  // public-api: Each operation graduates on its own: the release that marks an operation stable records the decision.
  it("lists the maintainers' decision to graduate an operation", async () => {
    const graduation = { date: "2026-11-02", kind: "graduation" as const, text: "requests.get is stable after four weeks with no breaking change.", operationIds: ["requests.get"] };
    const { text } = await page({ ...fixture, releases: [{ version: "1.5.0", date: "2026-11-03", apiVersion: "0.3.0", entries: [graduation], changes: [] }, ...fixture.releases] });
    expect(text).toContain("Graduated (requests.get): requests.get is stable after four weeks with no breaking change.");
  });

  it("lists every release, newest first, with its day and the API's version", async () => {
    const { text } = await page();
    expect(text.indexOf("Release 1.4.0")).toBeLessThan(text.indexOf("Release 1.3.0"));
    expect(text).toContain("2026-12-01 · API version 0.3.0");
    expect(text).toContain("GET /api/v1/requests (requests.list): endpoint added");
  });

  it("marks names and values as code, and escapes every text it shows", async () => {
    const hostile = parseChangelog(
      JSON.stringify({
        unreleased: [{ date: "2026-12-02", kind: "breaking", text: "Drops <script>alert(1)</script> & `x-old`." }],
        releases: [],
      }),
    );
    const { html, text } = await page(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; <code>x-old</code>.");
    expect(text).toContain("Not released yet");
    expect(text).toContain("Breaking: Drops");
  });

  it("says so when no release has changed the API yet", async () => {
    const { text } = await page(parseChangelog('{"unreleased": [], "releases": []}'));
    expect(text).toContain("No release has changed the API yet.");
  });

  // It takes its look from the install's stylesheet, and carries no style element or attribute (web-ui: The content
  // security policy of each kind of page; web-ui: One stylesheet with named design tokens; D57 (9)).
  it("runs no script and loads only the install's stylesheet, under a strict Content-Security-Policy", async () => {
    const { response, html } = await page();
    expect(html).not.toMatch(/<script|<img|<iframe|<form|<style|\sstyle=/i);
    expect([...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag)).toContain(`<link rel="stylesheet" href="${assetUrl("/assets/tiehall.css")}">`);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});

// It takes the focused shell of every page that reads one message: the mark and the name, no navigation, its releases
// as panels, and the footer with the running version (web-ui: The page shell and its navigation; D57 (4)).
describe("the changelog page's shell", () => {
  it("takes the focused shell, with the skip link, the head every page carries and the footer", async () => {
    const { html } = await page();
    expect(html).toMatch(/<body>\s*<a class="skip" href="#content">Skip to content<\/a>\s*<header class="topbar">/);
    expect(html).toContain('<main id="content" class="focused">');
    expect(html).not.toMatch(/<nav\b/);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(`<link rel="icon" href="${assetUrl("/assets/icon.svg")}" type="image/svg+xml">`);
    expect(html).toMatch(/<section class="panel" id="release-1\.4\.0">\s*<h2>Release 1\.4\.0<\/h2>/);
    expect(html).toMatch(/<footer>\s*<p>Tiehall [^<]+ · <a href="[^"]+">Source code<\/a>/);
  });
});

describe("the /docs/api/changelog route", () => {
  it("answers anyone, without signing in, with the changelog the build carries", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(await changelogPage(API_CHANGELOG).text());
  });
});
