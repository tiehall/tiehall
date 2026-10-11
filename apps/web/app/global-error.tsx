"use client";

import { docsUrl } from "@tiehall/commands/docs-pages";
import { runningVersion } from "@tiehall/commands/running-version";
import { FocusedShell, PageFooter, PageHead } from "../lib/shell.tsx";

// The page shown when rendering a page fails (web-ui: The page shell and its
// navigation; web-ui: The content security policy of each kind of page;
// design.md, Design: The content security policy of each kind of page; D57
// (4), (9)), in the focused shell, in place of the framework's default, which
// carries an inline style element and style attributes that the framework
// pages' policy would block. It replaces the root layout, so it renders its
// own html, head and footer. It says nothing about the failure, which the
// server's log holds. It runs in the browser too, where the running
// container's settings are not known: the footer keeps what the server
// rendered.
export default function GlobalError(_props: { error: Error & { digest?: string }; reset?: () => void }) {
  const env = typeof process === "undefined" ? {} : process.env;
  const { version, sourceUrl } = runningVersion(env);
  return (
    <html lang="en">
      <head>
        <title>Tiehall could not show this page</title>
        <PageHead />
      </head>
      <body>
        <FocusedShell>
          <h1>Tiehall could not show this page</h1>
          <p>Something went wrong while the page was put together. Try again in a moment; if it fails again, tell an admin of the install.</p>
          <p>
            <a className="button" href="/">
              Go to Tiehall&apos;s home page
            </a>
          </p>
        </FocusedShell>
        <PageFooter version={version} sourceUrl={sourceUrl} docsUrl={docsUrl(env)} />
      </body>
    </html>
  );
}
