import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportedContractSection } from "@tiehall/catalog";
import * as notices from "@tiehall/packet/notices";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as apiConsumers from "../src/api-consumers.ts";
import * as closeOnMerge from "../src/close-on-merge.ts";
import * as contractRouting from "../src/contract-routing.ts";
import * as warnDigests from "../src/contract-warn-digests.ts";
import * as email from "../src/email.ts";
import * as githubIssues from "../src/github-issues.ts";
import { createGitHubIssues, syncMirror, type GitHubAppAccess, type WebSessionCaller } from "../src/index.ts";
import * as messages from "../src/messages.ts";
import * as mirrorTexts from "../src/mirror-texts.ts";
import * as providerPullRequests from "../src/provider-pull-requests.ts";
import * as trackerChanges from "../src/tracker-changes.ts";
import { providerOnStub } from "./support/contract.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, joinTeams, openRequestInTheWebUi, sessionOf } from "./support/requests.ts";

// Every kind of text Tiehall writes comes from a template (self-host-install:
// No model calls; design.md, Self-hosting decisions: S13): the summaries of
// its mirror issues and their comments; its digests, the daily email, a
// team's WARN digest and the SessionStart digest of the Claude Code hooks
// (tested beside the CLI, in packages/cli/test/hook-texts-twice.test.ts);
// its notices, in emails, hook lines, elicitation messages, the system
// messages it adds to a request's thread, the title and packet of a
// contract-change request and the web inbox's standing list; and its
// receipts. Each is rendered twice from the facts of one request that does not
// change, FE-142, which BE opened for FE, with the clock a day and a half
// later, another time zone and another Math.random for the second rendering,
// and both renderings are identical. A check fails when a template module
// exports a builder the suite does not render, when a system message is not
// made by a builder it renders, and when text is cast to an email's server
// text outside the template modules. Then the mirror of an unchanged request
// is synced again a day and a half later through the real job against the
// GitHub stub, and Tiehall writes nothing new: its summary renders the same.
// The web UI's pages, with their banners, are pages, not texts Tiehall sends
// or records, and are left out.

const INSTALL = "https://tiehall.example.com";

/** The unchanged request every text is about, and its facts. */
const REQUEST = {
  key: "FE-142",
  number: 142,
  targetTeam: "FE",
  requestingTeam: "BE",
  title: "Show the invoice total on the order page",
  state: "in_progress",
  dueDate: "2026-11-02",
  proposalId: "3f0c2a4e-8d7b-4b1e-9a55-6c2f1e0d7a31",
  marker: "6b8f1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
  occurredAt: "2026-10-19T14:37:12.345Z",
  expiresAt: new Date("2026-10-26T14:37:12.345Z"),
  pullRequest: { repository: "acme/payments", number: 310 },
} as const;

/** The contract section of FE-142's provider change. */
const SECTION: ReportedContractSection = {
  api: "payments-api",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "drop-legacy-amount", sha: "b".repeat(40) },
  engine: { name: "oasdiff", version: "1.32.1" },
  changes: [
    { id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" },
    { id: "request-parameter-became-required", level: "WARN", operation: "POST /payments" },
  ],
  provider_pr: { repository: "acme/payments", number: 310, url: "https://github.com/acme/payments/pull/310" },
  provider_status: "open",
};

/** The report that updated it. */
const REPORT: Parameters<typeof contractRouting.updateText>[1] = {
  id: "0e7d3b52-1c4a-4f6e-8a2b-9c1d0e3f4a5b",
  pullRequestNumber: 310,
  baseRef: "main",
  baseSha: "a".repeat(40),
  headRef: "drop-legacy-amount",
  headSha: "c".repeat(40),
  engineName: "oasdiff",
  engineVersion: "1.32.1",
  changes: SECTION.changes,
  receivedAt: new Date("2026-10-19T14:30:00Z"),
  authorGitHubId: 4242,
};

