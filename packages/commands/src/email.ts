import { createTransport } from "nodemailer";
import type { SmtpSettings, SmtpTls } from "./settings.ts";

// Optional email through SMTP (self-host-install: Optional email through
// SMTP; design.md, Self-hosting decisions: S10). With SMTP settings in `.env`,
// Tiehall sends the emails the other capabilities name, each to one user's
// GitHub primary verified email, which the caller looks up; without them it
// sends none, and its notices stay in the web inbox and the admin banners.
//
// Every email comes from a template, whose subject and text are built only
// from server text: Tiehall's own words and values Tiehall made, such as a
// request key or a link on the install. A template's values are typed as
// ServerText, which only the functions below make, each from a value it checks,
// so a title, a message, a packet or anything else a person or an agent wrote
// can never reach a subject or a body. Emails are plain text, marked as
// automatic, and read no file and no URL.

declare const serverText: unique symbol;

/** Text Tiehall made itself, which a template may carry. */
export type ServerText = string & { readonly [serverText]: true };

export type TemplateValues = Readonly<Record<string, ServerText>>;

export interface EmailTemplate<V extends TemplateValues> {
  /** The template's id, which a log line names instead of the email. */
  readonly id: string;
  subject(values: V): string;
  text(values: V): string;
}

/** A team's key and a request's number, such as FE-142 (design.md, Self-hosting decisions: S15). */
export function requestKey(key: string): ServerText {
  if (!/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/.test(key)) throw new TypeError("A request key is a team key and a number, such as FE-142.");
  return key as ServerText;
}

/** A link on the install: its base URL and a path of Tiehall's own. */
export function installLink(installUrl: string, path = "/"): ServerText {
  let url: URL;
  try {
    url = new URL(path, installUrl);
  } catch {
    throw new TypeError("An install link is the install's URL and a path on it.");
  }
  const base = new URL(installUrl);
  if (!/^https?:$/.test(base.protocol) || url.origin !== base.origin || !/^\/[A-Za-z0-9._~\/-]*$/.test(path)) {
    throw new TypeError("An install link is the install's URL and a path on it.");
  }
  return url.toString() as ServerText;
}

/** A time Tiehall recorded, such as when a proposal expires, written in UTC. */
export function serverTime(time: Date): ServerText {
  if (Number.isNaN(time.getTime())) throw new TypeError("A server time is a valid time.");
  return time.toISOString() as ServerText;
}

/** What each kind of commitment proposes to do to its request, in Tiehall's words. */
const COMMITMENT_PHRASES: Readonly<Record<string, string>> = {
  due_date: "change its due date",
  scope: "change its scope",
  decline: "decline it",
  reassign: "reassign it to another team",
  withdraw: "withdraw it",
  done: "mark it done",
};

/** What a kind of commitment proposes, in Tiehall's words. */
export function commitmentPhrase(kind: string): ServerText {
  const phrase = Object.hasOwn(COMMITMENT_PHRASES, kind) ? COMMITMENT_PHRASES[kind] : undefined;
  if (phrase === undefined) throw new TypeError("A commitment is one of the kinds of commitment.");
  return phrase as ServerText;
}

/**
 * The email that a proposal waits for its reader's confirmation (requests:
 * Where a proposal waits): which request, what it proposes, when it expires,
 * and the proposal's confirm page, where its reader confirms or rejects it.
 */
export const PROPOSAL_NOTICE: EmailTemplate<{ key: ServerText; what: ServerText; expiresAt: ServerText; page: ServerText }> = {
  id: "email.proposal_notice",
  subject: ({ key }) => `Tiehall: a proposal on ${key} waits for your confirmation`,
  text: ({ key, what, expiresAt, page }) =>
    [
      `A proposal on ${key} to ${what} waits for your confirmation in Tiehall.`,
      "",
      `It expires at ${expiresAt}, unless every confirmation it needs has come by then.`,
      "",
      `Review it, then confirm or reject it on its page: ${page}`,
      "It is also listed in the standing list of your web inbox.",
      "",
    ].join("\n"),
};

/** A calendar day, such as a due date, written as YYYY-MM-DD. */
function calendarDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError("A calendar day is written as YYYY-MM-DD.");
  return day;
}

/** A team's key, such as FE. */
function teamKeyText(key: string): string {
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new TypeError("A team key is 2 to 10 capital letters and digits, such as FE.");
  return key;
}

