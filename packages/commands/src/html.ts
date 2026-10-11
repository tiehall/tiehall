import { randomBytes } from "node:crypto";
import type { HttpProblem, RefusalReason } from "@tiehall/core";
import { assetUrl, STYLESHEET_PATH } from "./asset-urls.ts";
import { markSvg } from "./mark.ts";
import type { RunningVersion } from "./running-version.ts";
import { FOCUSED_SHELL, initialsOf, memberMenu, navigation, NEW_REQUEST_LINK, SIGN_OUT_ACTION, type NavLink, type PageShell, type ShellLink } from "./shell.ts";

// The web role's own HTML pages, such as the setup screen and the review pages
// of the confirmation step, render no raw HTML from anyone (design.md, Design
// rules: Agent safety): every piece of text goes into the page escaped.

/** Text for HTML content or a quoted attribute, with every character that could start or end markup escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// The content security policy of each kind of page (web-ui: The content
// security policy of each kind of page; agent-safety: The review page of the
// confirmation step; design.md, Design: The content security policy of each
// kind of page; D57 (9)), in one place, which every route takes its policy
// from. Every page loads its styles, fonts, images and manifest from the
// install alone, and no other site can frame it; no policy allows
// 'unsafe-inline' or 'unsafe-eval', or names another host but in form-action.
// The pages the web role renders run no script: every decision is made on
// them, and an agent that drives a browser would want a script to help it.
// The pages Next.js renders run only the framework's scripts, which carry the
// nonce made for the answer, and the scripts they load ('strict-dynamic').

/** The directives every page of the web UI shares: nothing by default, and styles, fonts, images and the manifest from the install. */
const LOADS_FROM_THE_INSTALL = ["style-src 'self'", "font-src 'self'", "img-src 'self'", "manifest-src 'self'"] as const;

/**
 * The policy of a page the web role renders, other than the live hall: it
 * runs no script, loads only from the install, posts its forms to the install
 * and to these further sources, such as GitHub's web origin on the setup
 * screen and the sign-in page or an agent client's redirect URI on the
 * consent screen, and cannot be framed.
 */
export function webPagePolicy(formAction: readonly string[] = []): string {
  return ["default-src 'none'", ...LOADS_FROM_THE_INSTALL, "base-uri 'none'", ["form-action 'self'", ...formAction].join(" "), "frame-ancestors 'none'"].join("; ");
}

/** The policy of a JSON answer of the live hall, which loads nothing and cannot be framed. */
export function hallJsonPolicy(): string {
  return "default-src 'none'; frame-ancestors 'none'";
}

/** The API changelog page's policy: the web role's, with no form to post anywhere. */
export function changelogPagePolicy(): string {
  return webPagePolicy().replace("form-action 'self'", "form-action 'none'");
}

/**
 * The policy of a page Next.js renders, a request's page, a team's intake
 * page, the page for a path no route serves and the page shown when one of
 * them fails: scripts run only when they carry the nonce made for this answer,
 * which Next.js puts on its own scripts once the proxy hands it the policy
 * with the call, and the scripts they load; everything else as on every page,
 * with connections to the install only and no plugin. 'self' is not among its
 * script sources, where 'strict-dynamic' makes browsers ignore it.
 */
export function frameworkPagePolicy(nonce: string = randomBytes(18).toString("base64")): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    ...LOADS_FROM_THE_INSTALL,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The headers of a page the web role renders: it runs no script, loads only
 * the install's stylesheet, fonts, images and manifest, posts its forms only
 * to the install and cannot be framed. Its referrer policy keeps its URL from
 * every other site but still lets the browser name the page's origin in the
 * Origin header of the forms it posts to the install, which the web UI's
 * write checks require; with no-referrer, Chrome sends `Origin: null`.
 */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy": webPagePolicy(),
} as const;

// The footer of every page (self-host-install: The running version links to
// its source; design.md, Self-hosting decisions: S16): the running version, a
// link to its source and a link to the docs of the running version
// (docs-pages.ts), for every person who uses the install. The process that
// serves the pages sets it once, from its settings, when it starts serving
// them (web.ts, and the web role's request guard); a page rendered before,
// such as in a test that sets none, has no footer.

/** What the footer shows: the running version with the link to its source, and where its docs are. */
export interface Footer extends RunningVersion {
  docsUrl?: string;
}

let footer: Footer | undefined;

