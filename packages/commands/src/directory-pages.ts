import { readDirectory } from "@tiehall/catalog";

// Every page of directory, for the web UI's pages that list every team of the
// install: the form that opens a request and a request's page. directory
// answers a page at a time (directory.ts; decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (39)), and these read one
// after another until the last.

/** Every page of directory, one after another, for the web UI's pages that list every team: a team is never on two pages. */
export async function wholeDirectory<Team, Api>(read: <Output>(commandId: string, input: unknown) => Promise<Output>): Promise<{ teams: Team[]; apis: Api[] }> {
  const whole: { teams: Team[]; apis: Api[] } = { teams: [], apis: [] };
  let cursor: string | null = null;
  do {
    const page: { teams: Team[]; apis: Api[]; next: string | null } = await read(readDirectory.id, cursor === null ? {} : { cursor });
    whole.teams.push(...page.teams);
    whole.apis.push(...page.apis);
    cursor = page.next;
  } while (cursor !== null);
  return whole;
}
