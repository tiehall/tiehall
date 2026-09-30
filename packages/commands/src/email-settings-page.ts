import { readEmailSettings, setEmailSettings } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { escapeHtml, htmlPage } from "./html.ts";
import { createPageRoute, htmlAnswer, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// A member's email settings, at /settings/email (requester-loop: Email for
// people, only when SMTP is set; design.md, Decisions this change rests on:
// D28 #61; D29 (6); design.md, Self-hosting decisions: S10). The page says
// where Tiehall emails the member, the primary verified address of their
// GitHub account, whether the install sends email at all, and whether the
// daily digest is on, with the one form there is: it turns the digest off or
// on again, passes the web UI's write checks and leads back to the page. No
// setting stops transactional email, and the page says so: proposal notices,
// receipts and the questions asked of the member are always emailed when the
// install sends email. The page reads through execute(), as the member's web
// session, in a read-only transaction.

/** Where a member's email settings live. */
export const EMAIL_SETTINGS_PATH = "/settings/email";

export interface EmailSettingsPageOptions {
  /** Whether the install has SMTP settings, and so sends email at all. */
  emailSetUp: boolean;
}

export function createEmailSettingsRoute(options: PageRouteOptions, { emailSetUp }: EmailSettingsPageOptions): PageRoute {
  return createPageRoute(options, {
    path: EMAIL_SETTINGS_PATH,
    name: "email settings",
    async get(_query, { read, csrf }) {
      const { address, digest } = await read<{ address: string | null; digest: boolean }>(readEmailSettings.id, {});
      const lines = [
        "      <h1>Email settings</h1>",
        emailSetUp
          ? "      <p>This install sends email through its SMTP server.</p>"
          : "      <p>This install has no SMTP settings, so Tiehall sends no email: every notice waits in your web inbox.</p>",
        address === null
          ? "      <p>Tiehall has no address for you: your GitHub account showed no primary verified email address when you last signed in.</p>"
          : `      <p>Tiehall emails you at ${escapeHtml(address)}, the primary verified address of your GitHub account.</p>`,
        "      <h2>Daily digest</h2>",
        `      <p>${digest ? "The daily digest is on." : "The daily digest is off."} It gathers your updates of each UTC day that were not emailed as they came, once the day has ended, and turning it off also stops your teams' WARN digest emails.</p>`,
        postForm(EMAIL_SETTINGS_PATH, { digest: digest ? "off" : "on" }, csrf, digest ? "Turn the daily digest off" : "Turn the daily digest on"),
        "      <h2>Always emailed</h2>",
        "      <p>Proposal notices, receipts and the questions asked of you are always emailed; no setting turns them off.</p>",
      ];
      return htmlAnswer(htmlPage("Email settings", lines.join("\n")));
    },
    async post(form, { write }) {
      const digest = form.get("digest");
      if (digest !== "on" && digest !== "off") throw new Refusal("invalid-input", "The form turns the daily digest on or off.");
      await write(setEmailSettings.id, { digest: digest === "on" });
      return seeOther(EMAIL_SETTINGS_PATH);
    },
  });
}
