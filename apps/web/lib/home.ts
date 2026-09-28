import { headers } from "next/headers";
import { csrfTokenOf, webSession } from "@tiehall/commands/web";

// What the home page shows (sign-in: GitHub is the only way to sign in;
// sign-in: Signing out and ending sessions): a person who is not signed in is
// sent to the sign-in page, which offers sign-in with GitHub; a signed-in
// member gets the web UI, with the sign-out form, which carries the session's
// CSRF token; a browser whose session a removal ended gets no data, only the
// refusal's text.

export type HomeState =
  | { kind: "sign-in" }
  | { kind: "signed-in"; userId: string; csrfToken: string }
  | { kind: "refused"; detail: string };

export async function homeState(): Promise<HomeState> {
  try {
    const caller = await webSession(process.env, new Headers(await headers()));
    if (caller === undefined) return { kind: "sign-in" };
    return { kind: "signed-in", userId: caller.userId, csrfToken: csrfTokenOf(process.env, caller) };
  } catch (error) {
    if (error instanceof Error && error.name === "RemovedMemberError") return { kind: "refused", detail: error.message };
    throw error;
  }
}
