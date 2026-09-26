// The web role's own HTML pages, such as the setup screen and the review pages
// of the confirmation step, render no raw HTML from anyone (design.md, Design
// rules: Agent safety): every piece of text goes into the page escaped.

/** Text for HTML content or a quoted attribute, with every character that could start or end markup escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * The headers of a page that runs no script, loads nothing, posts its forms
 * only to the install and cannot be framed. Its referrer policy keeps its URL
 * from every other site but still lets the browser name the page's origin in
 * the Origin header of the forms it posts to the install, which the web UI's
 * write checks require; with no-referrer, Chrome sends `Origin: null`.
 */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
} as const;

/** A page of the web role, with its title and the HTML of its main content. */
export function htmlPage(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
${main}
    </main>
  </body>
</html>
`;
}
