import type { ReactNode } from "react";
import { TEAM_APIS_PATH, type TeamApisView, type TeamIntakeView, type TeamPageAction } from "@tiehall/commands/web";

// The web UI's intake page of a team, at /<TEAM> (agent-surfaces: Team intake
// pages; agent-surfaces: Admins set a team's intake notes and required
// fields; design.md, Decisions this change rests on: D28 #64). It shows the
// team's key and name, the notes in which it says how it wants requests
// filed, which an admin wrote, as text, and the fields it requires of the
// requests opened to it, in Tiehall's words, with a link to the web form that
// opens a request to it. React writes every text escaped, so nothing in the
// notes runs or loads anything.
//
// The page also lists the registered APIs, each with its provider team and
// whether the team declared that it consumes it, with who declared it, when,
// and when it was last confirmed (contract-changes: Teams declare the APIs
// they consume). A member of the team finds a form beside each that declares
// that the team consumes the API, or removes the team's declaration; it posts
// to the forms' own target, /teams/apis, with the session's CSRF token, which
// leads back here (team-page-actions.ts).

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
      <button type="submit">{button}</button>
    </form>
  );
}

/** The registered APIs, with the team's declarations, and a member's forms. */
function ConsumedApis({ teamKey, apis, csrf }: { teamKey: string; apis: TeamApisView; csrf: string | undefined }): ReactNode {
  const forms = apis.member && csrf !== undefined;
  return (
    <section aria-labelledby="apis">
      <h2 id="apis">{`APIs ${teamKey} consumes`}</h2>
      <p>{`When a provider's pull request makes breaking changes to an API that ${teamKey} declares it consumes, Tiehall opens a request to ${teamKey}. Any member of ${teamKey} declares or removes its declarations.`}</p>
      {apis.apis.length === 0 ? (
        <p>No API is registered.</p>
      ) : (
        <ul>
          {apis.apis.map((api) => {
            const { declaration } = api;
            const declarer = declaration === null ? "" : declaration.declaredBy.bot ? `${declaration.declaredBy.login} (a bot user)` : declaration.declaredBy.login;
            return (
              <li key={api.id}>
                <p>
                  {`${api.untrusted.name}, provided by ${api.provider.key}: `}
                  {declaration === null
                    ? `${teamKey} has not declared that it consumes it.`
                    : `${teamKey} consumes it, as ${declarer} declared on ${dayOf(declaration.declaredAt)}; last confirmed on ${dayOf(declaration.lastConfirmedAt)}.`}
                </p>
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

export function IntakePage({ team, apis, csrf }: { team: TeamIntakeView; apis?: TeamApisView | undefined; csrf?: string | undefined }): ReactNode {
  const notes = team.untrusted.intakeNotes;
  const required = team.requiredFields.map((field) => FIELD_WORDS[field] ?? field);
  return (
    <main>
      <h1>{`${team.key}: ${team.untrusted.name}`}</h1>
      <p>{`This is how team ${team.key} wants requests filed, and what it requires of them.`}</p>
      <section aria-labelledby="notes">
        <h2 id="notes">{`How ${team.key} wants requests filed`}</h2>
        {notes === "" ? <p>{`Team ${team.key} gives no notes on how it wants requests filed.`}</p> : <pre>{notes}</pre>}
      </section>
      <section aria-labelledby="required">
        <h2 id="required">Required fields</h2>
        <p>
          {required.length === 0
            ? `Team ${team.key} requires no field beyond the need, which every packet has.`
            : `Team ${team.key} requires ${listed(required)} of the requests opened to it.`}
        </p>
      </section>
      <p>
        <a href={`/requests/new?team=${encodeURIComponent(team.key)}`}>{`Open a request to ${team.key}`}</a>
      </p>
      {apis === undefined ? null : <ConsumedApis teamKey={team.key} apis={apis} csrf={csrf} />}
    </main>
  );
}
