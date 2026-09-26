import changelog from "../../../openapi/changelog.json" with { type: "json" };
import { parseChangelog, type Changelog } from "./changelog.ts";

// The API changelog an install shows at /docs/api/changelog (public-api: The
// changelog page and the release notes): the committed openapi/changelog.json,
// carried in the build, so an install lists the API changes of every release
// up to the one it runs. Only the changelog page imports it, through its own
// subpath, so nothing that sends email reaches it.

export const API_CHANGELOG: Changelog = parseChangelog(JSON.stringify(changelog));