/** Sets the running version, which the footer of every page shows from then on, with the link to its source and to its docs. */
export function showRunningVersion(version: RunningVersion | undefined, docsUrl?: string): void {
  footer = version === undefined ? undefined : { ...version, ...(docsUrl === undefined ? {} : { docsUrl }) };
}

/** The footer's HTML: the running version, the link to its source and the link to its docs; empty until a version is set. */
export function footerHtml(version: Footer | undefined = footer): string {
  if (version === undefined) return "";
  const docs = version.docsUrl === undefined ? "" : ` · <a href="${escapeHtml(version.docsUrl)}">Documentation</a>`;
  return `    <footer>
      <p>${escapeHtml(`Tiehall ${version.version}`)} · <a href="${escapeHtml(version.sourceUrl)}">Source code</a>${docs}</p>
    </footer>
`;
}

// The shell of every page the web role renders (web-ui: The page shell and
// its navigation; web-ui: The mark, the favicon and the app icon; web-ui:
// Light and dark themes follow the system; design.md, Design: The page shell
// and navigation; D57 (4), (5), (10)), drawn from shell.ts's model: the head
// names the install's stylesheet, icons and manifest by their digests and the
// color schemes the page uses; the body starts with the link that skips to the
// main content, then the top bar, the main content and the footer. The app
// shell's menus are details elements, so they open without script; on a
// narrow screen the stylesheet shows the folded menu in place of the
// navigation, New request and the member's menu.

/** The head every page of the web UI carries: its title, the color schemes it uses and its theme colors, the stylesheet, the icons and the manifest. */
export function headHtml(title: string): string {
  return [
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta name="color-scheme" content="light dark">',
    '    <meta name="theme-color" content="#F6F7F9" media="(prefers-color-scheme: light)">',
    '    <meta name="theme-color" content="#0E1117" media="(prefers-color-scheme: dark)">',
    `    <title>${escapeHtml(title)}</title>`,
    `    <link rel="stylesheet" href="${assetUrl(STYLESHEET_PATH)}">`,
    `    <link rel="icon" href="${assetUrl("/assets/icon.svg")}" type="image/svg+xml">`,
    `    <link rel="icon" href="${assetUrl("/favicon.ico")}" sizes="16x16 32x32 48x48">`,
    `    <link rel="apple-touch-icon" href="${assetUrl("/assets/icon-180.png")}">`,
    `    <link rel="manifest" href="${assetUrl("/assets/manifest.webmanifest")}">`,
  ].join("\n");
}

/** The mark on its tile beside the name, as the top bar draws it. */
const BRAND_MARK = `<span class="mark">${markSvg(18)}</span>Tiehall`;

/** A link of the shell, marked as the page shown when it is. */
function shellLink({ href, text, current }: ShellLink, extra = ""): string {
  return `<a href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(text)}${extra}</a>`;
}

/** The navigation's links, the inbox's with the number of proposals that wait for the member, in figures and in words. */
function navigationItems(links: readonly NavLink[], indent: string): string {
  return links
    .map((link) => {
      const badge =
        link.waiting === undefined
          ? ""
          : ` <span class="badge"><span aria-hidden="true">${link.waiting.count}</span><span class="visually-hidden">${escapeHtml(link.waiting.words)}</span></span>`;
      return `${indent}<li>${shellLink(link, badge)}</li>`;
    })
    .join("\n");
}