/** What a receipt is about: the kind of receipt, the commitment, its request, and where its proposal is now. */
export interface ReceiptFacts {
  kind: "waits_for_other_side" | "took_effect" | "undone";
  /** For an undo, the login of the person who undid it. */
  undoneBy?: string | undefined;
  /** For an undo, whether the person who undid it is a bot user, whom the sentence then marks as one (teams-and-roles: Bot users). */
  undoneByBot?: boolean | undefined;
  commitment: string;
  /** The request's key now. */
  key: string;
  /** For a due-date commitment, the due date it sets, or null when it removes it. */
  dueDate?: string | null | undefined;
  /** For a reassignment, the key of the team it moves the request to. */
  team?: string | undefined;
  /** Where the proposal is now: pending, applied, or how it ended. */
  state: string;
}

/**
 * A receipt's sentence, in Tiehall's words (requests: Receipts): what the
 * person confirmed, and, for a receipt that says the commitment waits for the
 * other side, how that ended once it has.
 */
export function receiptSentence(facts: ReceiptFacts): ServerText {
  const key = requestKey(facts.key);
  const dueDate = facts.dueDate === undefined || facts.dueDate === null ? facts.dueDate : calendarDay(facts.dueDate);
  if (facts.kind === "undone") {
    const undoneBy = facts.undoneBy ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(undoneBy)) throw new TypeError("A receipt names a user by their GitHub login.");
    const login = facts.undoneByBot === true ? `${undoneBy} (a bot user)` : undoneBy;
    switch (facts.commitment) {
      case "decline":
        return `The decline of ${key} was undone by ${login}.` as ServerText;
      case "reassign":
        return `The reassignment of ${key} to team ${teamKeyText(facts.team ?? "")} was undone by ${login}.` as ServerText;
      case "due_date":
        return (dueDate === null || dueDate === undefined
          ? `The removal of the due date of ${key} was undone by ${login}.`
          : `The due date ${dueDate} of ${key} was undone by ${login}.`) as ServerText;
      case "scope":
        return `The change of the scope of ${key} was undone by ${login}.` as ServerText;
      default:
        throw new TypeError("Only a due date, a scope change, a reassignment and a decline can be undone.");
    }
  }
  if (facts.kind === "took_effect") {
    switch (facts.commitment) {
      case "decline":
        return `${key} was declined, with your confirmation.` as ServerText;
      case "withdraw":
        return `${key} was withdrawn, with your confirmation.` as ServerText;
      case "done":
        return `${key} was marked done, with your confirmation.` as ServerText;
      case "reassign":
        return `${key} was reassigned to team ${teamKeyText(facts.team ?? "")}, with your confirmation.` as ServerText;
      case "due_date":
        return (dueDate === null || dueDate === undefined
          ? `The due date of ${key} was removed, with your confirmation.`
          : `The due date of ${key} was set to ${dueDate}, with your confirmation.`) as ServerText;
      case "scope":
        return `A change of the scope of ${key} took effect as the next revision of its packet, with your confirmation.` as ServerText;
      default:
        throw new TypeError("A receipt's commitment is one of the kinds of commitment.");
    }
  }
  const confirmed =
    facts.commitment === "due_date"
      ? dueDate === null || dueDate === undefined
        ? `removing the due date of ${key}`
        : `setting the due date of ${key} to ${dueDate}`
      : facts.commitment === "scope"
        ? `changing the scope of ${key}`
        : undefined;
  if (confirmed === undefined) throw new TypeError("Only a due date or a scope change waits for the other side.");
  const ending: Readonly<Record<string, string>> = {
    pending: "",
    applied: " The other side confirmed it too.",
    expired: " It expired before the other side confirmed it, so it did not take effect.",
    rejected: " It was rejected, so it did not take effect.",
    withdrawn: " It was withdrawn, so it did not take effect.",
    cancelled: " It was cancelled, so it did not take effect.",
  };
  const how = Object.hasOwn(ending, facts.state) ? ending[facts.state] : undefined;
  if (how === undefined) throw new TypeError("A receipt's proposal is pending, applied or ended.");
  return `You confirmed ${confirmed}; it waits for a confirmation from the other side of the request.${how}` as ServerText;
}

