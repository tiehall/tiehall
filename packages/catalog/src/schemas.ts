import { ROLES } from "@tiehall/core";
import { z } from "zod";

// Schemas that several definitions share, so every input that names the same
// thing parses it the same way.

/**
 * A role that an invite or a role change names: admin or member, and no other,
 * such as owner, which fails the schema and so gets 400 (teams-and-roles: Two
 * roles, admin and member).
 */
export const role = z.enum(ROLES);

/**
 * The form of a GitHub login: letters, digits and hyphens, and an underscore
 * before the suffix of an enterprise-managed account. It holds no space, so an
 * output may name a user by it outside an untrusted object (agent-safety: User
 * text in JSON sits under untrusted objects).
 */
export const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * A user as every output that names one shows them: their id, their GitHub
 * login, their kind, which is human for every user in v1, and whether an admin
 * flagged them as a bot, so a bot is marked wherever a user is listed or named
 * (teams-and-roles: Bot users).
 */
export const user = z.object({
  id: z.uuid(),
  login: z.string().regex(GITHUB_LOGIN),
  kind: z.literal("human"),
  bot: z.boolean(),
});

/**
 * The form of the install's URL, TIEHALL_URL, as an origin: a scheme, a host
 * and a port, with no path. It holds no space, so an output may name the
 * install by it outside an untrusted object (agent-safety: User text in JSON
 * sits under untrusted objects).
 */
export const INSTALL_URL = /^https?:\/\/(?:[A-Za-z0-9\.-]+|\[[0-9A-Fa-f:\.]+\])(?::\d{1,5})?$/;

/** A GitHub account's name, a user's or an organization's: letters, digits and hyphens, not starting with a hyphen. */
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
/** A repository's name: letters, digits, dots, hyphens and underscores, other than "." and "..". */
const NAME = "(?!\\.\\.?(?:/|$))[A-Za-z0-9\\._-]{1,100}";

/** A repository on GitHub.com, as owner/name, such as acme/web. */
export const GITHUB_REPOSITORY = new RegExp(`^${OWNER}/${NAME}$`);

/** A pull request's URL on GitHub.com, such as https://github.com/acme/web/pull/88. */
export const PULL_REQUEST_URL = new RegExp(`^https://github\\.com/${OWNER}/${NAME}/pull/[1-9][0-9]{0,8}$`);

/** An API's name: 1 to 100 lower-case letters, digits, dots, hyphens and underscores, starting with a letter or digit, such as payments-api. */
export const API_NAME = /^[a-z0-9][a-z0-9\._-]{0,99}$/;
