import { z } from "zod";

// Inputs of the integration settings (agent-safety: Outbound fetches refuse
// internal addresses; tracker-mirrors: Jira Cloud connects through a bot
// account's API token; design.md, Self-hosting decisions: S8). Tiehall calls
// Jira only at the connected site, whose URL must have the form
// https://<name>.atlassian.net, so an admin can never point it at an internal
// host: any other URL fails the input schema of the operation that takes it,
// and gets 400 before any call.

/** The form of a Jira Cloud site's URL: https://, one lower-case label, .atlassian.net, and an optional slash. */
export const JIRA_SITE_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net\/?$/;

/** A Jira Cloud site's URL, such as https://acme.atlassian.net. */
export const jiraSiteUrl = z
  .string()
  .regex(JIRA_SITE_URL, "A Jira site URL has the form https://<name>.atlassian.net.")
  .meta({ description: "The Jira Cloud site, such as https://acme.atlassian.net." });