const key = () => email.requestKey(REQUEST.key);
const link = () => email.installLink(INSTALL, `/${REQUEST.key}`);
const notice = () => {
  const noticeKey = notices.noticeKey(REQUEST.key);
  return { key: noticeKey, eventType: notices.noticeEventType("request.message_posted"), team: notices.noticeTeam(REQUEST.targetTeam), url: notices.noticeUrl(INSTALL, noticeKey) };
};

/** An email as a template writes it: its subject, then its text. */
function emailOf<V extends email.TemplateValues>(template: email.EmailTemplate<V>, values: () => V): () => string {
  return () => {
    const given = values();
    return `${template.subject(given)}\n${template.text(given)}`;
  };
}

/** A digest's updates of FE-142, as the digest job reads them. */
const digestRequests = (): email.DigestRequest[] => [
  {
    key: key(),
    team: email.teamKey(REQUEST.targetTeam),
    url: link(),
    updates: [
      { at: email.updateTime(REQUEST.occurredAt), type: email.eventTypeText("request.message_posted"), said: email.updateSaid({ type: "request.message_posted", data: { kind: "question", blocking: true } }) },
      { at: email.updateTime("2026-10-19T15:02:00Z"), type: email.eventTypeText("request.state_changed"), said: email.updateSaid({ type: "request.state_changed", data: { state: "needs_info", previousState: "in_progress" } }) },
    ],
  },
];

const warnChangeSets = (): email.WarnDigestChangeSet[] => {
  const pullRequest = email.pullRequestText(REQUEST.pullRequest.repository, REQUEST.pullRequest.number);
  return [{ api: email.apiNameText("payments-api"), pullRequest: pullRequest.name, url: pullRequest.url, changes: 2 }];
};

/** A builder of a template module, rendered from FE-142's facts, once for each of its forms. */
interface Case {
  renders: (() => unknown)[];
}

