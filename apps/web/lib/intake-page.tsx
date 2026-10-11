import type { ReactNode } from "react";
import type { ShellMember } from "@tiehall/commands/shell";
import { TEAM_APIS_PATH, type TeamApisView, type TeamIntakeView, type TeamPageAction } from "@tiehall/commands/web";
import { AppShell } from "./shell.tsx";

// The web UI's intake page of a team, at /<TEAM> (agent-surfaces: Team intake
// pages; agent-surfaces: Admins set a team's intake notes and required
// fields; design.md, Decisions this change rests on: D28 #64). It shows the
// team's key and name, the notes in which it says how it wants requests
// filed, which an admin wrote, as text, and the fields it requires of the
// requests opened to it, in Tiehall's words, with a link to the web form that
// opens a request to it. React writes every text escaped, so nothing in the
// notes runs or loads anything. Each part is a panel of the app shell, as on
// every page of the web UI (web-ui: The page shell and its navigation;
// design.md, Design: The page families; D57 (1), (4)).
//
// The page also lists the registered APIs, each with its provider team and
// whether the team declared that it consumes it, with who declared it, when,
// and when it was last confirmed (contract-changes: Teams declare the APIs
// they consume), and whether it is stale (contract-changes: Declarations are
// re-confirmed every 90 days). A member of the team finds a form beside each
// that declares that the team consumes the API, or re-confirms the team's
// declaration and one that removes it; each posts
// to the forms' own target, /teams/apis, with the session's CSRF token, which
// leads back here (team-page-actions.ts). Beside each API the team provides,
// the page says where its WARN-level changes go, and a member of the team
// finds a form that turns its WARN switch on or off (contract-changes:
// Potentially breaking changes go to a daily digest).

