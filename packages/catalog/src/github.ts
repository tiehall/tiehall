import { z } from "zod";
import { defineCommand } from "./command.ts";

// The operations on the install's GitHub App installations (tracker-mirrors:
// Admins connect GitHub installations with the confirmation step;
// tracker-mirrors: Covered repositories follow each connected installation;
// teams-and-roles: What admins and members may do). Tiehall acts only on
// installations an admin has connected. Only admins run these, in the web UI;
// connecting needs the confirmation step, so no agent surface offers any of
// them, and disconnecting, which only narrows what Tiehall acts on, needs
// none.

/** An installation of the install's App, as the admin page lists it, by Tiehall's id and GitHub's. */
export const githubInstallation = z.object({
  id: z.uuid(),
  installationId: z.number().int().positive(),
  /** The login of the GitHub account the App is installed on, an organization's or a person's; not a Tiehall user. */
  account: z.string(),
  accountType: z.enum(["Organization", "User"]),
  repositorySelection: z.enum(["all", "selected"]),
  suspended: z.boolean(),
  /** A listing of the App's installations no longer holds it: it was deleted on GitHub. */
  deleted: z.boolean(),
  connected: z.boolean(),
  /** The repositories it covers, for a connected installation that is neither suspended nor deleted. */
  repositories: z.array(z.string()),
});

export const listGitHubInstallations = defineCommand({
  id: "github.list_installations",
  summary: "List the installations of the install's GitHub App, connected or not, with the repositories the connected ones cover.",
  input: z.object({}),
  output: z.object({ installations: z.array(githubInstallation) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const connectGitHubInstallation = defineCommand({
  id: "github.connect_installation",
  summary: "Connect an installation of the install's GitHub App, so Tiehall acts on it.",
  input: z.object({ installation: z.uuid() }),
  output: z.object({ installation: z.uuid(), connected: z.literal(true) }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const disconnectGitHubInstallation = defineCommand({
  id: "github.disconnect_installation",
  summary: "Disconnect an installation of the install's GitHub App, so Tiehall no longer acts on it.",
  input: z.object({ installation: z.uuid() }),
  output: z.object({ installation: z.uuid(), connected: z.literal(false) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const GITHUB_COMMANDS = [listGitHubInstallations, connectGitHubInstallation, disconnectGitHubInstallation];
