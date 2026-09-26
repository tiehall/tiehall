import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_CHANGELOG } from "@tiehall/catalog/api-changelog";
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

  it("runs no script and loads nothing, under a strict Content-Security-Policy", async () => {
    const { response, html } = await page();
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<form/i);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]+=*'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
    // The hash is the page's one style element.
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    const { createHash } = await import("node:crypto");
    expect(policy).toContain(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
  });
});

describe("the /docs/api/changelog route", () => {
  it("answers anyone, without signing in, with the changelog the build carries", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(await changelogPage(API_CHANGELOG).text());
  });
});
