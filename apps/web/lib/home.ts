import { headers } from "next/headers";
import { webSession } from "@tiehall/commands/web";

// What the home page shows (sign-in: GitHub is the only way to sign in): a
// person who is not signed in is sent to the sign-in page, which offers sign-in
// with GitHub; a signed-in member gets the web UI; a browser whose session a
// removal ended gets no data, only the refusal's text.

export type HomeState = { kind: "sign-in" } | { kind: "signed-in"; userId: string } | { kind: "refused"; detail: string };

export async function homeState(): Promise<HomeState> {
  try {
    const caller = await webSession(process.env, new Headers(await headers()));
    return caller === undefined ? { kind: "sign-in" } : { kind: "signed-in", userId: caller.userId };
  } catch (error) {
    if (error instanceof Error && error.name === "RemovedMemberError") return { kind: "refused", detail: error.message };
    throw error;
  }
}
