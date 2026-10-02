import { declareConsumer, reconfirmConsumer, removeConsumer } from "@tiehall/catalog";
import { Refusal, TEAM_KEY } from "@tiehall/core";
import { createPageRoute, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The forms of a team's page (contract-changes: Teams declare the APIs they
// consume; public-api: One definition per operation, the same on every
// surface; design.md, Technical decisions: T3). The page of a team, /<TEAM>,
// lists the registered APIs with the team's declarations, and a member of the
// team finds a form beside each: one that declares that the team consumes the
// API, and one that removes the team's declaration. A team's page is read with
// GET alone (agent-surfaces: Team intake pages), so its forms post to their
// own target, /teams/apis, which names what the form does in its `action`
// field:
// - declare_api runs apis.declare_consumer for the form's team and API;
// - remove_api runs apis.remove_consumer for them;
// - reconfirm_api runs apis.reconfirm_consumer for them, which a member uses
//   when the team is asked to re-confirm its declaration, or at any time
//   (contract-changes: Declarations are re-confirmed every 90 days);
// and leads the browser back to the team's page, which then shows the team's
// declarations as they are. The form passes the checks every web UI write
// passes (the session's CSRF token, an Origin equal to TIEHALL_URL and
// Sec-Fetch-Site: same-origin) and runs through execute(), as the signed-in
// member's web session, so someone who is not a member of the team gets the
// same 403 as anywhere, answered with a page that leads back to the team's
// page. A form that names no action the target has is refused as input that
// fails the schema, with 400, and runs nothing.

/** Where the forms of a team's page post. */
export const TEAM_APIS_PATH = "/teams/apis";

/** The actions the page's forms take, by the name their `action` field gives. */
export const TEAM_PAGE_ACTIONS = ["declare_api", "remove_api", "reconfirm_api"] as const;
export type TeamPageAction = (typeof TEAM_PAGE_ACTIONS)[number];

const COMMANDS: Readonly<Record<TeamPageAction, string>> = { declare_api: declareConsumer.id, remove_api: removeConsumer.id, reconfirm_api: reconfirmConsumer.id };

/** The operation a form of the page runs, and its input; a form the page does not have is refused with 400. */
export function teamPageWrite(fields: URLSearchParams): { commandId: string; input: { api: string; team: string } } {
  const action = fields.get("action") ?? "";
  if (!(TEAM_PAGE_ACTIONS as readonly string[]).includes(action)) {
    const message = "The form names no action this page takes.";
    throw new Refusal("invalid-input", message, { issues: [{ path: ["action"], message }] });
  }
  return { commandId: COMMANDS[action as TeamPageAction], input: { api: fields.get("api") ?? "", team: fields.get("team") ?? "" } };
}

/** The target of a team's page's forms, for the signed-in member's web session; it leads back to the team's page. */
export function createTeamApisRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: TEAM_APIS_PATH,
    name: "team",
    // The forms' target has no page of its own: a browser that opens it goes home.
    get: async () => seeOther("/"),
    async post(form, { write }) {
      const { commandId, input } = teamPageWrite(form);
      await write(commandId, input);
      // Back to the team's page, by the key the form names, which is a team key or nothing.
      const key = form.get("key") ?? "";
      return seeOther(TEAM_KEY.test(key) ? `/${key}` : "/");
    },
  });
}