/** What each template module exports that writes text, by name: every form it writes FE-142's texts in. */
const EMAIL: Record<string, Case> = {
  requestKey: { renders: [key] },
  installLink: { renders: [link, () => email.installLink(INSTALL), () => email.installLink(INSTALL, `/confirm/${REQUEST.proposalId}`)] },
  serverTime: { renders: [() => email.serverTime(REQUEST.expiresAt)] },
  serverDay: { renders: [() => email.serverDay(REQUEST.expiresAt)] },
  serverDays: { renders: [() => email.serverDays(REQUEST.expiresAt, REQUEST.expiresAt), () => email.serverDays(new Date(REQUEST.occurredAt), REQUEST.expiresAt)] },
  updateTime: { renders: [() => email.updateTime(REQUEST.occurredAt), () => email.updateTime(REQUEST.occurredAt, { withDay: true })] },
  dayCount: { renders: [() => email.dayCount(1), () => email.dayCount(14)] },
  commitmentPhrase: { renders: notices.COMMITMENT_KINDS.map((kind) => () => email.commitmentPhrase(kind)) },
  PROPOSAL_NOTICE: {
    renders: [
      emailOf(email.PROPOSAL_NOTICE, () => ({
        key: key(),
        what: email.commitmentPhrase("due_date"),
        expiresAt: email.serverTime(REQUEST.expiresAt),
        page: email.installLink(INSTALL, `/confirm/${REQUEST.proposalId}`),
      })),
    ],
  },
  teamKey: { renders: [() => email.teamKey(REQUEST.targetTeam)] },
  updateSubject: { renders: [() => email.updateSubject({ installUrl: INSTALL, key: REQUEST.key, eventType: "request.message_posted", team: REQUEST.targetTeam })] },
  QUESTION_NOTICE: {
    renders: [
      emailOf(email.QUESTION_NOTICE, () => ({
        subject: email.updateSubject({ installUrl: INSTALL, key: REQUEST.key, eventType: "request.message_posted", team: REQUEST.targetTeam }),
        key: key(),
        asker: email.teamKey(REQUEST.targetTeam),
        page: link(),
      })),
    ],
  },
  eventTypeText: { renders: [() => email.eventTypeText("request.state_changed")] },
  updateSaid: {
    renders: [
      () => email.updateSaid({ type: "request.state_changed", data: { state: "in_progress", previousState: "claimed" } }),
      () => email.updateSaid({ type: "request.message_posted", data: { kind: "question", blocking: true } }),
      () => email.updateSaid({ type: "request.unknown_kind", data: {} }),
    ],
  },
  digestText: {
    renders: [
      () => email.digestText({ days: email.serverDays(REQUEST.expiresAt, REQUEST.expiresAt), byRequest: digestRequests(), more: 0, inbox: email.installLink(INSTALL, "/inbox"), settings: email.installLink(INSTALL, "/settings/email") }),
      () => email.digestText({ days: email.serverDays(new Date(REQUEST.occurredAt), REQUEST.expiresAt), byRequest: digestRequests(), more: 3, inbox: email.installLink(INSTALL, "/inbox"), settings: email.installLink(INSTALL, "/settings/email") }),
    ],
  },
  DIGEST: {
    renders: [
      emailOf(email.DIGEST, () => ({
        days: email.serverDays(new Date(REQUEST.occurredAt), REQUEST.expiresAt),
        text: email.digestText({ days: email.serverDays(new Date(REQUEST.occurredAt), REQUEST.expiresAt), byRequest: digestRequests(), more: 1, inbox: email.installLink(INSTALL, "/inbox"), settings: email.installLink(INSTALL, "/settings/email") }),
      })),
    ],
  },
  receiptSentence: {
    renders: [
      ...["decline", "withdraw", "done", "due_date", "scope"].map((commitment) => () => email.receiptSentence({ kind: "took_effect", commitment, key: REQUEST.key, dueDate: REQUEST.dueDate, state: "applied" })),
      () => email.receiptSentence({ kind: "took_effect", commitment: "reassign", key: REQUEST.key, team: "MOB", state: "applied" }),
      () => email.receiptSentence({ kind: "took_effect", commitment: "due_date", key: REQUEST.key, dueDate: null, state: "applied" }),
      ...["pending", "applied", "expired", "rejected", "withdrawn", "cancelled"].map((state) => () => email.receiptSentence({ kind: "waits_for_other_side", commitment: "due_date", key: REQUEST.key, dueDate: REQUEST.dueDate, state })),
      () => email.receiptSentence({ kind: "waits_for_other_side", commitment: "scope", key: REQUEST.key, state: "pending" }),
      ...["decline", "due_date", "scope"].map((commitment) => () => email.receiptSentence({ kind: "undone", undoneBy: "ayse", commitment, key: REQUEST.key, dueDate: REQUEST.dueDate, state: "applied" })),
      () => email.receiptSentence({ kind: "undone", undoneBy: "ci-bot", undoneByBot: true, commitment: "reassign", key: REQUEST.key, team: "MOB", state: "applied" }),
    ],
  },
  RECEIPT: { renders: [emailOf(email.RECEIPT, () => ({ key: key(), sentence: email.receiptSentence({ kind: "took_effect", commitment: "decline", key: REQUEST.key, state: "applied" }) }))] },
  RECEIPT_WITH_UNDO: {
    renders: [
      emailOf(email.RECEIPT_WITH_UNDO, () => ({
        key: key(),
        sentence: email.receiptSentence({ kind: "took_effect", commitment: "decline", key: REQUEST.key, state: "applied" }),
        until: email.serverTime(REQUEST.expiresAt),
        page: email.installLink(INSTALL, `/confirm/${REQUEST.proposalId}/undo`),
      })),
    ],
  },
  personalAccessTokenReminderSentence: {
    renders: [() => email.personalAccessTokenReminderSentence({ createdOn: email.serverDay(new Date("2026-08-01T00:00:00Z")), expiresOn: email.serverDay(REQUEST.expiresAt), days: email.dayCount(14) })],
  },
  PERSONAL_ACCESS_TOKEN_REMINDER: {
    renders: [
      emailOf(email.PERSONAL_ACCESS_TOKEN_REMINDER, () => ({
        createdOn: email.serverDay(new Date("2026-08-01T00:00:00Z")),
        expiresOn: email.serverDay(REQUEST.expiresAt),
        days: email.dayCount(3),
        page: email.installLink(INSTALL, "/tokens"),
      })),
    ],
  },
  apiNameText: { renders: [() => email.apiNameText("payments-api")] },
  pullRequestText: { renders: [() => JSON.stringify(email.pullRequestText(REQUEST.pullRequest.repository, REQUEST.pullRequest.number))] },
  warnDigestText: {
    renders: [() => email.warnDigestText({ team: email.teamKey(REQUEST.targetTeam), day: email.serverDay(REQUEST.expiresAt), changeSets: warnChangeSets(), inbox: email.installLink(INSTALL, "/inbox"), settings: email.installLink(INSTALL, "/settings/email") })],
  },
  WARN_DIGEST: {
    renders: [
      emailOf(email.WARN_DIGEST, () => ({
        team: email.teamKey(REQUEST.targetTeam),
        day: email.serverDay(REQUEST.expiresAt),
        text: email.warnDigestText({ team: email.teamKey(REQUEST.targetTeam), day: email.serverDay(REQUEST.expiresAt), changeSets: warnChangeSets(), inbox: email.installLink(INSTALL, "/inbox"), settings: email.installLink(INSTALL, "/settings/email") }),
      })),
    ],
  },
  RECONFIRMATION_REQUEST: {
    renders: [
      emailOf(email.RECONFIRMATION_REQUEST, () => ({
        team: email.teamKey(REQUEST.targetTeam),
        api: email.apiNameText("payments-api"),
        lastConfirmedOn: email.serverDay(new Date("2026-07-20T00:00:00Z")),
        lastDay: email.serverDay(new Date("2026-11-16T00:00:00Z")),
        staleOn: email.serverDay(new Date("2026-11-17T00:00:00Z")),
        page: email.installLink(INSTALL, `/${REQUEST.targetTeam}`),
      })),
    ],
  },
  githubModeSentence: { renders: [() => email.githubModeSentence(true), () => email.githubModeSentence(false)] },
  githubWebhookProblemSentence: { renders: [() => email.githubWebhookProblemSentence(true), () => email.githubWebhookProblemSentence(false)] },
  githubWebhookFixSentence: { renders: [() => email.githubWebhookFixSentence(true), () => email.githubWebhookFixSentence(false)] },
  GITHUB_WEBHOOK_ALERT: {
    renders: [true, false].flatMap((polling) =>
      [true, false].map((removed) =>
        emailOf(email.GITHUB_WEBHOOK_ALERT, () => ({
          page: email.installLink(INSTALL, "/admin/github"),
          polling: email.githubModeSentence(polling),
          problem: email.githubWebhookProblemSentence(removed),
          fix: email.githubWebhookFixSentence(removed),
        })),
      ),
    ),
  },
  GITHUB_INSTALLATION_ALERT: {
    renders: [emailOf(email.GITHUB_INSTALLATION_ALERT, () => ({ broken: email.brokenInstallationsSentence({ suspended: ["acme"], deleted: [] }), page: email.installLink(INSTALL, "/admin/github") }))],
  },
  brokenInstallationsSentence: {
    renders: [
      () => email.brokenInstallationsSentence({ suspended: ["acme"], deleted: [] }),
      () => email.brokenInstallationsSentence({ suspended: [], deleted: ["acme-labs"] }),
      () => email.brokenInstallationsSentence({ suspended: ["acme", "acme-ops"], deleted: ["acme-labs"] }),
    ],
  },
  accountsText: { renders: [() => email.accountsText(["acme"]), () => email.accountsText(["acme", "acme-labs", "acme-ops"])] },
  repositoryText: { renders: [() => email.repositoryText("acme/payments")] },
  teamKeysText: { renders: [() => email.teamKeysText(["FE"]), () => email.teamKeysText(["FE", "MOB"]), () => email.teamKeysText(["APP", "FE", "MOB"])] },
  countText: { renders: [() => email.countText(12)] },
  CONTRACT_FAN_OUT_ALERT: {
    renders: [
      emailOf(email.CONTRACT_FAN_OUT_ALERT, () => ({
        count: email.countText(2),
        repository: email.repositoryText("acme/payments"),
        number: email.countText(310),
        api: email.apiNameText("payments-api"),
        teams: email.teamKeysText(["FE", "MOB"]),
        page: email.installLink(INSTALL, "/admin"),
      })),
    ],
  },
  TEST_MESSAGE: { renders: [emailOf(email.TEST_MESSAGE, () => ({ install: email.installLink(INSTALL) }))] },
};

