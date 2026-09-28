import type { ParsedManifest } from "./manifest.ts";
import { ACCOUNT_PERMISSIONS, ORGANIZATION_PERMISSIONS } from "./manifest.ts";
import type { StubAccount, StubApp, StubInstallation, StubRepo, StubUser } from "./world.ts";
import { fullNameOf } from "./world.ts";

// The github.com pages a browser meets in setup and when it signs in, namely
// the new-App page's refusal and confirmation, the install page, the authorize
// page and a sign-in page for choosing which GitHub account it acts as. They are
// plain HTML forms, so a test can post them with fetch or click them in a
// browser. Refusals list each of GitHub's messages as <li class="error">.

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)} · GitHub</title>
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>
`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

const PERMISSION_NAMES: Readonly<Record<string, string>> = {
  metadata: "Metadata",
  pull_requests: "Pull requests",
  issues: "Issues",
  members: "Members",
  emails: "Email addresses",
  contents: "Contents",
};

function permissionList(permissions: Record<string, string>): string {
  return Object.entries(permissions)
    .map(([key, level]) => `<li>${escapeHtml(PERMISSION_NAMES[key] ?? key)}: ${level === "write" ? "Read and write" : "Read-only"}</li>`)
    .join("");
}

/** GitHub's page for a manifest it refuses: no way back to the install (spike 1.6). */
export function refusalPage(messages: readonly string[]): string {
  return page(
    "Invalid GitHub App configuration",
    `      <h1>Invalid GitHub App configuration</h1>
      <p>Something went wrong with the GitHub App configuration you tried to create.</p>
      <ul>
${messages.map((message) => `        <li class="error">${escapeHtml(message)}</li>`).join("\n")}
      </ul>`,
  );
}

/** GitHub's confirmation page for an accepted manifest, whose button creates the App. */
export function confirmationPage(registration: string, manifest: ParsedManifest, owner: StubAccount, error?: string): string {
  return page(
    "Create GitHub App",
    `      <h1>Create GitHub App for ${escapeHtml(owner.login)}</h1>
${error === undefined ? "" : `      <ul><li class="error">${escapeHtml(error)}</li></ul>\n`}      <form method="post" action="/settings/apps/new/confirm">
        ${hidden("registration", registration)}
        <label for="name">GitHub App name</label>
        <input id="name" name="name" type="text" value="${escapeHtml(manifest.name)}">
        <p>Webhook: ${manifest.hook === null ? "none" : escapeHtml(manifest.hook.url)}</p>
        <ul>${permissionList(manifest.permissions)}</ul>
        <p>Events: ${manifest.events.length === 0 ? "none" : escapeHtml(manifest.events.join(", "))}</p>
        <button type="submit">Create GitHub App for ${escapeHtml(owner.login)}</button>
      </form>`,
  );
}

/** The install page: the accounts the signed-in user may install the App on, and its repositories. */
export function installPage(app: StubApp, accounts: readonly StubAccount[], reposOf: (account: StubAccount) => StubRepo[]): string {
  const repositoryPermissions = Object.fromEntries(
    Object.entries(app.permissions).filter(([key]) => !ACCOUNT_PERMISSIONS.has(key) && !ORGANIZATION_PERMISSIONS.has(key)),
  );
  const organizationPermissions = Object.fromEntries(Object.entries(app.permissions).filter(([key]) => ORGANIZATION_PERMISSIONS.has(key)));
  const forms = accounts
    .map(
      (account) => `      <form method="post" action="/apps/${escapeHtml(app.slug)}/installations">
        <h2>Install on ${escapeHtml(account.login)}</h2>
        ${hidden("account", account.login)}
        <p>Repository permissions</p>
        <ul>${permissionList(repositoryPermissions)}</ul>
${account.type === "Organization" && Object.keys(organizationPermissions).length > 0 ? `        <p>Organization permissions</p>\n        <ul>${permissionList(organizationPermissions)}</ul>\n` : ""}        <label><input type="radio" name="repository_selection" value="all" checked> All repositories</label>
        <label><input type="radio" name="repository_selection" value="selected"> Only select repositories</label>
${reposOf(account)
  .map((repo) => `        <label><input type="checkbox" name="repositories" value="${escapeHtml(fullNameOf(repo))}"> ${escapeHtml(fullNameOf(repo))}</label>`)
  .join("\n")}
        <button type="submit">Install</button>
      </form>`,
    )
    .join("\n");
  return page(`Install ${app.name}`, `      <h1>Install ${escapeHtml(app.name)}</h1>\n${forms || "      <p>You cannot install this App on any account.</p>"}`);
}

export function installedPage(app: StubApp, installation: StubInstallation): string {
  return page(
    app.name,
    `      <h1>${escapeHtml(app.name)} is installed on ${escapeHtml(installation.account.login)}</h1>
      <p>Installation ${installation.id}</p>`,
  );
}

/** The page that asks a user to authorize an App the first time. */
export function authorizePage(app: StubApp, user: StubUser, fields: Record<string, string>): string {
  const accountPermissions = Object.fromEntries(Object.entries(app.permissions).filter(([key]) => ACCOUNT_PERMISSIONS.has(key)));
  return page(
    `Authorize ${app.name}`,
    `      <h1>Authorize ${escapeHtml(app.name)}</h1>
      <p>Signed in as ${escapeHtml(user.login)}. ${escapeHtml(app.name)} by ${escapeHtml(app.owner.login)} would like permission to:</p>
      <ul><li>Verify your GitHub identity (${escapeHtml(user.login)})</li><li>Know which resources you can access</li><li>Act on your behalf</li>${permissionList(accountPermissions)}</ul>
      <form method="post" action="/login/oauth/authorize">
        ${Object.entries(fields)
          .map(([name, value]) => hidden(name, value))
          .join("\n        ")}
        <button type="submit" name="authorize" value="1">Authorize ${escapeHtml(app.name)}</button>
        <button type="submit" name="authorize" value="0">Cancel</button>
      </form>`,
  );
}

/** The stub's sign-in page: it asks only which account the browser acts as. */
export function signInPage(returnTo: string, error?: string): string {
  return page(
    "Sign in to GitHub",
    `      <h1>Sign in to GitHub</h1>
${error === undefined ? "" : `      <ul><li class="error">${escapeHtml(error)}</li></ul>\n`}      <form method="post" action="/session">
        ${hidden("return_to", returnTo)}
        <label for="login">Username</label>
        <input id="login" name="login" type="text">
        <button type="submit">Sign in</button>
      </form>`,
  );
}

export function appPage(app: StubApp): string {
  return page(app.name, `      <h1>${escapeHtml(app.name)}</h1>\n      <p>${escapeHtml(app.description)}</p>\n      <a href="/apps/${escapeHtml(app.slug)}/installations/new">Install</a>`);
}

export function appSettingsPage(app: StubApp): string {
  return page(
    `${app.name} settings`,
    `      <h1>${escapeHtml(app.name)}</h1>
      <p>App ID: ${app.id}</p>
      <p>Client ID: ${escapeHtml(app.clientId)}</p>
      <p>Webhook: ${app.hook === null ? "none" : `${escapeHtml(app.hook.url)} (${app.hook.active ? "active" : "inactive"})`}</p>
      <p>Events: ${app.events.length === 0 ? "none" : escapeHtml(app.events.join(", "))}</p>`,
  );
}

export function notFoundPage(): string {
  return page("Page not found", "      <h1>404</h1>\n      <p>This is not the web page you are looking for.</p>");
}
