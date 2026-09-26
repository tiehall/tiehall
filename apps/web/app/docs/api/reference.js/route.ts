import { referenceScript } from "../../../../lib/api-reference.ts";

// The reference page's own script, which starts Scalar with Tiehall's settings
// (public-api: The API reference page at `/docs/api`).
export const dynamic = "force-dynamic";

export function GET(): Response {
  return referenceScript();
}
