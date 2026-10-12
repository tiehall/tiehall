import { readDirectory } from "@tiehall/catalog";

// Every page of directory, for the web UI's pages that list every team of the
// install: the form that opens a request and a request's page. directory
// answers a page at a time (directory.ts; decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (39)), and these read one
// after another until the last. A page may end inside one API's consumers,
// or inside the teams a team's intake notes' writer belonged to, and the next
// page goes on with the same API or team, as the maintainer answered on
// 2026-10-12: the parts are joined again, so each team and each API is listed
// once, with its whole list.

/** A team or an API as a page lists it: whether it goes on from the previous page, or in the next one. */
interface Part {
  id: string;
  continuedFromPreviousPage?: boolean;
  continuedOnNextPage?: boolean;
}

/** A team as a page lists it, with the teams its intake notes' writer belonged to. */
interface TeamPart extends Part {
  intakeNotesWrittenBy?: readonly unknown[] | null;
}

/** A registered API as a page lists it, with its consumers. */
interface ApiPart extends Part {
  consumers?: readonly unknown[];
}

/** The entry without the marks of a part, which the whole directory has no pages for. */
function whole<Entry extends Part>(entry: Entry): Entry {
  const { continuedFromPreviousPage: _from, continuedOnNextPage: _on, ...rest } = entry;
  return rest as Entry;
}

/** Adds a page's teams or APIs, joining its first to the last one so far when it goes on from the previous page. */
function join<Entry extends Part>(so: Entry[], parts: readonly Entry[], listOf: (entry: Entry) => readonly unknown[] | null | undefined, withList: (entry: Entry, list: unknown[]) => Entry): void {
  for (const [index, part] of parts.entries()) {
    const last = so.at(-1);
    if (index === 0 && part.continuedFromPreviousPage === true && last?.id === part.id) {
      so[so.length - 1] = withList(last, [...(listOf(last) ?? []), ...(listOf(part) ?? [])]);
    } else {
      so.push(whole(part));
    }
  }
}

/** Every page of directory, one after another, for the web UI's pages that list every team: each team and each API once, with its whole list. */
export async function wholeDirectory<Team extends TeamPart = TeamPart, Api extends ApiPart = ApiPart>(
  read: <Output>(commandId: string, input: unknown) => Promise<Output>,
): Promise<{ teams: Team[]; apis: Api[] }> {
  const directory: { teams: Team[]; apis: Api[] } = { teams: [], apis: [] };
  let cursor: string | null = null;
  do {
    const page: { teams: Team[]; apis: Api[]; next: string | null } = await read(readDirectory.id, cursor === null ? {} : { cursor });
    join(directory.teams, page.teams, (team) => team.intakeNotesWrittenBy, (team, list) => ({ ...team, intakeNotesWrittenBy: list }));
    join(directory.apis, page.apis, (api) => api.consumers, (api, list) => ({ ...api, consumers: list }));
    cursor = page.next;
  } while (cursor !== null);
  return directory;
}