/** What the email module exports that writes no text, and why. */
const EMAIL_NOT_TEXT: Record<string, string> = {
  DIGEST_UPDATES: "a count of updates a digest lists, not a text",
  SMTP_TIMEOUT_MS: "a time limit, not a text",
  openMailer: "sends the emails the templates write",
  emailStatus: "whether email is set up, for the admin page",
  sendTestMessage: "sends TEST_MESSAGE, which the suite renders",
};

const MIRROR: Record<string, Case> = {
  stateLabel: { renders: ["open", "claimed", "in_progress", "needs_info", "done", "declined", "withdrawn"].map((state) => () => mirrorTexts.stateLabel(state as "open")) },
  mirrorSummary: {
    renders: [
      () => JSON.stringify(mirrorTexts.mirrorSummary({ installUrl: INSTALL, key: REQUEST.key, targetTeam: REQUEST.targetTeam, requestingTeam: REQUEST.requestingTeam })),
      () => JSON.stringify(mirrorTexts.mirrorSummary({ installUrl: INSTALL, key: REQUEST.key, targetTeam: REQUEST.targetTeam, requestingTeam: REQUEST.targetTeam })),
      () => JSON.stringify(mirrorTexts.mirrorSummary({ installUrl: INSTALL, key: REQUEST.key, targetTeam: REQUEST.targetTeam, requestingTeam: REQUEST.requestingTeam, shipped: REQUEST.pullRequest })),
    ],
  },
  mirrorTitle: { renders: [() => mirrorTexts.mirrorTitle(REQUEST.key, REQUEST.title)] },
  stateComment: { renders: [() => mirrorTexts.stateComment({ key: REQUEST.key, state: "in_progress", link: link() })] },
  questionComment: {
    renders: [() => mirrorTexts.questionComment({ key: REQUEST.key, link: link() }), () => mirrorTexts.questionComment({ key: REQUEST.key, link: link(), state: "needs_info" })],
  },
  awayComment: {
    renders: [false, true].map((undone) => () => mirrorTexts.awayComment({ mirroredKey: REQUEST.key, key: "MOB-7", team: "MOB", link: email.installLink(INSTALL, "/MOB-7"), undone })),
  },
  backComment: {
    renders: [
      () => mirrorTexts.backComment({ key: REQUEST.key, from: "MOB", state: "in_progress", link: link(), undone: true }),
      () => mirrorTexts.backComment({ key: REQUEST.key, from: undefined, state: "in_progress", link: link(), undone: false }),
    ],
  },
};

