import { scalarBundle } from "../../../../lib/api-reference.ts";

// Scalar's browser bundle, served by the install itself so the reference page
// loads nothing from another host (public-api: The API reference page at
// `/docs/api`; design.md, Self-hosting decisions: S13).
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return scalarBundle(request);
}