/** How Tiehall names each field a team may require. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  acceptance_criteria: "the acceptance criteria",
  code_refs: "code refs",
  links: "links",
  due_date: "a due date",
};

/** "a", "a and b", or "a, b and c". */
function listed(words: readonly string[]): string {
  return words.length <= 2 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

/** A day as a page shows it, such as 2026-11-02. */
function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** A form of the team's page, which posts to the forms' target with the session's CSRF token, and comes back here. */
function TeamForm({ teamKey, team, api, action, csrf, button }: { teamKey: string; team: string; api: string; action: TeamPageAction; csrf: string; button: string }): ReactNode {
  return (
    <form method="post" action={TEAM_APIS_PATH}>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="key" value={teamKey} />
      <input type="hidden" name="team" value={team} />
      <input type="hidden" name="api" value={api} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" className="secondary">
        {button}
      </button>
    </form>
  );
}

/** The registered APIs, with the team's declarations, and a member's forms. */
function ConsumedApis({ teamKey, apis, csrf }: { teamKey: string; apis: TeamApisView; csrf: string | undefined }): ReactNode {
  const forms = apis.member && csrf !== undefined;
  return (
    <section aria-labelledby="apis" className="panel">
      <h2 id="apis">{`APIs ${teamKey} consumes`}</h2>
      <p className="hint">{`When a provider's pull request makes breaking changes to an API that ${teamKey} declares it consumes, Tiehall opens a request to ${teamKey}. Any member of ${teamKey} declares or removes its declarations.`}</p>
      {apis.apis.length === 0 ? (
        <p className="muted">No API is registered.</p>
      ) : (
        <ul className="api-list">
          {apis.apis.map((api) => {
            const { declaration } = api;
            const declarer = declaration === null ? "" : declaration.declaredBy.bot ? `${declaration.declaredBy.login} (a bot user)` : declaration.declaredBy.login;
            return (
              <li key={api.id} className={declaration === null ? "api-card" : "api-card declared"}>
                <p className="api-name">
                  <span className="key">{api.untrusted.name}</span>
                  {declaration === null ? <span className="chip tag">Not declared</span> : <span className="chip tag good">Consumed</span>}
                  {declaration?.stale === true ? <span className="chip tag warn">Stale</span> : null}
                </p>
                <p>
                  {`${api.untrusted.name}, provided by ${api.provider.key}: `}
                  {declaration === null
                    ? `${teamKey} has not declared that it consumes it.`
                    : `${teamKey} consumes it, as ${declarer} declared on ${dayOf(declaration.declaredAt)}; last confirmed on ${dayOf(declaration.lastConfirmedAt)}.`}
                  {declaration?.stale === true ? ` It is stale: nobody re-confirmed it within 120 days of its last confirmation, and changes to ${api.untrusted.name} still reach ${teamKey}.` : null}
                </p>
                {forms && declaration !== null ? (
                  <TeamForm
                    teamKey={teamKey}
                    team={apis.team.id}
                    api={api.id}
                    action="reconfirm_api"
                    csrf={csrf}
                    button={`Re-confirm that ${teamKey} consumes ${api.untrusted.name}`}
                  />
                ) : null}
                {api.provides ? (
                  <p className="hint">
                    {api.warnOpensRequests
                      ? `Its WARN switch is on: its potentially breaking (WARN-level) changes open requests to the teams that consume it, as its breaking changes do.`
                      : `Its WARN switch is off: its potentially breaking (WARN-level) changes go to the daily WARN digests of the teams that consume it.`}
                  </p>
                ) : null}
                {forms && api.provides ? (
                  <TeamForm
                    teamKey={teamKey}
                    team={apis.team.id}
                    api={api.id}
                    action={api.warnOpensRequests ? "warn_off" : "warn_on"}
                    csrf={csrf}
                    button={api.warnOpensRequests ? `Turn the WARN switch of ${api.untrusted.name} off` : `Turn the WARN switch of ${api.untrusted.name} on`}
                  />
                ) : null}
                {forms ? (
                  <TeamForm
                    teamKey={teamKey}
                    team={apis.team.id}
                    api={api.id}
                    action={declaration === null ? "declare_api" : "remove_api"}
                    csrf={csrf}
                    button={declaration === null ? `Declare that ${teamKey} consumes ${api.untrusted.name}` : `Remove the declaration that ${teamKey} consumes ${api.untrusted.name}`}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function IntakePage({ team, apis, csrf, shell }: { team: TeamIntakeView; apis?: TeamApisView | undefined; csrf: string; shell: { member: ShellMember; path: string } }): ReactNode {
  const notes = team.untrusted.intakeNotes;
  const required = team.requiredFields.map((field) => FIELD_WORDS[field] ?? field);
  return (
    <AppShell member={shell.member} path={shell.path} csrf={csrf} className="intake-page">
      <title>{`${team.key}: ${team.untrusted.name} · Tiehall`}</title>
      <div className="page-head">
        <h1>{`${team.key}: ${team.untrusted.name}`}</h1>
        <a className="button" href={`/requests/new?team=${encodeURIComponent(team.key)}`}>{`Open a request to ${team.key}`}</a>
      </div>
      <p className="lead">{`This is how team ${team.key} wants requests filed, and what it requires of them.`}</p>
      <div className="panel-grid">
        <section aria-labelledby="notes" className="panel">
          <h2 id="notes">{`How ${team.key} wants requests filed`}</h2>
          {notes === "" ? <p className="muted">{`Team ${team.key} gives no notes on how it wants requests filed.`}</p> : <p className="notes">{notes}</p>}
        </section>
        <section aria-labelledby="required" className="panel">
          <h2 id="required">Required fields</h2>
          <p>
            {required.length === 0
              ? `Team ${team.key} requires no field beyond the need, which every packet has.`
              : `Team ${team.key} requires ${listed(required)} of the requests opened to it.`}
          </p>
        </section>
      </div>
      {apis === undefined ? null : <ConsumedApis teamKey={team.key} apis={apis} csrf={csrf} />}
    </AppShell>
  );
}
