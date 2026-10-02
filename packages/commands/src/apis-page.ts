import { listApis, listGitHubInstallations, listTeams, registerApi, setWarnSwitch, unregisterApi, type githubInstallation, type listedTeam, type registeredApi } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import type { z } from "zod";
import { adminNav, APIS_PATH, reviewPath } from "./admin-pages.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { userName } from "./members.ts";
import { createPageRoute, htmlAnswer, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The APIs page of the admin UI, /admin/apis (contract-changes: Admins
// register APIs, each bound to one repository; teams-and-roles: What admins
// and members may do; design.md, Where the specs leave room: the admin UI's
// layout). It is an admin's: it lists the registered APIs, each with its
// provider team, the repository it is bound to and its workflow, if any, and
// has a form that names an API, its provider team, its repository and,
// optionally, its workflow, and leads to the review page of that
// registration, where it takes effect with the confirmation step. The form
// offers the repositories the connected installations cover; a repository no
// connected installation covers can be named too, and its review page says
// that confirming registers nothing. Every read runs through execute() as the
// signed-in session, so a member who opens the page, or posts its forms, gets
// 403 and changes nothing. Each registered API also has a form that
// unregisters it, with no confirmation step (contract-changes: Admins
// unregister APIs), and one that turns its WARN switch on or off, which says
// where its WARN-level changes go (contract-changes: Potentially breaking
// changes go to a daily digest).

type RegisteredApi = z.output<typeof registeredApi>;
type ListedTeam = z.output<typeof listedTeam>;
type GitHubInstallation = z.output<typeof githubInstallation>;

/** A field of the form; a missing one reaches the operation as an empty string, which its schema refuses with 400. */
function field(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? "").trim();
}

export function createApisRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: APIS_PATH,
    name: "APIs",
    async get(_query, { read, csrf }) {
      // An admin's page: the APIs' read refuses a member with 403 before anything else.
      const { apis } = await read<{ apis: RegisteredApi[] }>(listApis.id, {});
      const { teams } = await read<{ teams: ListedTeam[] }>(listTeams.id, {});
      const { installations } = await read<{ installations: GitHubInstallation[] }>(listGitHubInstallations.id, {});
      // The repositories a connected installation that is neither suspended nor deleted covers.
      const covered = installations.filter(({ connected, suspended, deleted }) => connected && !suspended && !deleted).flatMap(({ repositories }) => repositories);
      return htmlAnswer(apisPage(apis, teams, [...new Set(covered)].sort(), csrf));
    },
    async post(form, { read, write }) {
      if (form.get("action") === "unregister") {
        await write(unregisterApi.id, { api: field(form, "api") });
        return seeOther(APIS_PATH);
      }
      if (form.get("action") === "warn_on" || form.get("action") === "warn_off") {
        await write(setWarnSwitch.id, { api: field(form, "api"), on: form.get("action") === "warn_on" });
        return seeOther(APIS_PATH);
      }
      if (form.get("action") !== "register") throw new Refusal("route-not-found", "The APIs page offers no such action.");
      // Only an admin's form leads on: a member gets 403, as for the page.
      await read(listApis.id, {});
      const workflow = field(form, "jobWorkflowRef");
      const input = {
        name: field(form, "name"),
        team: field(form, "team"),
        repository: field(form, "repository"),
        ...(workflow === "" ? {} : { jobWorkflowRef: workflow }),
      };
      return seeOther(reviewPath(registerApi.id, input));
    },
  });
}

function apisPage(apis: readonly RegisteredApi[], teams: readonly ListedTeam[], covered: readonly string[], csrf: string): string {
  // Unregistering needs no confirmation step: it only stops an API's reports.
  const registered = apis.map((api) =>
    [
      "        <tr>",
      `          <td>${escapeHtml(api.name)}</td>`,
      `          <td>${escapeHtml(api.provider.key)}</td>`,
      `          <td>${escapeHtml(api.repository)}</td>`,
      `          <td>${escapeHtml(api.jobWorkflowRef ?? "Any workflow of its repository")}</td>`,
      `          <td>${escapeHtml(`${userName(api.registeredBy)}, ${api.registeredAt}`)}</td>`,
      `          <td>${escapeHtml(api.warnOpensRequests ? "On: they open requests" : "Off: they go to the daily WARN digests")}</td>`,
      "          <td>",
      postForm(APIS_PATH, { action: api.warnOpensRequests ? "warn_off" : "warn_on", api: api.id }, csrf, `Turn the WARN switch of ${api.name} ${api.warnOpensRequests ? "off" : "on"}`, "            "),
      postForm(APIS_PATH, { action: "unregister", api: api.id }, csrf, `Unregister ${api.name}`, "            "),
      "          </td>",
      "        </tr>",
    ].join("\n"),
  );
  const teamOptions = teams.map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(`${team.key}: ${team.name}`)}</option>`).join("");
  return htmlPage(
    "APIs",
    [
      "      <h1>APIs</h1>",
      adminNav(),
      "      <p>An API registered here can receive contract reports: the contract Action in its repository's CI reports the breaking changes of its pull requests, and Tiehall opens requests to the teams that declare they consume it. Each API has one provider team and is bound to one GitHub repository that a connected installation covers; only CI runs in that repository, and of its workflow when one is named, may report for it.</p>",
      apis.length === 0
        ? "      <p>No API is registered.</p>"
        : [
            "      <p>Unregistering an API needs no confirmation: it then takes no more reports, the teams' declarations that they consume it route nothing, and the requests its reports opened stay as they are. Registering it again binds it anew.</p>",
            "      <p>Each API's WARN switch says where its potentially breaking (WARN-level) changes go: off, the default, to the daily WARN digests of the teams that consume it; on, they open requests as breaking changes do. An admin or a member of the provider team flips it.</p>",
            "      <table>",
            "        <thead><tr><th>API</th><th>Provider team</th><th>Repository</th><th>Workflow</th><th>Registered by</th><th>WARN-level changes</th><th>Actions</th></tr></thead>",
            "        <tbody>",
            ...registered,
            "        </tbody>",
            "      </table>",
          ].join("\n"),
      "      <h2>Register an API</h2>",
      teams.length === 0
        ? "      <p>The install has no team yet: create the provider team on the teams page first.</p>"
        : [
            `      <form method="post" action="${APIS_PATH}">`,
            '        <input type="hidden" name="action" value="register">',
            `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
            '        <p><label for="api-name">Name, such as payments-api: lower-case letters, digits, dots, hyphens and underscores</label> <input type="text" id="api-name" name="name" required></p>',
            `        <p><label for="api-team">Provider team</label> <select id="api-team" name="team">${teamOptions}</select></p>`,
            '        <p><label for="api-repository">GitHub repository, as owner/name</label> <input type="text" id="api-repository" name="repository" list="covered-repositories" required></p>',
            `        <datalist id="covered-repositories">${covered.map((name) => `<option value="${escapeHtml(name)}">`).join("")}</datalist>`,
            '        <p><label for="api-workflow">Only this workflow may report, by its job_workflow_ref, such as acme/payments/.github/workflows/contract.yml@refs/heads/main (optional)</label> <input type="text" id="api-workflow" name="jobWorkflowRef"></p>',
            '        <button type="submit">Review the registration</button>',
            "      </form>",
            covered.length === 0 ? "      <p>No connected installation covers a repository yet: connect one on the GitHub page first.</p>" : "",
          ]
            .filter((line) => line !== "")
            .join("\n"),
    ].join("\n"),
  );
}
