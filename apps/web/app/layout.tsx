import type { ReactNode } from "react";
import { runningVersion } from "@tiehall/commands/web";

// The layout of the pages Next.js renders, such as a request's page. Its
// footer shows the running version with a link to its source, as the footer
// of every page the web role renders itself does (self-host-install: The
// running version links to its source; packages/commands/src/html.ts).
export default function RootLayout({ children }: { children: ReactNode }) {
  const { version, sourceUrl } = runningVersion(process.env);
  return (
    <html lang="en">
      <body>
        {children}
        <footer>
          <p>
            {`Tiehall ${version} · `}
            <a href={sourceUrl}>Source code</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
