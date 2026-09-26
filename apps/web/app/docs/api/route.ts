import { referencePage } from "../../../lib/api-reference.ts";

// The API reference page (public-api: The API reference page at `/docs/api`):
// anyone may read it, without signing in. Answered on every call, because each
// answer carries a nonce of its own.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return referencePage();
}
