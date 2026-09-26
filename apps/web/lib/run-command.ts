"use server";

import { webCommands, type WebResult } from "@tiehall/commands/web";

// How the web UI runs an operation (public-api: One definition per operation,
// the same on every surface; design.md, Technical decisions: T3): server
// components call it on the server and client components as a server action.
// It runs the operation through execute(), in this process, as the signed-in
// user's web session, so the web UI has no rights the same user lacks over
// /api/v1, and it gets back the output or the same RFC 9457 problem.

export async function runCommand<Output = unknown>(commandId: string, input: unknown): Promise<WebResult<Output>> {
  return webCommands(process.env).run<Output>(commandId, input);
}
