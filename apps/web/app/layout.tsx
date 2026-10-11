import type { ReactNode } from "react";
import { docsUrl, runningVersion } from "@tiehall/commands/web";
import { PageFooter, PageHead } from "../lib/shell.tsx";

// The layout of the pages Next.js renders, such as a request's page and the
// page for a path no route serves (web-ui: The page shell and its navigation;
// web-ui: One stylesheet with named design tokens; design.md, Design: The page
// shell and navigation; D57 (4)). It renders only the html element, the head,
// which names the install's stylesheet, icons and manifest and the color
// schemes the pages use, and the body with the footer, which shows the running
// version with a link to its source, and a link to its docs, as the footer of
// every page the web role renders itself does (self-host-install: The running
// version links to its source; packages/commands/src/html.ts). Each page draws
// its own shell (lib/shell.tsx), since this layout wraps the page for a path
// no route serves too.

// Rendered for every request, never prerendered: the version and the source
// link come from the running container's settings, such as TIEHALL_SOURCE_URL
// in .env, which `next build` never sees, and the page for a path no route
// serves would otherwise be rendered once, when the image is built.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const { version, sourceUrl } = runningVersion(process.env);
  return (
    <html lang="en">
      <head>
        <PageHead />
      </head>
      <body>
        {children}
        <PageFooter version={version} sourceUrl={sourceUrl} docsUrl={docsUrl(process.env)} />
      </body>
    </html>
  );
}
