import { headers } from "next/headers";
import { webCommands } from "@tiehall/commands/web";

// A server component that reads through an operation, through execute() in
// this process, as the signed-in user's web session (public-api: One
// definition per operation, the same on every surface; design.md, Technical
// decisions: T3). Rendered for every request, never prerendered.
export const dynamic = "force-dynamic";

export default async function Members() {
  const result = await webCommands(process.env, async () => new Headers(await headers())).read<{ members: unknown[] }>("members.list", {});
  return <main>{result.ok ? `${result.output.members.length} members` : `refused with ${result.problem.status}`}</main>;
}
