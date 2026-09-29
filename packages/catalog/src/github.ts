import { GITHUB_MODES } from "@tiehall/core";
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

/** GitHub's mode: webhook, in which changes arrive as deliveries, or polling, in which Tiehall polls GitHub every 60 seconds. */
const githubMode = z.enum(GITHUB_MODES).meta({
  description: "webhook: GitHub delivers changes to the install's webhook; polling: Tiehall polls GitHub every 60 seconds.",
});

export const getGitHubIntegration = defineCommand({
  id: "github.get_integration",
  summary: "Show the install's GitHub App and how its changes reach Tiehall: by webhook or by polling.",
  input: z.object({}),
  output: z.object({
    app: z
      .object({
        name: z.string(),
        slug: z.string(),
        /** The GitHub account that owns the App, an organization's or a person's; not a Tiehall user. */
        owner: z.string(),
        ownerType: z.enum(["Organization", "User"]),
        mode: githubMode,
        /** Whether a webhook secret is stored, to verify deliveries with. */
        webhookSecret: z.boolean(),
      })
      .nullable(),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const setGitHubMode = defineCommand({
  id: "github.set_mode",
  summary: "Switch how GitHub's changes reach Tiehall: by webhook, or by polling every 60 seconds.",
  input: z.object({ mode: githubMode }),
  output: z.object({ mode: githubMode, previousMode: githubMode }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

/** The longest webhook secret Tiehall stores. GitHub names no limit; this one keeps a pasted value within reason. */
const WEBHOOK_SECRET_MAX_LENGTH = 1024;

export const storeGitHubWebhookSecret = defineCommand({
  id: "github.store_webhook_secret",
  summary: "Store the webhook secret of the install's GitHub App, replacing any stored one, so that GitHub's deliveries can be verified.",
  // The secret is no part of the input, which the review page's URL carries: the admin enters it on the review page itself.
  input: z.object({}),
  output: z.object({ stored: z.literal(true), replaced: z.boolean() }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
  sealed: [
    {
      name: "secret",
      label: "The webhook secret, as set in the App's settings on GitHub",
      kind: "password",
      schema: z
        .string()
        .min(1, "A webhook secret is not empty.")
        .max(WEBHOOK_SECRET_MAX_LENGTH, `A webhook secret has at most ${WEBHOOK_SECRET_MAX_LENGTH} characters.`),
    },
  ],
});

export const GITHUB_COMMANDS = [
  listGitHubInstallations,
  connectGitHubInstallation,
  disconnectGitHubInstallation,
  getGitHubIntegration,
  setGitHubMode,
  storeGitHubWebhookSecret,
];
