import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { DOCS_PAGES } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The web UI's footer and the admin page show the running version with a link
// to its source (self-host-install: The running version links to its source;
// design.md, Self-hosting decisions: S12 and S16), in the web app as the image
// runs it: on the pages the web role renders itself, such as the members page
// and the sign-in page, on the pages Next.js renders, the page of a request and
// the page for a path no route serves, and on the admin page. The link points to the release's source in the public
// repository the image was built from, or to TIEHALL_SOURCE_URL when .env sets
// it, as an operator who runs a modified server does. The admin page also
// links each page of the user and admin docs, at the release's docs in that
// repository (task 28.6; docs-pages.ts), and every page's footer links the
// docs folder there, for every person, not only admins.

const RELEASE = {
  TIEHALL_VERSION: "1.3.0",
  TIEHALL_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  TIEHALL_SOURCE_REPOSITORY: "https://github.com/acme-oss/tiehall",
};

let stub: GitHubStub;
let install: TestInstall;
let pia: string;

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  const fe = await addTeam(install.owner, "FE");
  pia = await addUser(install.owner, { login: "pia", role: "admin", githubAccountId: stub.addUser({ login: "pia" }).id });
  await joinTeams(install.owner, pia, fe);
  await openRequest(install, tokenOf(pia), { targetTeam: "FE", title: "Add a dark mode", packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "A dark mode." } } });
}, 300_000);

afterAll(async () => {
  await install?.close();
  await stub?.close();
}, 60_000);

/** The web app with these settings besides the install's, and the session cookie of Pia, an admin, signed in to it. */
async function webAppWith(env: Record<string, string>): Promise<{ web: WebApp; cookie: string }> {
  const web = await startWebApp(install, { env });
  const signIn = await startSignIn(install, stub, { url: web.url });
  const cookie = (await signIn.signIn("pia")).jar.header();
  return { web, cookie };
}

/** The footer of a page the web app answers with, and the whole page. */
async function pageOf(web: WebApp, path: string, cookie?: string): Promise<{ status: number; html: string; footer: string | undefined }> {
  const answer = await web.fetch(path, { headers: { accept: "text/html", ...(cookie === undefined ? {} : { cookie }) } });
  const html = await answer.text();
  return { status: answer.status, html, footer: /<footer>([\s\S]*?)<\/footer>/.exec(html)?.[1] };
}

describe("the running version and its source", { timeout: 300_000 }, () => {
  it("links the footer and the admin page to the release's source in the public repository by default", async () => {
    const { web, cookie } = await webAppWith(RELEASE);
    try {
      const source = 'href="https://github.com/acme-oss/tiehall/tree/v1.3.0"';
      const docs = '<a href="https://github.com/acme-oss/tiehall/tree/v1.3.0/docs">Documentation</a>';
      for (const path of ["/members", "/FE-1", "/admin"]) {
        const { status, footer } = await pageOf(web, path, cookie);
        expect(status, path).toBe(200);
        expect(footer, path).toContain("Tiehall 1.3.0");
        expect(footer, path).toContain(source);
        expect(footer, path).toContain(docs);
      }
      // A visitor who is not signed in sees it too, on the sign-in page.
      expect((await pageOf(web, "/sign-in")).footer).toContain(source);
      expect((await pageOf(web, "/sign-in")).footer).toContain(docs);
      // So does the page Next.js answers a path no route serves with, which it renders for each call too.
      for (const cookieOf of [undefined, cookie]) {
        const missing = await pageOf(web, "/no/such/page", cookieOf);
        expect(missing.status).toBe(404);
        expect(missing.footer).toContain("Tiehall 1.3.0");
        expect(missing.footer).toContain(source);
        expect(missing.footer).toContain(docs);
      }
      // The admin page says which version runs, and where its source is.
      const admin = await pageOf(web, "/admin", cookie);
      const section = /<h2>Version<\/h2>([\s\S]*?)(?:<h2>|<\/main>)/.exec(admin.html)?.[1] ?? "";
      expect(section).toContain("Tiehall 1.3.0 is running.");
      expect(section).toContain(source);
    } finally {
      await web.close();
    }
  });

  it("links the admin page to each docs page, at the running release's docs in the public repository", async () => {
    const { web, cookie } = await webAppWith(RELEASE);
    try {
      const admin = await pageOf(web, "/admin", cookie);
      const section = /<h2>Documentation<\/h2>([\s\S]*?)(?:<h2>|<\/main>)/.exec(admin.html)?.[1] ?? "";
      const links = [...section.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);
      expect(links).toEqual(DOCS_PAGES.map(({ path, title }) => [`https://github.com/acme-oss/tiehall/blob/v1.3.0/${path}`, title]));
      // A browser without a session is sent to sign in first, and gets no links.
      expect((await pageOf(web, "/admin")).html).not.toContain("<h2>Documentation</h2>");
    } finally {
      await web.close();
    }
  });

  it("links them to TIEHALL_SOURCE_URL when .env sets it, for a modified server", async () => {
    const { web, cookie } = await webAppWith({ ...RELEASE, TIEHALL_SOURCE_URL: "https://git.acme.example/tiehall-fork" });
    try {
      const fork = 'href="https://git.acme.example/tiehall-fork"';
      for (const path of ["/members", "/FE-1", "/admin", "/no/such/page"]) {
        const { footer } = await pageOf(web, path, cookie);
        expect(footer, path).toContain(`<a ${fork}>Source code</a>`);
        // The docs stay the public repository's, which the modified server is built on.
        expect([...(footer ?? "").matchAll(/href="([^"]+)"/g)].map((match) => match[1]), path).toEqual([
          "https://git.acme.example/tiehall-fork",
          "https://github.com/acme-oss/tiehall/tree/v1.3.0/docs",
        ]);
      }
      expect((await pageOf(web, "/no/such/page")).footer).toContain(fork);
      const admin = await pageOf(web, "/admin", cookie);
      expect(/<h2>Version<\/h2>([\s\S]*?)(?:<h2>|<\/main>)/.exec(admin.html)?.[1]).toContain(fork);
    } finally {
      await web.close();
    }
  });
});
