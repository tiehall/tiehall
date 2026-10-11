// Reading the markup a page is served with, for the tests of the pages' look
// (web-ui: Pages are accessible; design.md, Design: Accessibility; D57 (8)):
// one element by its opening tag, the page's main content, and every way the
// main content puts an action or a field outside the rules.

/** The markup of one element, by its opening tag, up to its own end tag; empty when the page has none. */
export function element(html: string, opening: RegExp, tag: string): string {
  const start = html.search(opening);
  if (start < 0) return "";
  let depth = 0;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  pattern.lastIndex = start;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, pattern.lastIndex);
  }
  return html.slice(start);
}

/** The page's main content. */
export function mainOf(html: string): string {
  return /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
}

/**
 * Every way the main content puts an action or a field outside the rules: a
 * field that neither a label names by its id nor sits inside a label, a link
 * with no href, a button that is not a form's submit button, and an event
 * handler in the markup.
 */
export function controlProblems(main: string): string[] {
  const problems: string[] = [];
  const labelled = new Set([...main.matchAll(/<label for="([^"]+)"/g)].map(([, id]) => id));
  // A control inside a label is named by it.
  const unwrapped = main.replace(/<label\b(?![^>]*\bfor=)[^>]*>[\s\S]*?<\/label>/g, "");
  for (const [control, id] of unwrapped.matchAll(/<(?:input(?![^>]*type="hidden")|select|textarea)\b[^>]*\bid="([^"]+)"/g)) if (!labelled.has(id)) problems.push(`no label: ${control}`);
  for (const [control] of unwrapped.matchAll(/<(?:input(?![^>]*type="hidden")|select|textarea)\b(?![^>]*\bid=)[^>]*>/g)) problems.push(`no label: ${control}`);
  for (const [anchor] of main.matchAll(/<a\b(?![^>]*\bhref=)[^>]*>/g)) problems.push(`a link with no href: ${anchor}`);
  for (const [button] of main.matchAll(/<button\b(?![^>]*type="submit")[^>]*>/g)) problems.push(`a button that submits no form: ${button}`);
  for (const [handler] of main.matchAll(/\son[a-z]+=/g)) problems.push(`an event handler: ${handler}`);
  return problems;
}
