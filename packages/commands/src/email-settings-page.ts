import { readEmailSettings, setEmailSettings, setRequesterEmails } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { escapeHtml, htmlPage } from "./html.ts";
import { keyTag, panelHtml } from "./page-parts.ts";
import { createPageRoute, htmlAnswer, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// A member's email settings, at /settings/email (requester-loop: Email for
// people, only when SMTP is set; design.md, Decisions this change rests on:
// D28 #61; D29 (6); design.md, Self-hosting decisions: S10). The page says
// where Tiehall emails the member, the primary verified address of their
// GitHub account, whether the install sends email at all, and whether the
// daily digest is on, with the form that turns the digest off or on again;
// and, for each of the member's teams, whether they get the emails that go to
// that team as a requester, with the form that turns them on or off
// (requester-loop: When the requester is a team). Each form passes the web
// UI's write checks and leads back to the page. No
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
    async get(_query, { read, csrf, shell }) {
      const { address, digest, teams } = await read<{ address: string | null; digest: boolean; teams: { team: { id: string; key: string }; requesterEmails: boolean }[] }>(
        readEmailSettings.id,
        {},
      );
      const status = (on: boolean) => `<span class="chip tag${on ? " good" : ""}">${on ? "On" : "Off"}</span>`;
      const lines = [
        "      <h1>Email settings</h1>",
        '      <div class="lead">',
        emailSetUp
          ? "        <p>This install sends email through its SMTP server.</p>"
          : "        <p>This install has no SMTP settings, so Tiehall sends no email: every notice waits in your web inbox.</p>",
        address === null
          ? "        <p>Tiehall has no address for you: your GitHub account showed no primary verified email address when you last signed in.</p>"
          : `        <p>Tiehall emails you at ${escapeHtml(address)}, the primary verified address of your GitHub account.</p>`,
        "      </div>",
        panelHtml("digest", "Daily digest", [
          '        <div class="setting">',
          `          <p class="setting-text">${status(digest)} ${digest ? "The daily digest is on." : "The daily digest is off."} It gathers your updates of each UTC day that were not emailed as they came, once the day has ended, and turning it off also stops your teams' WARN digest emails.</p>`,
          postForm(EMAIL_SETTINGS_PATH, { digest: digest ? "off" : "on" }, csrf, digest ? "Turn the daily digest off" : "Turn the daily digest on", "          ", "secondary"),
          "        </div>",
        ]),
        panelHtml("requester-emails", "Emails to your teams as requesters", [
          '        <p class="hint">When one of your teams alone is the requester of a request, such as a contract-change request whose provider pull request\'s author is not a member of this install, the questions asked of the team and the proposals that wait for its side go to your web inbox, and by email only when you turn that team\'s emails on.</p>',
          ...(teams.length === 0
            ? ['        <p class="empty">You belong to no team.</p>']
            : teams.flatMap(({ team, requesterEmails }) => [
                '        <div class="setting">',
                `          <p class="setting-text">${status(requesterEmails)} ${keyTag(team.key)} <span>${escapeHtml(`Emails to ${team.key} as a requester are ${requesterEmails ? "on" : "off"}.`)}</span></p>`,
                postForm(
                  EMAIL_SETTINGS_PATH,
                  { team: team.id, requesterEmails: requesterEmails ? "off" : "on" },
                  csrf,
                  `Turn ${requesterEmails ? "off" : "on"} ${team.key}'s emails`,
                  "          ",
                  "secondary",
                ),
                "        </div>",
              ])),
        ]),
        panelHtml("always", "Always emailed", ["        <p>Proposal notices, receipts and the questions asked of you are always emailed; no setting turns them off.</p>"]),
      ];
      return htmlAnswer(htmlPage("Email settings", lines.join("\n"), shell));
    },
    async post(form, { write }) {
      const team = form.get("team");
      if (team !== null) {
        const choice = form.get("requesterEmails");
        if (choice !== "on" && choice !== "off") throw new Refusal("invalid-input", "The form turns a team's emails as a requester on or off.");
        await write(setRequesterEmails.id, { team, on: choice === "on" });
        return seeOther(EMAIL_SETTINGS_PATH);
      }
      const digest = form.get("digest");
      if (digest !== "on" && digest !== "off") throw new Refusal("invalid-input", "The form turns the daily digest on or off.");
      await write(setEmailSettings.id, { digest: digest === "on" });
      return seeOther(EMAIL_SETTINGS_PATH);
    },
  });
}