const NOTICES: Record<string, Case> = {
  noticeKey: { renders: [() => notices.noticeKey(REQUEST.key)] },
  noticeTeam: { renders: [() => notices.noticeTeam(REQUEST.targetTeam)] },
  noticeEventType: { renders: [() => notices.noticeEventType("request.message_posted")] },
  noticeUrl: { renders: [() => notices.noticeUrl(INSTALL, notices.noticeKey(REQUEST.key))] },
  hookLine: { renders: [() => notices.hookLine(notice())] },
  emailSubject: { renders: [() => notices.emailSubject(notice())] },
  elicitationMessage: { renders: notices.COMMITMENT_KINDS.map((commitment) => () => notices.elicitationMessage({ key: notices.noticeKey(REQUEST.key), commitment })) },
};

/** What the notices module exports that writes no text, and why. */
const NOTICES_NOT_TEXT: Record<string, string> = {
  COMMITMENT_KINDS: "the kinds of commitment, not a text",
  NoticeInputError: "the error a value of the wrong form gets, whose message never quotes it",
};

/**
 * The texts the other modules write, which are no template module's: the
 * system messages a request's thread gets, the title and packet of a
 * contract-change request, the standing list's notices, and what a GitHub
 * mirror issue's body and comments end with.
 */
const OTHERS: Record<string, Case> = {
  "close-on-merge.ts mergedText": { renders: [() => closeOnMerge.mergedText({ pullRequest: "acme/web#88", key: REQUEST.key })] },
  "tracker-changes.ts mirrorClosedText": {
    renders: [
      () => trackerChanges.mirrorClosedText({ tracker: "github", mirroredKey: REQUEST.key, key: REQUEST.key, state: REQUEST.state }),
      () => trackerChanges.mirrorClosedText({ tracker: "jira", mirroredKey: "MOB-7", key: REQUEST.key, state: REQUEST.state }),
    ],
  },
  "messages.ts flipNoticeText": { renders: [() => messages.flipNoticeText(REQUEST.key)] },
  "contract-routing.ts updateText": {
    renders: [
      () => contractRouting.updateText(SECTION, REPORT, { key: REQUEST.key, state: "in_progress", before: 2 }, { kind: "revised", revision: 3 }),
      () => contractRouting.updateText(SECTION, REPORT, { key: REQUEST.key, state: "open", before: 1 }, { kind: "gone", revision: 3, withdrawn: true }),
      () => contractRouting.updateText(SECTION, REPORT, { key: REQUEST.key, state: "claimed", before: 1 }, { kind: "gone", revision: 3, withdrawn: false }),
      () => contractRouting.updateText(SECTION, REPORT, { key: REQUEST.key, state: "done", before: 1 }, { kind: "notice", revision: 2 }),
    ],
  },
  "contract-routing.ts titleOf": { renders: [() => contractRouting.titleOf(SECTION)] },
  "contract-routing.ts packetOf": { renders: [() => JSON.stringify(contractRouting.packetOf(SECTION, REQUEST.targetTeam))] },
  "provider-pull-requests.ts closeText": {
    renders: [
      ...[true, false].map((withdrawn) => () =>
        providerPullRequests.closeText("acme/payments#310", { requestId: REQUEST.proposalId, teamId: REQUEST.marker, key: REQUEST.key, state: withdrawn ? "open" : "claimed", withdrawnOnCloseAt: null, withdrawnWhenGoneAt: null }, withdrawn),
      ),
      () => providerPullRequests.closeText("acme/payments#310", { requestId: REQUEST.proposalId, teamId: REQUEST.marker, key: REQUEST.key, state: "done", withdrawnOnCloseAt: null, withdrawnWhenGoneAt: null }, false),
    ],
  },
  "api-consumers.ts reconfirmationText": {
    renders: [
      () => apiConsumers.reconfirmationText({ team: REQUEST.targetTeam, api: "payments-api", lastConfirmedAt: new Date("2026-07-20T09:00:00Z"), staleAt: null }),
      () => apiConsumers.reconfirmationText({ team: REQUEST.targetTeam, api: "payments-api", lastConfirmedAt: new Date("2026-07-20T09:00:00Z"), staleAt: new Date("2026-11-17T00:00:00Z") }),
    ],
  },
  "contract-warn-digests.ts warnDigestHeading": { renders: [() => warnDigests.warnDigestHeading(REQUEST.targetTeam, "2026-10-19")] },
  "github-issues.ts issueBody": {
    renders: [() => githubIssues.issueBody(mirrorTexts.mirrorSummary({ installUrl: INSTALL, key: REQUEST.key, targetTeam: REQUEST.targetTeam, requestingTeam: REQUEST.requestingTeam }), REQUEST.marker)],
  },
  "github-issues.ts markerLine": { renders: [() => githubIssues.markerLine(REQUEST.marker)] },
  "github-issues.ts commentMarkerLine": { renders: [() => githubIssues.commentMarkerLine(REQUEST.marker)] },
};

