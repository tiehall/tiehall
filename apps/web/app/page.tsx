import { redirect } from "next/navigation";
import { homeState } from "../lib/home.ts";

// Rendered for every request, with the session its cookie names.
export const dynamic = "force-dynamic";

export default async function Home() {
  const state = await homeState();
  if (state.kind === "sign-in") redirect("/sign-in");
  if (state.kind === "refused") return <main>{state.detail}</main>;
  return (
    <main>
      <h1>Tiehall</h1>
      <p>You are signed in.</p>
      <form method="post" action="/sign-out">
        <input type="hidden" name="csrf" value={state.csrfToken} />
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
