import type { ReactNode } from "react";
import type { TeamIntakeView } from "@tiehall/commands/web";

// The web UI's intake page of a team, at /<TEAM> (agent-surfaces: Team intake
// pages; agent-surfaces: Admins set a team's intake notes and required
// fields; design.md, Decisions this change rests on: D28 #64). It shows the
// team's key and name, the notes in which it says how it wants requests
// filed, which an admin wrote, as text, and the fields it requires of the
// requests opened to it, in Tiehall's words, with a link to the web form that
// opens a request to it. React writes every text escaped, so nothing in the
// notes runs or loads anything.

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

export function IntakePage({ team }: { team: TeamIntakeView }): ReactNode {
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
    </main>
  );
}