/** The builders of system messages: the third argument of every call to addSystemMessage must be a call of one of these. */
const SYSTEM_MESSAGE_BUILDERS = new Set(["mergedText", "mirrorClosedText", "flipNoticeText", "updateText", "closeText"]);

/** Where code outside the template modules may cast a value to an email's server text, and why. */
const SERVER_TEXT_CASTS: Record<string, string> = {
  "mirrors.ts": "reads back the state label it stored, which stateLabel wrote",
};

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** The template modules, whose every text-writing export the suite renders. */
const TEMPLATE_MODULES = ["email.ts", "mirror-texts.ts"];

/** Moves the clock, the time zone and Math.random, so that a rendering that reads any of them differs: Math.random gives `random`, below a half one time and above it the other. */
function elsewhere(at: string, zone: string, random: number): void {
  vi.setSystemTime(new Date(at));
  process.env["TZ"] = zone;
  vi.spyOn(Math, "random").mockReturnValue(random);
}

/** The two renderings of a builder's every form: the first now, the second a day and a half later, in another zone, with another Math.random. */
function renderTwice(renders: readonly (() => unknown)[]): { first: unknown[]; second: unknown[] } {
  elsewhere("2026-10-20T08:00:00Z", "UTC", 0.123);
  const first = renders.map((render) => render());
  vi.restoreAllMocks();
  elsewhere("2026-10-21T20:30:00Z", "Pacific/Kiritimati", 0.987);
  const second = renders.map((render) => render());
  vi.restoreAllMocks();
  return { first, second };
}