/** The member's menu's links and their sign-out form, with the session's CSRF token. */
function memberItems(path: string, csrf: string, indent: string): string {
  return [
    ...memberMenu(path).map((link) => `${indent}${shellLink(link)}`),
    `${indent}<form method="post" action="${SIGN_OUT_ACTION}">`,
    `${indent}  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    `${indent}  <button type="submit">Sign out</button>`,
    `${indent}</form>`,
  ].join("\n");
}

/** The top bar of a page: the app shell's, with the navigation and the menus, or the focused shell's, the mark and the name alone. */
export function topBarHtml(shell: PageShell): string {
  if (shell.form === "focused") {
    return [
      '    <header class="topbar">',
      '      <div class="topbar-inner">',
      `        <span class="brand">${BRAND_MARK}</span>`,
      "      </div>",
      "    </header>",
    ].join("\n");
  }
  const { member, path, csrf } = shell;
  const links = navigation(member, path);
  const who = member.bot ? `${member.login} (bot)` : member.login;
  return [
    '    <header class="topbar">',
    '      <div class="topbar-inner">',
    `        <a class="brand" href="/">${BRAND_MARK}</a>`,
    '        <div class="topbar-wide">',
    '          <nav class="nav" aria-label="Main">',
    "            <ul>",
    navigationItems(links, "              "),
    "            </ul>",
    "          </nav>",
    '          <div class="topbar-end">',
    `            <a class="button" href="${NEW_REQUEST_LINK.href}">${NEW_REQUEST_LINK.text}</a>`,
    '            <details class="menu">',
    `              <summary><span class="initials" aria-hidden="true">${escapeHtml(initialsOf(member.login))}</span><span class="login">${escapeHtml(who)}</span></summary>`,
    '              <div class="menu-panel">',
    memberItems(path, csrf, "                "),
    "              </div>",
    "            </details>",
    "          </div>",
    "        </div>",
    '        <details class="menu menu-all">',
    "          <summary>Menu</summary>",
    '          <div class="menu-panel">',
    '            <nav aria-label="Main">',
    "              <ul>",
    navigationItems(links, "                "),
    "              </ul>",
    "            </nav>",
    `            <a class="button" href="${NEW_REQUEST_LINK.href}">${NEW_REQUEST_LINK.text}</a>`,
    `            <p class="menu-who">Signed in as ${escapeHtml(who)}</p>`,
    memberItems(path, csrf, "            "),
    "          </div>",
    "        </details>",
    "      </div>",
    "    </header>",
  ].join("\n");
}

/**
 * The shell around a page's main content: the link that skips to it, the top
 * bar of the page's shell, and one main landmark, which holds the page's one
 * first-level heading. apps/web/lib/shell.tsx draws the same for the pages
 * Next.js renders.
 */
export function shellHtml(shell: PageShell, main: string): string {
  return `    <a class="skip" href="#content">Skip to content</a>
${topBarHtml(shell)}
    <main id="content"${shell.form === "focused" ? (shell.wide === true ? ' class="focused wide"' : ' class="focused"') : ""}>
${main}
    </main>
`;
}

/**
 * A page of the web role, with its title and the HTML of its main content:
 * the head, the shell around the main content, and the footer. A page takes
 * the focused shell unless it is given a member's app shell.
 */
export function htmlPage(title: string, main: string, shell: PageShell = FOCUSED_SHELL): string {
  return `<!doctype html>
<html lang="en">
  <head>
${headHtml(title)}
  </head>
  <body>
${shellHtml(shell, main)}${footerHtml()}  </body>
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

/**
 * Where a page's refusal for this reason leads a browser on: to the sign-in
 * page when the browser is not signed in, and when its person was removed,
 * because a removal ends the person's web sessions, so the page would refuse
 * it again; otherwise the way on the page gives.
 */
export function wayOnFor(reason: RefusalReason, otherwise: WayOn): WayOn {
  return reason === "unauthenticated" || reason === "removed-member" ? TO_SIGN_IN : otherwise;
}

/** Whether a request negotiates HTML on a page route: its Accept header names text/html, as browsers send. */
export function acceptsHtml(request: Request): boolean {
  return namesHtml(request.headers.get("accept"));
}

/** Whether an Accept header names text/html, as browsers send; a request URL negotiates HTML by its own rule (negotiation.ts). */
export function namesHtml(accept: string | null | undefined): boolean {
  return (accept ?? "").split(",").some((range) => range.split(";")[0]?.trim().toLowerCase() === "text/html");
}

/**
 * The page of a refusal (web-ui: The page shell and its navigation; design.md,
 * Design: The page families; D57 (4)): the status as a large mono number, its
 * title, its detail, where the input fails its schema, the way on as a
 * button-styled link and the problem type in mono.
 */
function refusalPage({ body }: HttpProblem, wayOn: WayOn): string {
  const issues = body.errors ?? [];
  return htmlPage(
    body.title,
    [
      '      <div class="refusal">',
      `      <p class="status">${escapeHtml(String(body.status))}</p>`,
      `      <h1>${escapeHtml(body.title)}</h1>`,
      `      <p class="lead">${escapeHtml(body.detail)}</p>`,
      ...(issues.length === 0
        ? []
        : [
            '      <ul class="field-errors">',
            ...issues.map(({ path, message }) => `        <li>${escapeHtml(path.length === 0 ? message : `${path.join(".")}: ${message}`)}</li>`),
            "      </ul>",
          ]),
      `      <p><a class="button" href="${escapeHtml(wayOn.href)}">${escapeHtml(wayOn.text)}</a></p>`,
      `      <p class="problem-type">Problem type: <code>${escapeHtml(body.type)}</code></p>`,
      "      </div>",
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