/** The email of a receipt (requests: Receipts): its sentence, in Tiehall's words. */
export const RECEIPT: EmailTemplate<{ key: ServerText; sentence: ServerText }> = {
  id: "email.receipt",
  subject: ({ key }) => `Tiehall: receipt for your confirmation on ${key}`,
  text: ({ sentence }) => [sentence, "", "It is also listed in the standing list of your web inbox.", ""].join("\n"),
};

/**
 * The email of a receipt that says a reversible commitment took effect, with
 * its undo page (requests: The undo window for reversible commitments).
 */
export const RECEIPT_WITH_UNDO: EmailTemplate<{ key: ServerText; sentence: ServerText; until: ServerText; page: ServerText }> = {
  id: "email.receipt_with_undo",
  subject: RECEIPT.subject,
  text: ({ sentence, until, page }) =>
    [sentence, "", `You can undo it until ${until} on its undo page: ${page}`, "It is also listed in the standing list of your web inbox.", ""].join("\n"),
};

/** The test message an admin sends from the admin page. */
export const TEST_MESSAGE: EmailTemplate<{ install: ServerText }> = {
  id: "email.test_message",
  subject: () => "Tiehall: test message",
  text: ({ install }) =>
    [
      `This is a test message from the Tiehall install at ${install}.`,
      "",
      "Email is set up: Tiehall sends its notices, receipts and digests through this SMTP server.",
      "",
    ].join("\n"),
};

export interface Mailer {
  /** Whether `.env` holds SMTP settings; without them Tiehall sends no email. */
  readonly configured: boolean;
  /**
   * Sends one email built from a template to one address, or nothing when
   * email is not set up, and says which. A refusal by the SMTP server throws.
   */
  send<V extends TemplateValues>(to: string, template: EmailTemplate<V>, values: V): Promise<{ sent: boolean }>;
  close(): void;
}

export interface MailerOptions {
  /** How long connecting, the server's greeting and each step may take. */
  timeoutMs?: number;
}

/** Long enough for a slow relay, short enough that a job does not hang on a dead one. */
export const SMTP_TIMEOUT_MS = 30_000;

/** One address, with no display name, so nothing but the address reaches the To header. */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

export function openMailer(smtp: SmtpSettings | undefined, options: MailerOptions = {}): Mailer {
  if (smtp === undefined) {
    return {
      configured: false,
      async send(to) {
        checkAddress(to);
        return { sent: false };
      },
      close() {},
    };
  }
  const timeoutMs = options.timeoutMs ?? SMTP_TIMEOUT_MS;
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    ...tlsOptions(smtp.tls),
    ...(smtp.user === undefined || smtp.password === undefined ? {} : { auth: { user: smtp.user, pass: smtp.password } }),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    // A template never names a file or a URL for the mail to read.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    configured: true,
    async send(to, template, values) {
      checkAddress(to);
      await transport.sendMail({
        from: smtp.from,
        to,
        subject: template.subject(values),
        text: template.text(values),
        // An automatic message, which mail systems answer with no out-of-office reply (RFC 3834).
        headers: { "Auto-Submitted": "auto-generated" },
      });
      return { sent: true };
    },
    close() {
      transport.close();
    },
  };
}

function tlsOptions(tls: SmtpTls): { secure: boolean; requireTLS?: boolean; ignoreTLS?: boolean } {
  switch (tls) {
    case "tls":
      return { secure: true };
    case "starttls":
      return { secure: false, requireTLS: true };
    case "none":
      return { secure: false, ignoreTLS: true };
  }
}

function checkAddress(to: string): void {
  if (!ADDRESS.test(to)) throw new TypeError("An email goes to one address, such as ada@example.com.");
}

/** What the admin page shows about email: whether it is set up and where it goes, never the login. */
export type EmailStatus =
  | { configured: false }
  | { configured: true; host: string; port: number; tls: SmtpTls; from: string };

export function emailStatus(smtp: SmtpSettings | undefined): EmailStatus {
  if (smtp === undefined) return { configured: false };
  return { configured: true, host: smtp.host, port: smtp.port, tls: smtp.tls, from: smtp.from };
}

/**
 * Sends the admin page's test message to the admin's address, or nothing
 * when email is not set up (self-host-install: Optional email through SMTP).
 */
export function sendTestMessage(mailer: Mailer, message: { to: string; installUrl: string }): Promise<{ sent: boolean }> {
  return mailer.send(message.to, TEST_MESSAGE, { install: installLink(message.installUrl) });
}
