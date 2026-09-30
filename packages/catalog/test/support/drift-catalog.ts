import { z } from "zod";
import { defineCommand, type CommandDefinition } from "../../src/index.ts";

// A fixture catalog for the drift check, whose document is committed as fixtures/openapi/v1.json.

export const openRequest: CommandDefinition = defineCommand({
  id: "requests.create",
  summary: "Open a request to a team.",
  input: z.object({ team: z.string(), title: z.string() }),
  output: z.object({ key: z.string() }),
  method: "POST",
  path: "/api/v1/requests",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "cli"],
  cli: [{ command: "open" }],
  stability: "beta",
});
