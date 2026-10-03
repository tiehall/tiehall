import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "@tiehall/catalog";
import { describe, expect, it } from "vitest";
import { INSTALL_DOCS } from "../src/docs-commands.ts";
import { headings, linkProblems, section } from "../src/markdown.ts";

// The security and trust docs (task 28.5; agent-safety: The documented limit
// of the confirmation step; activity-log: What the activity log does not
// prove; self-host-install: No telemetry and a documented list of outbound
// connections; self-host-install: Logs carry ids, never message text or
// credentials). docs/security-and-trust.md states what the confirmation step
// does not prove, with the advice on browser profiles; that the activity log
// is not tamper-evident and that a tamper-evident log is planned; that an
// install sends no telemetry, which hosts it connects to and the switch that
// stops metadata-document fetches; and what the logs hold. The check finds
// each statement, and the same outbound hosts as the install docs list.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE = "docs/security-and-trust.md";
const page = existsSync(join(root, PAGE)) ? readFileSync(join(root, PAGE), "utf8") : "";
const install = readFileSync(join(root, INSTALL_DOCS), "utf8");

/** A section of a page as one line of text, or the empty text when it has none. */
const flat = (markdown: string, heading: string) => (section(markdown, heading) ?? "").replace(/\s+/g, " ");

/** The host names a section lists in code spans, such as `api.github.com` or `<name>.atlassian.net`. */
const hostsIn = (markdown: string, heading: string) =>
  [...(section(markdown, heading) ?? "").matchAll(/`((?:<[a-z]+>|[a-z0-9-]+)(?:\.[a-z0-9-]+)+)`/g)].map((match) => match[1] ?? "").sort();

const SECTIONS = [
  "What the confirmation step does not prove",
  "What the activity log does not prove",
  "No telemetry, and what an install connects to",
  "What the logs hold",
];

describe("the security and trust docs", () => {
  it("have a section for each statement, links that all resolve, and a link from the README", () => {
    const level2 = headings(page)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(SECTIONS.filter((heading) => !level2.includes(heading))).toEqual([]);
    expect(linkProblems(root, PAGE)).toEqual([]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`](${PAGE})`);
  });

  it("state what the confirmation step does not prove, advise against a signed-in browser profile for browser-driving agents, and say what reduces the risk without removing it", () => {
    const text = flat(page, "What the confirmation step does not prove");
    for (const phrase of [
      "An agent that drives your own signed-in browser can click confirm on a review page",
      "can post a message from the web UI that clears a request's `needs_human` flag",
      "Do not give a browser-driving agent a browser profile that is signed in to Tiehall",
      "Receipts, the undo window and keeping the confirm URL away from models reduce this risk; they do not remove it",
      "`web_session`",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("name the changes the confirmation step guards as the catalog does, and say that changing who belongs to a team is not among them", () => {
    const text = flat(page, "What the confirmation step does not prove");
    const confirm = new Map(CATALOG.commands.map(({ id, confirm }) => [id, confirm]));
    // What the page names among the confirmations, and the commands that take them.
    const named: [string, string][] = [
      ["a role change", "members.change_role"],
      ["a member's removal", "members.remove"],
      ["an invite", "invites.create"],
      ["the sign-in policy", "settings.set_sign_in_policy"],
      ["the rules for personal access tokens", "settings.set_personal_access_tokens"],
      ["the daily budget of agent writes", "settings.set_write_budget"],
      ["a new personal access token", "personal_access_tokens.create"],
      ["the approval of an agent client", "agent_clients.approve"],
      ["connecting GitHub", "github.connect_installation"],
      ["changing its App's key or webhook secret", "github.upload_private_key"],
      ["changing its App's key or webhook secret", "github.store_webhook_secret"],
      ["registering an API", "apis.register"],
      ["exporting the activity log", "activity_log.export"],
    ];
    for (const [phrase, command] of named) {
      expect(text, phrase).toContain(phrase);
      expect(confirm.get(command), command).toBe(true);
    }
    // Team membership decides whose inbox a team's requests reach and who gives a team's side of a commitment.
    expect(text).toContain("An admin adds people to a team or takes them out of it without the confirmation step");
    for (const command of ["teams.add_member", "teams.remove_member"]) expect(confirm.get(command), command).toBe(false);
    expect(text).not.toContain("every change to who may do what");
  });

  it("say which confirmations give a receipt, and where the others show: receipts are for commitments and undos only (requests: Receipts)", () => {
    const text = flat(page, "What the confirmation step does not prove");
    for (const phrase of [
      "Every confirmation of a commitment, and every undo, gets a receipt in the web inbox",
      "The other confirmations give no receipt",
      "is recorded as a security event in the activity log",
      "is also listed on your page `/tokens`",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // A receipt is given for a proposal's confirmation and an undo, never for a new token, a role change or an invite.
    expect(text).not.toContain("Every confirmation gets a receipt");
  });

  it("state that the activity log is not tamper-evident, who can change it, and that a tamper-evident log is planned", () => {
    const text = flat(page, "What the activity log does not prove");
    for (const phrase of [
      "The activity log is not tamper-evident",
      "whoever holds the database owner role or controls the host can change or delete events without the change being detectable",
      "only stop the app itself from rewriting history",
      "A tamper-evident log, with a hash chain anchored outside the install, is planned as a later addition",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("state that an install sends no telemetry, list the same outbound hosts as the install docs, and name the switch for metadata documents", () => {
    const heading = "No telemetry, and what an install connects to";
    const text = flat(page, heading);
    for (const phrase of [
      "no usage statistics, no update check, no error reports and no license check",
      "Framework telemetry is off",
      "calls no language model",
      "`TIEHALL_CLIENT_METADATA_FETCH=off`",
      "Dynamic Client Registration",
      "load nothing from other hosts",
      "SMTP server",
      "Client ID Metadata Documents",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    const hosts = hostsIn(page, heading);
    expect(hosts).toEqual(expect.arrayContaining(["github.com", "api.github.com", "token.actions.githubusercontent.com", "<name>.atlassian.net"]));
    // The install docs also name the registry the host pulls the image from, which is the host's connection, not the install's.
    expect(hosts).toEqual(hostsIn(install, "What an install connects to").filter((host) => host !== "ghcr.io"));
  });

  it("state what the logs hold: JSON lines of ids, never message text or credentials, and the setup code as the one secret", () => {
    const text = flat(page, "What the logs hold");
    for (const phrase of [
      "one JSON object per line on standard output",
      "ids",
      "never the text of messages or packets",
      "personal access tokens",
      "session cookies",
      "confirmation nonces",
      "`Authorization`",
      "`Cookie`",
      "query strings",
      "The one secret the log shows is the setup code",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});
