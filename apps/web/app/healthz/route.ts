// The public health check (self-host-install: `/healthz` answers only up or
// down). Task 5.6 makes it answer "down" when the database is unreachable.
export function GET(): Response {
  return Response.json({ status: "up" }, { headers: { "cache-control": "no-store" } });
}
