import type { HttpProblem } from "@tiehall/core";

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

// Refusals to browsers (public-api: One error model for Tiehall's own
// refusals; github-layer-hardening: design.md, Decisions this change rests
// on: D50 (7); Technical decisions: T5). On the routes that serve the web UI's
// pages, the setup screen, the review pages and confirmations under
// /confirm/… and GitHub's return to either sign-in callback, a refusal to a
// request whose Accept header names text/html, as browsers send, is an HTML
// page with the refusal's status: its title and detail in Tiehall's own words,
// escaped, where the input fails its schema, the problem type in the markup,
// and a link on. Every other request gets the RFC 9457 problem. Either answer
// has the page headers' content security policy, so it cannot be framed, and
// keeps the problem's own headers, such as Retry-After. One function decides
// for every such route, as one function renders every page, and for the web
// role's request guard, which refuses on those routes before any of them sees
// the call (page-routes.ts).

/** Where a refusal page leads on: back to the page whose form was refused, to the page that was asked for, or to the sign-in page. */
export interface WayOn {
  href: string;
  text: string;
}

/** The way on for a refused sign-in, or a browser that is not signed in. */
export const TO_SIGN_IN: WayOn = { href: "/sign-in", text: "Go to the sign-in page" };

/** Whether a request negotiates HTML on a page route: its Accept header names text/html, as browsers send. */
export function acceptsHtml(request: Request): boolean {
  return namesHtml(request.headers.get("accept"));
}

/** Whether an Accept header names text/html, as browsers send; a request URL negotiates HTML by its own rule (negotiation.ts). */
export function namesHtml(accept: string | null | undefined): boolean {
  return (accept ?? "").split(",").some((range) => range.split(";")[0]?.trim().toLowerCase() === "text/html");
}

/** The page of a refusal: its title, its detail, where the input fails its schema, the way on and the problem type. */
function refusalPage({ body }: HttpProblem, wayOn: WayOn): string {
  const issues = body.errors ?? [];
  return htmlPage(
    body.title,
    [
      `      <h1>${escapeHtml(body.title)}</h1>`,
      `      <p>${escapeHtml(body.detail)}</p>`,
      ...(issues.length === 0
        ? []
        : [
            "      <ul>",
            ...issues.map(({ path, message }) => `        <li>${escapeHtml(path.length === 0 ? message : `${path.join(".")}: ${message}`)}</li>`),
            "      </ul>",
          ]),
      `      <p><a href="${escapeHtml(wayOn.href)}">${escapeHtml(wayOn.text)}</a></p>`,
      `      <p>Problem type: <code>${escapeHtml(body.type)}</code></p>`,
    ].join("\n"),
  );
}

/** A refusal's answer on a page route, as its status, headers and body. */
export interface RefusalAnswer {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * The answer to a refusal on a page route, for a request with this Accept
 * header: the refusal's page when the header names text/html, the problem
 * otherwise; with the problem's headers, any headers given, such as the
 * cookies a sign-in's answer clears, and the page headers' content security
 * policy. answerRefusal() gives it as a Response; a server that answers before
 * any route sees the call, such as the web role's request guard, writes it
 * itself.
 */
export function refusalAnswer(accept: string | null | undefined, problem: HttpProblem, wayOn: WayOn, headers: Headers = new Headers()): RefusalAnswer {
  return refusalAnswerAs(namesHtml(accept), problem, wayOn, headers);
}

/**
 * The answer to a refusal on a page route whose call negotiates HTML, or
 * does not, as the route decides it: a request URL by its own negotiation,
 * which takes a call with no Accept header, or one that accepts any type, for
 * HTML too (negotiation.ts), and every other page route by refusalAnswer()'s
 * Accept header.
 */
export function refusalAnswerAs(html: boolean, problem: HttpProblem, wayOn: WayOn, headers: Headers = new Headers()): RefusalAnswer {
  const answer = new Headers(problem.headers);
  for (const cookie of headers.getSetCookie()) answer.append("set-cookie", cookie);
  answer.set("content-security-policy", PAGE_HEADERS["content-security-policy"]);
  if (!html) return { status: problem.status, headers: answer, body: JSON.stringify(problem.body) };
  for (const [name, value] of Object.entries(PAGE_HEADERS)) answer.set(name, value);
  return { status: problem.status, headers: answer, body: refusalPage(problem, wayOn) };
}

/** Answers a refusal on a page route: refusalAnswer() for the request's Accept header, as a Response. */
export function answerRefusal(request: Request, problem: HttpProblem, wayOn: WayOn, headers: Headers = new Headers()): Response {
  const { status, headers: answer, body } = refusalAnswer(request.headers.get("accept"), problem, wayOn, headers);
  return new Response(body, { status, headers: answer });
}
