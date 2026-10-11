"use client";

// The page shown when rendering a page fails (web-ui: The page shell and its
// navigation; web-ui: The content security policy of each kind of page;
// design.md, Design: The content security policy of each kind of page; D57
// (9)), in place of the framework's default, which carries an inline style
// element and style attributes that the framework pages' policy would block.
// It replaces the root layout, so it renders its own html and body. It says
// nothing about the failure, which the server's log holds.
export default function GlobalError(_props: { error: Error & { digest?: string }; reset?: () => void }) {
  return (
    <html lang="en">
      <body>
        <main id="content" className="focused">
          <h1>Tiehall could not show this page</h1>
          <p>Something went wrong while the page was put together. Try again in a moment; if it fails again, tell an admin of the install.</p>
          <p>
            <a href="/">Go to Tiehall&apos;s home page</a>
          </p>
        </main>
      </body>
    </html>
  );
}
