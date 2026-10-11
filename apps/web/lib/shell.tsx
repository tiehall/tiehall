import type { ReactNode } from "react";
import { assetUrl, STYLESHEET_PATH } from "@tiehall/commands/asset-urls";
import { MARK_CIRCLES, MARK_PATHS, markStroke } from "@tiehall/commands/mark";
import { initialsOf, memberMenu, navigation, NEW_REQUEST_LINK, SIGN_OUT_ACTION, type NavLink, type ShellLink, type ShellMember } from "@tiehall/commands/shell";

// The shell of the pages Next.js renders (web-ui: The page shell and its
// navigation; web-ui: The mark, the favicon and the app icon; web-ui: Light
// and dark themes follow the system; design.md, Design: The page shell and
// navigation; D57 (4), (5), (10)), drawn from the same model as the string
// shell of the web role's pages (packages/commands/src/shell.ts and html.ts),
// whose markup it repeats: <AppShell> for a signed-in member's page, with the
// navigation, the waiting count, New request and the member's menu, folded
// into one menu on a narrow screen, and <FocusedShell> for the page for a path
// no route serves and the page shown when rendering one fails. <PageHead>
// names the stylesheet, the icons, the manifest and the color schemes, and
// <PageFooter> shows the running version with its source and docs links. None
// of them reads anything, so the web app's page for a failed render, which
// runs in the browser too, draws them as well.

/** The mark, in the color of its context, hidden from assistive technology, at the stroke of its size. */
function Mark({ size }: { size: number }): ReactNode {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={markStroke(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
      {MARK_CIRCLES.map(({ cx, cy, r }) => (
        <circle key={`${cx} ${cy}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}

/** The mark on its tile beside the name. */
function Brand(): ReactNode {
  return (
    <>
      <span className="mark">
        <Mark size={18} />
      </span>
      Tiehall
    </>
  );
}

function SkipLink(): ReactNode {
  return (
    <a className="skip" href="#content">
      Skip to content
    </a>
  );
}

/** A link of the shell, marked as the page shown when it is, with the number of proposals that wait for the member beside the inbox's. */
function Link({ link }: { link: ShellLink | NavLink }): ReactNode {
  const waiting = "waiting" in link ? link.waiting : undefined;
  return (
    <a href={link.href} aria-current={link.current ? "page" : undefined}>
      {waiting === undefined ? link.text : `${link.text} `}
      {waiting === undefined ? null : (
        <span className="badge">
          <span aria-hidden="true">{waiting.count}</span>
          <span className="visually-hidden">{waiting.words}</span>
        </span>
      )}
    </a>
  );
}

function NavigationList({ links }: { links: readonly NavLink[] }): ReactNode {
  return (
    <ul>
      {links.map((link) => (
        <li key={link.href}>
          <Link link={link} />
        </li>
      ))}
    </ul>
  );
}

/** The member's menu's links and their sign-out form, with the session's CSRF token. */
function MemberItems({ path, csrf }: { path: string; csrf: string }): ReactNode {
  return (
    <>
      {memberMenu(path).map((link) => (
        <Link key={link.href} link={link} />
      ))}
      <form method="post" action={SIGN_OUT_ACTION}>
        <input type="hidden" name="csrf" value={csrf} />
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}

/**
 * The app shell of a signed-in member's page at this path: the skip link, the
 * top bar and the main content, which holds the page's one first-level
 * heading, with the class the page names.
 */
export function AppShell({ member, path, csrf, className, children }: { member: ShellMember; path: string; csrf: string; className?: string; children: ReactNode }): ReactNode {
  const links = navigation(member, path);
  const who = member.bot ? `${member.login} (bot)` : member.login;
  return (
    <>
      <SkipLink />
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/">
            <Brand />
          </a>
          <div className="topbar-wide">
            <nav className="nav" aria-label="Main">
              <NavigationList links={links} />
            </nav>
            <div className="topbar-end">
              <a className="button strong" href={NEW_REQUEST_LINK.href}>
                {NEW_REQUEST_LINK.text}
              </a>
              <details className="menu">
                <summary>
                  <span className="initials" aria-hidden="true">
                    {initialsOf(member.login)}
                  </span>
                  <span className="login">{who}</span>
                </summary>
                <div className="menu-panel">
                  <MemberItems path={path} csrf={csrf} />
                </div>
              </details>
            </div>
          </div>
          <details className="menu menu-all">
            <summary>Menu</summary>
            <div className="menu-panel">
              <nav aria-label="Main">
                <NavigationList links={links} />
              </nav>
              <a className="button strong" href={NEW_REQUEST_LINK.href}>
                {NEW_REQUEST_LINK.text}
              </a>
              <p className="menu-who">{`Signed in as ${who}`}</p>
              <MemberItems path={path} csrf={csrf} />
            </div>
          </details>
        </div>
      </header>
      <main id="content" className={className}>
        {children}
      </main>
    </>
  );
}

/** The focused shell: the skip link, the top bar with the mark and the name alone, and the main content. */
export function FocusedShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <>
      <SkipLink />
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <Brand />
          </span>
        </div>
      </header>
      <main id="content" className="focused">
        {children}
      </main>
    </>
  );
}

/** The head every page of the web UI carries: the color schemes it uses and its theme colors, the stylesheet, the icons and the manifest. */
export function PageHead(): ReactNode {
  return (
    <>
      <meta name="color-scheme" content="light dark" />
      <meta name="theme-color" content="#F6F7FA" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#0A1428" media="(prefers-color-scheme: dark)" />
      <link rel="stylesheet" href={assetUrl(STYLESHEET_PATH)} />
      <link rel="icon" href={assetUrl("/assets/icon.svg")} type="image/svg+xml" />
      <link rel="icon" href={assetUrl("/favicon.ico")} sizes="16x16 32x32 48x48" />
      <link rel="apple-touch-icon" href={assetUrl("/assets/icon-180.png")} />
      <link rel="manifest" href={assetUrl("/assets/manifest.webmanifest")} />
    </>
  );
}

/**
 * The footer of every page: the running version with a link to its source,
 * and a link to its docs (self-host-install: The running version links to its
 * source). In the browser, where the running container's settings are not
 * known, the page for a failed render keeps what the server rendered.
 */
export function PageFooter({ version, sourceUrl, docsUrl }: { version: string; sourceUrl: string; docsUrl: string }): ReactNode {
  return (
    <footer>
      <p suppressHydrationWarning>
        {`Tiehall ${version} · `}
        <a href={sourceUrl} suppressHydrationWarning>
          Source code
        </a>
        {" · "}
        <a href={docsUrl} suppressHydrationWarning>
          Documentation
        </a>
      </p>
    </footer>
  );
}
