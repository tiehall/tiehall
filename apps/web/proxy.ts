import { NextResponse } from "next/server";
import { setupGate } from "@tiehall/commands/setup";

// Runs before every route (self-host-install: The setup code guards the setup
// screen; design.md, Self-hosting decisions: S3). Until setup is complete, the
// setup gate answers every call but /setup, /healthz and, once the setup
// screen has stored the GitHub App's credentials, with or without a webhook
// secret, /webhooks/github: a page leads to /setup and an API call gets 503
// setup-required. Afterwards every call goes on to its route.

export async function proxy(request: Request): Promise<Response> {
  return (await setupGate(process.env)(request)) ?? NextResponse.next();
}
