import { TEAM_KEY } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { teamRef } from "./requests.ts";
import { INSTALL_URL, user } from "./schemas.ts";

// Who an agent acts for, and whom it can address (agent-surfaces: The MCP
// tools; teams-and-roles: Bot users; design.md, Decisions this change rests
// on: D28 #56, #94). whoami names the user a connection acts for, marked when
// an admin flagged them as a bot, the teams they belong to, and the install,
// by its URL, TIEHALL_URL. It is offered on REST too, where the CLI reads the
// user's teams, which decide the origin of each text it fences (agent-safety:
// Every string shown to agents has an origin).
// directory lists the install's teams, each with its key, the address of its
// requests, and its name, which an admin wrote and so sits under `untrusted`,
// and the registered APIs, each with its provider team and the teams declared
// as its consumers (contract-changes), none until APIs can be registered.
// Every member may read both, whatever their role; neither changes anything.

export const whoami = defineCommand({
  id: "users.whoami",
  summary:
    "Say who this connection acts for: the user, and whether an admin flagged them as a bot, the teams they belong to, and the Tiehall install, by its URL.",
  input: z.object({}),
  output: z.object({
    user,
    teams: z.array(teamRef).meta({ description: "The teams the user belongs to, by key: their own team's text is fenced as the same team's." }),
    install: z.object({
      url: z.string().regex(INSTALL_URL).meta({ description: "The install's URL, TIEHALL_URL, as an origin: where its requests live." }),
    }),
  }),
  method: "GET",
  path: "/api/v1/whoami",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "mcp"],
  tool: "whoami",
  stability: "alpha",
});

/** A team as the directory lists it: its id, its key, which its requests' keys start with, and its name. */
const directoryTeam = z.object({
  id: z.uuid(),
  key: z.string().regex(TEAM_KEY).meta({ description: "The team's key, such as FE, which open_request addresses it by." }),
  untrusted: z.object({ name: z.string() }),
});

/** A registered API as the directory lists it: its provider team, the teams declared as its consumers, and its name. */
const directoryApi = z.object({
  id: z.uuid(),
  provider: teamRef,
  consumers: z.array(teamRef),
  untrusted: z.object({ name: z.string() }),
});

export const readDirectory = defineCommand({
  id: "directory.get",
  summary:
    "List the install's teams, each with its key, which open_request addresses it by, and its name, and the registered APIs, each with its provider team and the teams declared as its consumers.",
  input: z.object({}),
  output: z.object({ teams: z.array(directoryTeam), apis: z.array(directoryApi) }),
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["mcp"],
  tool: "directory",
  stability: "alpha",
});

export const DIRECTORY_COMMANDS = [whoami, readDirectory];
