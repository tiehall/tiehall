// The page shell's one description (web-ui: The page shell and its
// navigation; design.md, Design: The page shell and navigation; D57 (4)).
// Every page of the web UI shares one shell: a link that skips to the main
// content, the top bar with the mark, the page's main content and the footer.
// A signed-in member's pages take the app shell: the navigation to the live
// hall, the inbox, the requests, the members and, for an admin, the admin
// pages, with the current one marked; beside the inbox, the number of
// proposals waiting for the member's own confirmation; a New request link;
// and the member's menu with their email settings, their connected agents and
// tokens and the sign-out form. The pages where a person makes one decision,
// has no session or reads one message take the focused shell: the mark and
// the name alone. Two renderers draw this model, html.ts for the pages the web
// role renders and apps/web/lib/shell.tsx for the pages Next.js renders.

/** What the app shell shows of the signed-in member, as web.shell reads it. */
export interface ShellMember {
  login: string;
  /** Whether an admin flagged the member as a bot. */
  bot: boolean;
  /** Whether the member is an admin, who is linked to the admin pages. */
  admin: boolean;
  /** How many proposals wait for the member's own confirmation, as their web inbox's standing list counts them. */
  waiting: number;
}

/**
 * The shell of one page: the app shell of a signed-in member's page at a path,
 * with the CSRF token of their sign-out form, or the focused shell, whose main
 * content is narrow but for the setup screen's two columns.
 */
export type PageShell = { form: "focused"; wide?: boolean } | { form: "app"; member: ShellMember; path: string; csrf: string };

/** The focused shell: the mark and the name, and nothing else to click. */
export const FOCUSED_SHELL: PageShell = { form: "focused" };

/** A link of the shell, marked when it leads to the page shown. */
export interface ShellLink {
  href: string;
  text: string;
  current: boolean;
}

/** A link of the navigation, with the number of proposals that wait for the member beside the inbox's, in figures and in words. */
export interface NavLink extends ShellLink {
  waiting?: { count: number; words: string };
}

export const HALL_PATH = "/hall";
export const NEW_REQUEST_LINK = { href: "/requests/new", text: "New request" } as const;
export const SIGN_OUT_ACTION = "/sign-out";

/** The navigation, in its order; Admin only for admins. */
const NAVIGATION = [
  { href: HALL_PATH, text: "Live hall" },
  { href: "/inbox", text: "Inbox" },
  { href: "/requests", text: "Requests" },
  { href: "/members", text: "Members" },
  { href: "/admin", text: "Admin", admin: true },
] as const;

/** A request's page or a team's intake page, which the navigation counts among the requests. */
const KEY_PAGE = /^\/[A-Z][A-Z0-9]{1,9}(-[1-9][0-9]{0,9})?$/;

/** The navigation link a page belongs to: its own, the one it lies under, or Requests for a request's or a team's page. */
function sectionOf(path: string): string | undefined {
  if (KEY_PAGE.test(path)) return "/requests";
  if (path === NEW_REQUEST_LINK.href) return undefined;
  return NAVIGATION.find(({ href }) => path === href || path.startsWith(`${href}/`))?.href;
}

/** The navigation of a member's page at this path. */
export function navigation(member: ShellMember, path: string): NavLink[] {
  const section = sectionOf(path);
  return NAVIGATION.filter((item) => !("admin" in item) || member.admin).map(({ href, text }) => ({
    href,
    text,
    current: href === section,
    ...(href === "/inbox" && member.waiting > 0 ? { waiting: { count: member.waiting, words: `${member.waiting} waiting` } } : {}),
  }));
}

/** The member's menu, beside their sign-out form. */
export function memberMenu(path: string): ShellLink[] {
  return [
    { href: "/settings/email", text: "Email settings", current: path === "/settings/email" },
    { href: "/tokens", text: "Connected agents and tokens", current: path === "/tokens" },
  ];
}

/** The initials of a GitHub login, which stand for its person where the shell shows no avatar: the first letters of its first two parts, or its first two letters. */
export function initialsOf(login: string): string {
  const parts = login.split(/[^A-Za-z]+/).filter((part) => part !== "");
  const initials = parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : (parts[0] ?? login).slice(0, 2);
  return initials.toUpperCase();
}

/** The pages that take the focused shell by their path: the sign-in page, the setup screen, the review pages and confirmations, the consent screen, the device approval page and the API changelog page. Refusal pages take it wherever they are. */
const FOCUSED_PATHS = [/^\/sign-in$/, /^\/setup(\/.*)?$/, /^\/confirm\/.+$/, /^\/consent$/, /^\/device$/, /^\/docs\/api\/changelog$/];

/** Whether the page at this path takes the focused shell. */
export function focusedShellFor(path: string): boolean {
  return FOCUSED_PATHS.some((pattern) => pattern.test(path));
}

/** The words for how many proposals wait for the member, on the home page's card. */
export function waitingSentence(count: number): string {
  if (count === 0) return "Nothing waits for your confirmation.";
  return count === 1 ? "1 proposal waits for your confirmation." : `${count} proposals wait for your confirmation.`;
}
