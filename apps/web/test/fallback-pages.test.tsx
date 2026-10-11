import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GlobalError from "../app/global-error.tsx";
import NotFound from "../app/not-found.tsx";

// The web app's own pages for a path no route serves and for a page that fails
// while it renders (web-ui: The content security policy of each kind of page;
// web-ui: The page shell and its navigation; design.md, Design: The content
// security policy of each kind of page; D57 (9)). The framework's default
// pages carry an inline style element and style attributes, which the
// framework pages' policy, with styles from the install alone, would block;
// the app's own replace them, and hold neither.

describe("the web app's own fallback pages", () => {
  it("are the page for a path no route serves, with no style element or attribute", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain("<h1>");
    expect(html).not.toMatch(/<style\b|\sstyle=/i);
  });

  it("are the page shown when rendering a page fails, with its own html and body and no style element or attribute", () => {
    const html = renderToStaticMarkup(<GlobalError error={Object.assign(new Error("A page failed."), { digest: "123" })} />);
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain("<body");
    expect(html).toContain("<h1>");
    expect(html).not.toMatch(/<style\b|\sstyle=/i);
    expect(html).not.toContain("A page failed.");
  });
});
