import { run } from "tiehall";
import type { ExecResult } from "../../src/action.ts";
import type { Npx } from "./runner.ts";

// The pinned tiehall CLI for the Action's tests: the stand-in for
// `npx --yes tiehall@<pin>` runs the CLI of this repository in the test's
// process, with the arguments after the package and the environment the
// Action gives it, and a fetch of the test's own, which plays GitHub Actions'
// token service and the install, or fails as an unreachable host does.

/** One call the CLI made: its method, URL, headers and body. */
export interface CliCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** GitHub Actions' token service, as the runner names it in ACTIONS_ID_TOKEN_REQUEST_URL. */
export const TOKEN_SERVICE = "https://pipelines.actions.example.net/oidc/token?api-version=2.0";

/** The OIDC token the token service gives for an audience. */
export const oidcTokenFor = (audience: string) => `oidc.${Buffer.from(audience).toString("base64url")}.signed`;

/** How the install answers a report: a status and a body, or no answer, as an install that cannot be reached. */
export type InstallAnswer = { status: number; body: unknown; headers?: Record<string, string> } | "unreachable";

/** The CLI run in this process as the stand-in for npx, recording every call; the install answers as given. */
export function cliStandIn(calls: CliCall[], answer: (request: Request) => InstallAnswer = () => ({ status: 200, body: { id: "4f9c1d3e-8b7a-4c2d-9e1f-0a2b3c4d5e6f", api: "payments-api", receivedAt: "2026-10-02T09:00:00.000Z" } })): Npx {
  return async (args, env) => {
    const at = args.findIndex((arg) => arg.startsWith("tiehall@"));
    let stdout = "";
    let stderr = "";
    const status = await run({
      argv: args.slice(at + 1),
      env,
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
      async fetch(request) {
        const body = request.method === "GET" ? undefined : await request.clone().text();
        calls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: body === undefined || body === "" ? undefined : JSON.parse(body) });
        const url = new URL(request.url);
        if (`${url.origin}${url.pathname}` === TOKEN_SERVICE.split("?")[0]) {
          return Response.json({ value: oidcTokenFor(url.searchParams.get("audience") ?? "") });
        }
        const given = answer(request);
        if (given === "unreachable") throw new TypeError("fetch failed");
        return new Response(JSON.stringify(given.body), {
          status: given.status,
          headers: { "content-type": given.status >= 400 ? "application/problem+json" : "application/json", ...given.headers },
        });
      },
    });
    return { status, stdout, stderr } satisfies ExecResult;
  };
}
