import { createInvitesRoute, INVITES_PATH, type WebSessionCaller } from "../../src/index.ts";
import { URL_OF_INSTALL, type TestInstall } from "./install.ts";

// Inviting a person as an admin does it in the web UI (teams-and-roles:
// Invites by GitHub username): the invites page's form names a GitHub username
// and a role; Tiehall looks the username up at once and sends the admin on to
// the invite's review page, whose input names the account's numeric id; the
// admin confirms the invite there.

/** The invites page's form, submitted as a browser does: a GET of /admin/invites with the username and, if given, the role. */
export function submitInviteForm(install: TestInstall, caller: WebSessionCaller, login: string, role?: string): Promise<Response> {
  const query = new URLSearchParams({ login, ...(role === undefined ? {} : { role }) });
  const route = createInvitesRoute({
    execute: install.execute,
    session: async () => caller,
    url: URL_OF_INSTALL,
    secret: () => install.authSecret,
    logger: install.logger,
  });
  return route(new Request(`${URL_OF_INSTALL}${INVITES_PATH}?${query.toString()}`));
}

/** The review page the form sent the browser on to, as a path, or undefined when the form was refused. */
export function reviewPathOf(answer: Response): string | undefined {
  if (answer.status !== 303) return undefined;
  const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
  return location.pathname === "/confirm/invites.create" ? `${location.pathname}${location.search}` : undefined;
}

/** The input of the review page the form sent the browser on to, or undefined when the form was refused. */
export function reviewInputOf(answer: Response): unknown {
  const path = reviewPathOf(answer);
  return path === undefined ? undefined : (JSON.parse(new URL(path, URL_OF_INSTALL).searchParams.get("input") ?? "null") as unknown);
}

/**
 * Submits the invite form, then opens the review page it leads to, now;
 * returns a function that posts the review page's form. A refused form, or a
 * refused review page, is answered as it was.
 */
export async function prepareInvite(install: TestInstall, caller: WebSessionCaller, login: string, role?: string): Promise<() => Promise<Response>> {
  const form = await submitInviteForm(install, caller, login, role);
  const input = reviewInputOf(form);
  if (input === undefined) {
    const body = await form.text();
    return async () => new Response(body, { status: form.status, headers: form.headers });
  }
  return install.prepareConfirmation(caller, "invites.create", input);
}

/** Invites a GitHub username as an admin does: the form, the review page and its confirmation; returns the last answer. */
export async function invite(install: TestInstall, caller: WebSessionCaller, login: string, role?: string): Promise<Response> {
  return (await prepareInvite(install, caller, login, role))();
}