const zone = process.env["TZ"];

describe("every template, rendered twice from FE-142 unchanged", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterAll(() => {
    vi.useRealTimers();
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  const all: [string, Case][] = [
    ...Object.entries(EMAIL).map(([name, entry]): [string, Case] => [`email.ts ${name}`, entry]),
    ...Object.entries(MIRROR).map(([name, entry]): [string, Case] => [`mirror-texts.ts ${name}`, entry]),
    ...Object.entries(NOTICES).map(([name, entry]): [string, Case] => [`notices.ts ${name}`, entry]),
    ...Object.entries(OTHERS),
  ];

  it.each(all)("%s writes the same text both times", (_, { renders }) => {
    const { first, second } = renderTwice(renders);
    for (const text of first) expect(typeof text === "string" && text.length > 0).toBe(true);
    expect(second).toEqual(first);
  });

  it("renders every text-writing export of the template modules", () => {
    const exported = (module: Record<string, unknown>) => Object.keys(module).sort();
    expect(exported(email)).toEqual([...Object.keys(EMAIL), ...Object.keys(EMAIL_NOT_TEXT)].sort());
    expect(exported(mirrorTexts)).toEqual(Object.keys(MIRROR).sort());
    expect(exported(notices)).toEqual([...Object.keys(NOTICES), ...Object.keys(NOTICES_NOT_TEXT)].sort());
  });

  it("finds every system message made by a builder it renders, and no text cast to server text outside the template modules", () => {
    const problems: string[] = [];
    for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts")).sort()) {
      const text = readFileSync(join(SRC, file), "utf8");
      for (const call of callsOf(text, "addSystemMessage(")) {
        if (/^export async function addSystemMessage\(/m.test(call.line)) continue;
        const body = call.args[2] ?? "";
        const builder = /^([A-Za-z]\w*)\(/.exec(body)?.[1];
        if (builder === undefined || !SYSTEM_MESSAGE_BUILDERS.has(builder)) problems.push(`${file}: a system message whose body is not a call of a builder the suite renders: ${body.slice(0, 80)}`);
      }
      if (!TEMPLATE_MODULES.includes(file) && /as ServerText/.test(text) && !Object.hasOwn(SERVER_TEXT_CASTS, file)) problems.push(`${file}: casts a value to server text outside the template modules`);
    }
    expect(problems).toEqual([]);
    // Each builder named here is one the suite renders.
    for (const builder of SYSTEM_MESSAGE_BUILDERS) expect(Object.keys(OTHERS).some((name) => name.endsWith(` ${builder}`))).toBe(true);
  });
});

/** The calls of a function in a source text, from the opening "name(" to the parenthesis that closes it, each with its arguments at the top level. */
function callsOf(text: string, opening: string): { line: string; args: string[] }[] {
  const calls: { line: string; args: string[] }[] = [];
  for (let at = text.indexOf(opening); at !== -1; at = text.indexOf(opening, at + opening.length)) {
    const lineStart = text.lastIndexOf("\n", at) + 1;
    const line = text.slice(lineStart, text.indexOf("\n", at));
    const args: string[] = [];
    let depth = 0;
    let current = "";
    let quote: string | undefined;
    for (let i = at + opening.length; i < text.length; i++) {
      const char = text[i] ?? "";
      if (quote !== undefined) {
        current += char;
        if (char === "\\") {
          current += text[i + 1] ?? "";
          i++;
        } else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        current += char;
      } else if ("([{".includes(char)) {
        depth++;
        current += char;
      } else if (")]}".includes(char)) {
        if (depth === 0) {
          args.push(current.trim());
          break;
        }
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        args.push(current.trim());
        current = "";
      } else current += char;
    }
    calls.push({ line, args });
  }
  return calls;
}

describe("the mirror of FE-142, synced again a day and a half later while the request does not change", () => {
  let install: TestInstall;
  let stub: GitHubStub;
  let app: GitHubAppAccess;
  let ayse: string;
  let alice: string;

  beforeAll(async () => {
    install = await startTestInstall();
    stub = await startGitHubStub();
    const provider = await providerOnStub(install, stub, ["ayse"], { repositories: ["acme/fe-intake"] });
    app = (await provider.github.app())!;
    const ada: WebSessionCaller = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: "6d1f1f54-6a8f-4f8e-9f0e-2b3f6c1d4e5a" };
    alice = await addUser(install.owner, { login: "alice" });
    ayse = await addUser(install.owner, { login: "ayse", githubAccountId: provider.account("ayse") });
    const be = await addTeam(install.owner, "BE");
    const fe = await addTeam(install.owner, "FE");
    await joinTeams(install.owner, alice, be);
    await joinTeams(install.owner, ayse, fe);
    await install.execute("mirrors.map_repository", ada, { teamId: fe, repository: "acme/fe-intake" });
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await stub?.close();
    await install?.close();
  });

  const sync = (requestId: string) =>
    syncMirror({ database: install.db, adapters: { github: createGitHubIssues({ app, database: install.db }) }, installUrl: URL_OF_INSTALL, logger: install.logger }, requestId);

  it("writes nothing new: the issue's title, summary and label render the same", async () => {
    const request = await openRequestInTheWebUi<{ key: string; id: string }>(install, alice, { targetTeam: "FE", title: REQUEST.title });
    await install.execute("requests.claim", sessionOf(ayse), { key: request.key });
    await install.execute("requests.set_status", sessionOf(ayse), { key: request.key, state: "in_progress" });
    await sync(request.id);
    const { rows } = await install.owner.query<{ issue: string }>("SELECT issue FROM mirrors WHERE request_id = $1", [request.id]);
    const number = Number(rows[0]?.issue);
    const before = stub.issue("acme/fe-intake", number);
    const shown = { title: before.title, body: before.body, labels: [...before.labels], comments: before.comments.length };
    const writes = () => stub.received.filter(({ host, method, path }) => host === "api" && method !== "GET" && path.startsWith("/repos/acme/fe-intake/issues")).length;
    const written = writes();

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 36 * 60 * 60_000 });
    await sync(request.id);

    expect(writes()).toBe(written);
    const after = stub.issue("acme/fe-intake", number);
    expect({ title: after.title, body: after.body, labels: [...after.labels], comments: after.comments.length }).toEqual(shown);
  });
});
