import { z } from "zod";
import { defineCommand } from "./command.ts";
import { teamRef } from "./requests.ts";

// A user's email settings (requester-loop: Email for people, only when SMTP is
// set; design.md, Decisions this change rests on: D28 #61; D29 (6); design.md,
// Self-hosting decisions: S10). Email goes to the primary verified address of
// the user's GitHub account, which sign-in reads, and a user can turn off the
// daily digest, and with it the WARN digests of their teams, but no setting
// stops transactional email: proposal notices, receipts and the questions
// asked of them. Each member also chooses, for each of their teams, whether
// they get the emails that go to that team as the requester of a request,
// which are off until they turn them on (requester-loop: When the requester
// is a team). Only the web UI reads and changes these settings, each for
// the signed-in user alone; a change needs no confirmation step, since it
// changes only what the user themselves receive.

/** A user's email settings: where email goes, whether the daily digest is on, and which of their teams' emails as a requester they get. */
export const emailSettings = z.object({
  /** The primary verified address of the user's GitHub account, as sign-in last read it; null when it read none. */
  address: z.string().nullable(),
  /** Whether the user gets the daily digest. */
  digest: z.boolean(),
  /**
   * Each of the user's teams, by key, and whether the user gets the emails
   * that go to it as the requester of a request, off until they turn it on
   * (requester-loop: When the requester is a team).
   */
  teams: z.array(z.object({ team: teamRef, requesterEmails: z.boolean() })),
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

export const setRequesterEmails = defineCommand({
  id: "users.set_requester_emails",
  summary:
    "Turn on or off, for one of your teams, the emails that go to it as the requester of a request, such as the questions asked of it and the notices that ask its side to confirm; your web inbox lists them either way.",
  input: z.object({
    team: z.uuid().meta({ description: "One of your teams." }),
    on: z.boolean().meta({ description: "Whether you get its emails as a requester." }),
  }),
  output: emailSettings,
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const EMAIL_SETTINGS_COMMANDS = [readEmailSettings, setEmailSettings, setRequesterEmails];
