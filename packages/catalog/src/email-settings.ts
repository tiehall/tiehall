import { z } from "zod";
import { defineCommand } from "./command.ts";

// A user's email settings (requester-loop: Email for people, only when SMTP is
// set; design.md, Decisions this change rests on: D28 #61; D29 (6); design.md,
// Self-hosting decisions: S10). Email goes to the primary verified address of
// the user's GitHub account, which sign-in reads, and a user can turn off the
// daily digest, and with it the WARN digests of their teams, but no setting
// stops transactional email: proposal notices, receipts and the questions
// asked of them. Only the web UI reads and changes these settings, each for
// the signed-in user alone; a change needs no confirmation step, since it
// changes only what the user themselves receive.

/** A user's email settings: where email goes, and whether the daily digest is on. */
export const emailSettings = z.object({
  /** The primary verified address of the user's GitHub account, as sign-in last read it; null when it read none. */
  address: z.string().nullable(),
  /** Whether the user gets the daily digest. */
  digest: z.boolean(),
});

export const readEmailSettings = defineCommand({
  id: "users.email_settings",
  summary: "Your email settings: the address Tiehall emails you at, your GitHub account's primary verified address, and whether the daily digest is on.",
  input: z.object({}),
  output: emailSettings,
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const setEmailSettings = defineCommand({
  id: "users.set_email_settings",
  summary: "Turn your daily digest on or off; transactional email, such as proposal notices and receipts, has no setting and always goes out.",
  input: z.object({ digest: z.boolean().meta({ description: "Whether you get the daily digest." }) }),
  output: emailSettings,
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const EMAIL_SETTINGS_COMMANDS = [readEmailSettings, setEmailSettings];
