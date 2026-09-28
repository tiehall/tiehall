import { headers } from "next/headers";
import { webCommands, type WebResult } from "@tiehall/commands/web";

// How a server component reads through an operation (public-api: One
// definition per operation, the same on every surface; design.md, Technical
// decisions: T3). It runs the operation through execute(), in this process, as
// the signed-in user's web session, in a read-only transaction, so rendering a
// page can never change anything, and it gets back the output or the same
// RFC 9457 problem as /api/v1. It is no server action: a browser cannot call
// it, and a write goes through writeCommand().

export function readCommand<Output = unknown>(commandId: string, input: unknown): Promise<WebResult<Output>> {
  return webCommands(process.env, async () => new Headers(await headers())).read<Output>(commandId, input);
}
