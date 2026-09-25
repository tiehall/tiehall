// The public health check answers only "up" (operations draft §4, TLS). Task 5.4
// adds the database, drain and schema detail for requests with the monitoring token.
export function GET(): Response {
  return Response.json({ status: "up" }, { headers: { "cache-control": "no-store" } });
}
