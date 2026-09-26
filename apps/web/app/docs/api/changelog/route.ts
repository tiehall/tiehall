import { API_CHANGELOG } from "@tiehall/catalog/api-changelog";
import { changelogPage } from "../../../../lib/api-changelog.ts";

// The API changelog page (public-api: The changelog page and the release
// notes): anyone may read it, without signing in. It shows the changelog the
// build carries.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return changelogPage(API_CHANGELOG);
}
