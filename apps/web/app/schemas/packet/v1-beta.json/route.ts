import { packetSchemaRoute } from "@tiehall/commands/web";

// The beta packet schema (handoff-packet: The beta label): anyone may fetch
// it, without signing in, once setup is complete; the setup gate answers
// before that. It holds no data of the install.

export function GET(request: Request): Response {
  return packetSchemaRoute(request);
}

export { GET as HEAD };
