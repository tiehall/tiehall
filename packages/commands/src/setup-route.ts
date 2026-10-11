import { createHash } from "node:crypto";
import { githubAppReplaced, githubInstallationDisconnected, httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { githubConnectedInstallations, githubInstallations, orgs, setupSessions, type Database, type Transaction } from "@tiehall/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { readGitHubApp, readReplacedGitHubApps, recordReplacedGitHubApp, storeGitHubApp } from "./github-app.ts";
import { convertManifestCode, GITHUB_API_URL, GitHubUnavailableError } from "./github-client.ts";
import { MANIFEST_REDIRECT_PATH, SETUP_SIGN_IN_CALLBACK_PATH, SETUP_SIGN_IN_PATH } from "./github-manifest.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS, webPagePolicy, type WayOn } from "./html.ts";
import { markSvg } from "./mark.ts";
import { createLogger, type Logger } from "./log.ts";
import type { SecretBox } from "./secret-box.ts";
import { isSetupSession, openSetupSession } from "./setup-code.ts";
import { readSetupState, SETUP_PATH } from "./setup-gate.ts";
import {
  appStepBody,
  appStepSettings,
  companyStepBody,
  COMPANY_PATH,
  companyName,
  GITHUB_WEB_URL,
  installStepBody,
  manifestState,
  manifestStateNonce,
  reopenedAppStepBody,
} from "./setup-github.ts";
import type { SetupSignIn } from "./sign-in.ts";
import { writeIn } from "./write.ts";

// The setup screen at /setup (self-host-install: The setup code guards the
// setup screen; self-host-install: The GitHub App is created with GitHub's
// manifest flow; design.md, Self-hosting decisions: S3 and S4):
// - GET shows the form for the setup code, or, to a browser that holds a setup
//   session, the next step of setup: the company's name until it is given,
//   then the GitHub App step until the App's credentials are stored, then the
//   step that installs the App and signs in. A browser that reached the
//   install through any origin but TIEHALL_URL's, such as its address on the
//   local network, gets neither: the page names the URL to open instead,
//   because the GitHub App that setup creates works only at TIEHALL_URL.
// - POST /setup/company names the company, which becomes the name of the
//   install's one org (teams-and-roles: One org per install); the operator can
//   change it until setup completes.
// - POST takes the code a person typed. It is refused with 403, and opens no
//   session, unless its Origin is TIEHALL_URL's and the code is the current
//   one; otherwise it opens a setup session, sets its cookie and leads back
//   to the setup screen.
// - GET /setup/github is where GitHub sends the operator back from the
//   manifest flow, with a code and the state the App step made. A return with
//   no setup session, or whose state was not made for the browser's setup
//   session, is refused with 403 before anything is converted or stored, and
//   so is a return whose state was issued more than 60 minutes before, the
//   hour in which GitHub converts the code, or whose state stored an App
//   already: the state is recorded as used on the setup session's row in the
//   transaction that stores the App.
//   Otherwise Tiehall converts the code at once, well within the hour GitHub
//   allows, stores the App's credentials encrypted, replacing any App stored
//   before, and leads back to the setup screen, which then sends the operator
//   on to install the App. The latest App wins: an App it replaces, such as
//   one created from an older tab, stays registered on GitHub, so the install
//   step names it with a link to its settings on GitHub, where it can be
//   deleted, and the log records the replacement. A return with no code, or
//   with a code not in the form GitHub issues codes in, is refused with 400
//   invalid-input, and GitHub is not asked. A code GitHub does not convert,
//   whatever it answers, or does not answer within the client's 10 seconds,
//   stores nothing, and the answer, 502 integration-unavailable, says to
//   create the App again (public-api: One error model for Tiehall's own
//   refusals).
// - POST /setup/sign-in starts the sign-in with GitHub that completes setup,
//   and GET /setup/sign-in/callback/github is GitHub's return to it
//   (self-host-install: Setup names the company and makes the first admin):
//   the sign-in service's own instance for setup takes both (sign-in.ts). The
//   person who signs in becomes the first admin, the App's installations are
//   connected, and setup closes: the browser lands on the web UI, signed in,
//   and its setup cookie is dropped.
// - Once setup is complete, every path under /setup answers 404 to everyone,
//   except while a step that the operator command `setup reopen` opened is
//   open (self-host-install: Operator commands on the host;
//   operator-commands.ts). That step reopens only the GitHub App step: the
//   company's name stays as it is, and its form answers 404. A browser that
//   entered the code the command printed gets the App step, which also lets an
//   admin close the step with the App in use, and, once the setup screen has
//   stored a new App's credentials in the step, the step that installs it and
//   signs in. The new App's credentials replace the old App's at once, in one
//   transaction that also disconnects the old App's installations, each with
//   its security event, and records the App's replacement as a security event
//   of the system's, since a setup session names no user; the install keeps
//   serving its members, web sessions and tokens throughout. The sign-in from
//   the setup screen closes the step only for a person who is already an admin
//   (sign-in.ts; setup-completion.ts), and the browser's setup cookie is
//   dropped once it has.
// A refusal is a page for a browser, which leads back to the setup screen, or
// to Tiehall once setup is complete, and an RFC 9457 problem for every other
// client (public-api: One error model for Tiehall's own refusals; html.ts);
// the setup gate's answers before setup completes are its own. The pages are
// plain HTML: no script, no style from anywhere, no framing, and forms that
// post only to the install.

export interface SetupRouteOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin. */
  url: string;
  /** Encrypts the GitHub App's credentials before they are stored: TIEHALL_SECRET_KEY's box, opened when first needed. */
  secrets: () => SecretBox;
  /**
   * GitHub's web pages and API, which a test points at the GitHub stub, with
   * the fetch and the wait of each request to GitHub that a test may give;
   * github.com, api.github.com and the client's 10 seconds otherwise.
   */
  github?: { webUrl?: string; apiUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
  /** The sign-in with GitHub that completes setup; without it, the setup screen offers none. */
  signIn?: SetupSignIn;
  logger?: Logger;
  /** The clock the manifest's states are issued and checked by; the system clock unless a test controls it. */
  now?: () => Date;
}

export type SetupRoute = (request: Request) => Promise<Response>;

/** The cookie that holds a setup session: host-only and sent only over HTTPS, except on a trial install on http://localhost. */
export function setupCookieName(url: string): string {
  return url.startsWith("https:") ? "__Host-tiehall-setup" : "tiehall-setup";
}

const CLOSED = httpProblem(new Refusal("route-not-found", "Setup is complete, so there is no setup screen."));
const NO_SUCH_STEP = httpProblem(new Refusal("route-not-found", "The setup screen has no such step."));
const FOREIGN_RETURN = httpProblem(
  new Refusal(
    "forbidden",
    "This return from GitHub does not belong to this browser's setup session, so nothing was stored. Open /setup in the browser that started creating the App.",
  ),
);
const NO_CODE = httpProblem(
  new Refusal("invalid-input", "GitHub's return carries no code.", { issues: [{ path: ["code"], message: "GitHub's return carries no code." }] }),
);
const WRONG_ORIGIN = httpProblem(
  new Refusal("forbidden", "The setup screen takes a setup code only from a form on the install's own URL, TIEHALL_URL."),
);
const NOT_IN_SESSION = httpProblem(
  new Refusal("forbidden", "Setup continues only in the browser that entered the setup code. Open /setup there, or enter the setup code in this one."),
);
const NOT_YET = httpProblem(new Refusal("conflict", "Name the company and create the install's GitHub App before you sign in."));
/** GitHub did not convert the manifest's code: a page for a browser, which says to create the App again, and the problem otherwise. */
const CONVERSION_FAILED = new Refusal(
  "integration-unavailable",
  "GitHub did not give Tiehall the new App's credentials: it did not answer in time, or no longer converts the code it sent back, " +
    "which it converts only once and only within the hour. Nothing was stored. " +
    "Delete the App GitHub created, if any, in your GitHub settings, then create the App again.",
);
const WRONG_CODE = httpProblem(
  new Refusal(
    "forbidden",
    "That is not the current setup code. The app prints a new one to its log at each start: run `docker compose logs app`.",
  ),
);

export function createSetupRoute(options: SetupRouteOptions): SetupRoute {
  const logger = options.logger ?? createLogger();
  const cookieName = setupCookieName(options.url);
  const webUrl = options.github?.webUrl ?? GITHUB_WEB_URL;
  const now = options.now ?? (() => new Date());
  return async function setup(request) {
    try {
      const state = await readSetupState(options.database);
      if (state.complete && !state.reopened) return refuse(request, CLOSED);
      const { pathname } = new URL(request.url);
      if (pathname === MANIFEST_REDIRECT_PATH && request.method === "GET") return await fromGitHub(request);
      if (pathname === COMPANY_PATH && request.method === "POST") return await nameCompany(request);
      if (pathname === SETUP_SIGN_IN_PATH && request.method === "POST" && options.signIn !== undefined) return await startSignIn(request, options.signIn);
      if (pathname === SETUP_SIGN_IN_CALLBACK_PATH && request.method === "GET" && options.signIn !== undefined) return await signedIn(request, options.signIn);
      if (pathname !== SETUP_PATH) return refuse(request, NO_SUCH_STEP);
      if (request.method === "POST") return await enterCode(request);
      if (browserOrigin(request) !== options.url) return page(wrongOriginPage(options.url));
      const token = cookieOf(request, cookieName);
      if (token === undefined || !(await isSetupSession(options.database, token))) return page(codePage());
      return await nextStep(request, token, state.reopened);
    } catch (error) {
      logger.error("setup: the setup screen failed", { error });
      return problem(internalErrorProblem());
    }
  };

  /**
   * The step a browser with a setup session is at: the company's name until it
   * is given, or when the operator asks to change it; then the App step; then
   * installing the App and signing in once the App is stored. In a step that
   * `setup reopen` opened: the App step, until a new App is stored in it, and
   * then installing that App and signing in as an admin.
   */
  async function nextStep(request: Request, token: string, reopened: boolean): Promise<Response> {
    const { company, app, replaced, reopenedAt } = await options.database.transaction(async (tx) => {
      const [org] = await tx.select({ id: orgs.id, name: orgs.name, reopenedAt: orgs.setupReopenedAt }).from(orgs).limit(1);
      if (org === undefined) return { company: null, app: undefined, replaced: [], reopenedAt: null };
      return {
        company: org.name,
        app: await readGitHubApp({ tx, orgId: org.id }),
        replaced: await readReplacedGitHubApps({ tx, orgId: org.id }),
        reopenedAt: org.reopenedAt,
      };
    });
    const query = new URL(request.url).searchParams;
    // Both steps' buttons lead to GitHub: the manifest's form posts there, and the sign-in's answer redirects there.
    const toGitHub = { "content-security-policy": webPagePolicy([new URL(webUrl).origin]) };
    if (reopened) {
      const signIn = options.signIn !== undefined;
      // A new App: one the setup screen stored since the step opened.
      if (app !== undefined && reopenedAt !== null && app.storedAt.getTime() > reopenedAt.getTime()) {
        return page(layout(installStepBody({ webUrl, app, signIn, error: query.get("error"), replaced, reopened: true }), "install", true), toGitHub);
      }
      const settings = appStepSettings(options.url, query, company ?? "");
      const body = reopenedAppStepBody({ url: options.url, webUrl, settings, state: manifestState(token, now()), signIn, error: query.get("error"), ...(app === undefined ? {} : { app }) });
      return page(layout(body, "app", true), toGitHub);
    }
    if (company === null || query.get("step") === "company") return page(layout(companyStepBody(company ?? ""), "company"));
    if (app !== undefined) {
      return page(layout(installStepBody({ webUrl, app, company, signIn: options.signIn !== undefined, error: query.get("error"), replaced }), "install"), toGitHub);
    }
    const settings = appStepSettings(options.url, query, company);
    return page(layout(appStepBody({ url: options.url, webUrl, settings, state: manifestState(token, now()), company }), "app"), toGitHub);
  }

  /** Whether a request comes from a form of the install, TIEHALL_URL, in a browser that holds a setup session. */
  async function inSession(request: Request): Promise<Response | undefined> {
    if (originOf(request.headers.get("origin")) !== options.url) return refuse(request, WRONG_ORIGIN);
    const token = cookieOf(request, cookieName);
    if (token === undefined || !(await isSetupSession(options.database, token))) return refuse(request, NOT_IN_SESSION);
    return undefined;
  }

  /** Names the company: the install's one org takes the name, which the operator can change until setup completes. */
  async function nameCompany(request: Request): Promise<Response> {
    const refused = await inSession(request);
    if (refused !== undefined) return refused;
    const name = companyName(new URLSearchParams(await request.text()).get("name"));
    if (name === undefined) {
      const message = "The company's name is 1 to 100 characters, with no control characters.";
      return refuse(request, httpProblem(new Refusal("invalid-input", message, { issues: [{ path: ["name"], message }] })));
    }
    const named = await options.database.transaction(async (tx) => {
      const [org] = await tx.select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt }).from(orgs).limit(1).for("update");
      if (org === undefined || org.setupCompletedAt !== null) return false;
      await tx.update(orgs).set({ name }).where(eq(orgs.id, org.id));
      return true;
    });
    if (!named) return refuse(request, CLOSED);
    return new Response(null, { status: 303, headers: { location: `${options.url}${SETUP_PATH}`, "cache-control": "no-store" } });
  }

  /** Starts the sign-in with GitHub that completes setup, once the company is named and the App is stored. */
  async function startSignIn(request: Request, signIn: SetupSignIn): Promise<Response> {
    const refused = await inSession(request);
    if (refused !== undefined) return refused;
    const ready = await options.database.transaction(async (tx) => {
      const [org] = await tx.select({ id: orgs.id, name: orgs.name }).from(orgs).limit(1);
      return org !== undefined && org.name !== null && (await readGitHubApp({ tx, orgId: org.id })) !== undefined;
    });
    if (!ready) return refuse(request, NOT_YET);
    return signIn.start(request);
  }

  /** GitHub's return to the sign-in of the setup screen, served only to the browser that holds the setup session. */
  async function signedIn(request: Request, signIn: SetupSignIn): Promise<Response> {
    const token = cookieOf(request, cookieName);
    if (token === undefined || !(await isSetupSession(options.database, token))) return refuse(request, NOT_IN_SESSION);
    const answer = await signIn.callback(request);
    const after = answer.status >= 300 && answer.status < 400 ? await readSetupState(options.database) : undefined;
    if (after !== undefined && after.complete && !after.reopened) {
      // Setup is complete, or the reopened step closed: the setup session is of no use any more, so its cookie goes.
      const headers = new Headers(answer.headers);
      headers.append("set-cookie", `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${options.url.startsWith("https:") ? "; Secure" : ""}`);
      return new Response(answer.body, { status: answer.status, headers });
    }
    return answer;
  }

  /** GitHub's return from the manifest flow: the code, converted and stored when the state is this browser's. */
  async function fromGitHub(request: Request): Promise<Response> {
    const token = cookieOf(request, cookieName);
    const query = new URL(request.url).searchParams;
    const nonce = token === undefined ? undefined : manifestStateNonce(token, query.get("state"), now());
    if (token === undefined || nonce === undefined || !(await isSetupSession(options.database, token))) {
      return refuse(request, FOREIGN_RETURN);
    }
    // A state that stored an App already is used up: GitHub is not asked again.
    if (await manifestStateUsed(options.database, token, nonce)) return refuse(request, FOREIGN_RETURN);
    const code = query.get("code");
    if (code === null || code === "") return refuse(request, NO_CODE);
    // Opened before the code is used: GitHub converts a code only once.
    const box = options.secrets();
    let app;
    try {
      app = await convertManifestCode(code, {
        apiUrl: options.github?.apiUrl ?? GITHUB_API_URL,
        ...(options.github?.fetch === undefined ? {} : { fetch: options.github.fetch }),
        ...(options.github?.timeoutMs === undefined ? {} : { timeoutMs: options.github.timeoutMs }),
        logger,
      });
    } catch (error) {
      // A code not in GitHub's form: refused before GitHub is asked.
      if (error instanceof Refusal) return refuse(request, httpProblem(error));
      if (!(error instanceof GitHubUnavailableError)) throw error;
      logger.warn("setup: GitHub did not convert the manifest's code", { error, status: error.status });
      return refuse(request, httpProblem(CONVERSION_FAILED));
    }
    const stored = await options.database.transaction(async (tx) => {
      // Setup may have completed, or a reopened step closed, meanwhile, in another browser; the org row is locked against that.
      const [org] = await tx
        .select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt, setupReopenedAt: orgs.setupReopenedAt })
        .from(orgs)
        .limit(1)
        .for("update");
      if (org === undefined || (org.setupCompletedAt !== null && org.setupReopenedAt === null)) return "closed";
      // The state is used once: recorded on the setup session's row, with the App it stored.
      const used = await tx
        .update(setupSessions)
        .set({ usedManifestNonces: sql`array_append(${setupSessions.usedManifestNonces}, ${nonce})` })
        .where(and(eq(setupSessions.orgId, org.id), eq(setupSessions.tokenHash, sha256(token)), sql`NOT (${nonce} = ANY(${setupSessions.usedManifestNonces}))`))
        .returning({ id: setupSessions.id });
      if (used.length === 0) return "used";
      // The latest App wins; the one it replaces is recorded, so the install step says it can be deleted on GitHub.
      const replaced = await recordReplacedGitHubApp({ tx, orgId: org.id }, app.id);
      await storeGitHubApp({ tx, orgId: org.id }, box, app);
      // In a step `setup reopen` opened, the new App replaces the App in use: its installations are no longer connected.
      if (org.setupCompletedAt !== null && replaced !== undefined) await replaceAppInUse({ tx, orgId: org.id }, app.id, replaced.appId);
      return { replaced };
    });
    if (stored === "closed") return refuse(request, CLOSED);
    if (stored === "used") return refuse(request, FOREIGN_RETURN);
    if (stored.replaced !== undefined) {
      logger.warn("setup: a new GitHub App replaced the one stored before", { appId: app.id, replacedAppId: stored.replaced.appId });
    }
    logger.info("setup: the GitHub App's credentials are stored", { appId: app.id });
    return new Response(null, { status: 303, headers: { location: `${options.url}${SETUP_PATH}`, "cache-control": "no-store" } });
  }

  async function enterCode(request: Request): Promise<Response> {
    if (originOf(request.headers.get("origin")) !== options.url) return refuse(request, WRONG_ORIGIN);
    const code = new URLSearchParams(await request.text()).get("code") ?? "";
    const token = await openSetupSession(options.database, code);
    if (token === undefined) return refuse(request, WRONG_CODE);
    const secure = options.url.startsWith("https:") ? "; Secure" : "";
    return new Response(null, {
      status: 303,
      headers: {
        location: `${options.url}${SETUP_PATH}`,
        "cache-control": "no-store",
        "set-cookie": `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      },
    });
  }
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** Writes that start no job, as the setup screen's writes do not. */
const NO_JOBS = { send: () => Promise.reject(new Error("The setup screen's writes start no job.")) };

/**
 * Records, in the transaction that stored a new App in a step `setup reopen`
 * opened, that it replaced the App in use, and disconnects that App's
 * installations, each with its security event: Tiehall no longer acts on them,
 * since it no longer holds their App's credentials. The setup session names no
 * user, so the events are the system's.
 */
async function replaceAppInUse(context: { tx: Transaction; orgId: string }, appId: number, previousAppId: number): Promise<void> {
  const { tx, orgId } = context;
  const old = await tx
    .select({ id: githubConnectedInstallations.installationId })
    .from(githubConnectedInstallations)
    .innerJoin(githubInstallations, and(eq(githubInstallations.orgId, githubConnectedInstallations.orgId), eq(githubInstallations.id, githubConnectedInstallations.installationId)))
    .where(and(eq(githubConnectedInstallations.orgId, orgId), ne(githubInstallations.appId, appId)));
  await writeIn(context, NO_JOBS, { actorKind: "system", surface: "web" }, async (writer) => {
    await writer.record(githubAppReplaced, { app: appId, previousApp: previousAppId });
    if (old.length === 0) return;
    // The repositories they covered go with them: the foreign key cascades.
    await tx.delete(githubConnectedInstallations).where(
      and(
        eq(githubConnectedInstallations.orgId, orgId),
        inArray(
          githubConnectedInstallations.installationId,
          old.map(({ id }) => id),
        ),
      ),
    );
    for (const { id } of old) await writer.record(githubInstallationDisconnected, { installationId: id });
  });
}

/** Whether a return with this state's nonce stored an App already, for the setup session with this token. */
async function manifestStateUsed(database: Database, token: string, nonce: string): Promise<boolean> {
  const [session] = await database
    .select({ id: setupSessions.id })
    .from(setupSessions)
    .where(and(eq(setupSessions.tokenHash, sha256(token)), sql`${nonce} = ANY(${setupSessions.usedManifestNonces})`))
    .limit(1);
  return session !== undefined;
}

/** The origin a URL or an Origin header names, in the form TIEHALL_URL is kept in; undefined for none. */
function originOf(value: string | null): string | undefined {
  if (value === null || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** The origin the browser used, from the Host header and the scheme the web role's request guard set. */
function browserOrigin(request: Request): string | undefined {
  const url = new URL(request.url);
  const scheme = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const host = request.headers.get("host") ?? url.host;
  return originOf(`${scheme}://${host}`);
}

/** A cookie's value from the Cookie header. */
function cookieOf(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function problem({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Where a refusal of the setup screen leads a browser on: back to the setup screen, or, once setup is complete, to Tiehall. */
const TO_SETUP: WayOn = { href: SETUP_PATH, text: "Back to the setup screen" };
const TO_TIEHALL: WayOn = { href: "/", text: "Go to Tiehall" };

/** A refusal of the setup screen: a page for a browser and the problem for every other client (html.ts). */
function refuse(request: Request, refusal: HttpProblem): Response {
  return answerRefusal(request, refusal, refusal === CLOSED ? TO_TIEHALL : TO_SETUP);
}

function page(html: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

/** A step of the setup screen, in the order an operator meets them. */
type SetupStep = "code" | "company" | "app" | "install";

/** The steps, by name; a step that `setup reopen` opened has the last two only. */
const SETUP_STEPS: readonly [SetupStep, string][] = [
  ["code", "Setup code"],
  ["company", "Company name"],
  ["app", "GitHub App"],
  ["install", "Install and sign in"],
];

const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M5 12l4 4 10-10"/></svg>';

/** The list of the steps, those done marked done and the one the operator is at marked as the current step. */
function stepList(current: SetupStep, reopened: boolean): string {
  const steps = reopened ? SETUP_STEPS.filter(([step]) => step === "app" || step === "install") : SETUP_STEPS;
  const at = steps.findIndex(([step]) => step === current);
  const items = steps.map(([, name], index) =>
    index < at
      ? `<li class="done"><span class="step-mark">${CHECK}</span>${escapeHtml(name)}<span class="visually-hidden"> (done)</span></li>`
      : `<li${index === at ? ' aria-current="step"' : ""}><span class="step-mark" aria-hidden="true">${index + 1}</span>${escapeHtml(name)}</li>`,
  );
  return `        <ol class="steps" aria-label="Setup steps">${items.join("")}</ol>`;
}

/**
 * The switchboard the setup screen draws beside its steps, on the dark
 * ground: three teams, the lines between them and their lamps, which only
 * illustrate, so assistive technology skips it; its lines flow and its lamps
 * blink a few times, within 5 seconds (web-ui: Motion, and reduced motion).
 */
const SWITCHBOARD = [
  '        <svg class="switchboard" viewBox="0 0 460 300" width="460" height="300" aria-hidden="true" focusable="false">',
  '          <rect class="sb-node" x="20" y="40" width="120" height="70" rx="14"/>',
  '          <rect class="sb-node" x="320" y="40" width="120" height="70" rx="14"/>',
  '          <rect class="sb-node" x="170" y="200" width="120" height="70" rx="14"/>',
  '          <text class="sb-key" x="40" y="81">BE</text>',
  '          <text class="sb-key" x="340" y="81">FE</text>',
  '          <text class="sb-key" x="190" y="241">MOB</text>',
  '          <path class="sb-line in-progress" d="M140 75 C 220 20, 250 20, 320 75"/>',
  '          <path class="sb-line needs-info" d="M80 110 C 80 190, 120 235, 170 235"/>',
  '          <path class="sb-line in-progress" d="M290 235 C 340 235, 380 190, 380 110"/>',
  '          <circle class="sb-lamp needs-info" cx="118" cy="62" r="5"/>',
  '          <circle class="sb-lamp in-progress second" cx="418" cy="62" r="5"/>',
  '          <circle class="sb-lamp done third" cx="268" cy="222" r="5"/>',
  "        </svg>",
].join("\n");

/**
 * The setup screen's page (self-host-install: The setup code guards the setup
 * screen; web-ui: The page shell and its navigation; design.md, Design: The
 * page families; D57 (4), (14)): in two columns on a wide screen, the
 * switchboard on the dark ground at the left, and at the right the list of
 * steps with the current one marked, the heading, and the step's explanation
 * and form; in one column on a narrow screen, the drawing above, smaller.
 */
function layout(body: string, current: SetupStep, reopened = false): string {
  return htmlPage(
    "Set up Tiehall",
    [
      '      <div class="setup">',
      '      <div class="setup-art">',
      `        <p class="setup-brand" aria-hidden="true"><span class="mark setup-mark">${markSvg(26)}</span>Tiehall</p>`,
      SWITCHBOARD,
      '        <p class="setup-tagline">Every team&#39;s line, in one hall.</p>',
      '        <p class="setup-lead">Your agents open requests to other teams, the other teams&#39; agents read what they need, and questions find their way back. A few steps, and the install is ready.</p>',
      "      </div>",
      '      <div class="setup-flow">',
      stepList(current, reopened),
      "      <h1>Set up Tiehall</h1>",
      body,
      "      </div>",
      "      </div>",
    ].join("\n"),
    { form: "focused", wide: true },
  );
}

function codePage(): string {
  return layout(
    `      <h2>Enter the setup code</h2>
      <p>Enter the setup code. The app prints it to its log each time it starts; on the host, run <code>docker compose logs app</code> to read it.</p>
      <form method="post" action="${SETUP_PATH}">
        <label for="code">Setup code</label>
        <input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
        <button type="submit">Continue</button>
      </form>`,
    "code",
  );
}

function wrongOriginPage(url: string): string {
  const setupUrl = escapeHtml(`${url}${SETUP_PATH}`);
  return layout(`      <p class="notice">This install's URL is ${escapeHtml(url)}, and setup works only there. Open <a href="${setupUrl}">${setupUrl}</a> to set it up.</p>`, "code");
}
