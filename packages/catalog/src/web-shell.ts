import { z } from "zod";
import { defineCommand } from "./command.ts";
import { GITHUB_LOGIN } from "./schemas.ts";

// The read behind the web UI's top bar (web-ui: The page shell and its
// navigation; design.md, Design: The page shell and navigation; D57 (4)): the
// signed-in member's GitHub login, whether an admin flagged them as a bot,
// whether they are an admin, whom the admin pages are linked for, and how many
// proposals wait for their own confirmation, as their web inbox's standing
// list counts them (requester-loop: The web inbox). Every page in the app
// shell runs it as its first read. It is internal: no agent surface offers it,
// and every member may run it, as members.list.

export const webShell = defineCommand({
  id: "web.shell",
  summary: "What the web UI's top bar shows the signed-in member: their login, whether they are flagged as a bot, whether they are an admin, and how many proposals wait for their confirmation.",
  input: z.object({}),
  output: z.object({
    login: z.string().regex(GITHUB_LOGIN),
    // Every user is a person; a user named by their login also says their kind and their bot flag (teams-and-roles: Bot users).
    kind: z.literal("human"),
    bot: z.boolean(),
    admin: z.boolean(),
    waiting: z.number().int().min(0),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const WEB_SHELL_COMMANDS = [webShell];
