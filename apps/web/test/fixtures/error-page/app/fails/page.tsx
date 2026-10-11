// A page that fails while it renders, so the app's page for a failed render is shown in its place. It is at /fails,
// a path no route handler of the web app serves, as a request's page is. Rendered for every request, never
// prerendered, so the build does not fail on it.
export const dynamic = "force-dynamic";

export default function Page(): never {
  throw new Error("The fixture's page fails while it renders.");
}
