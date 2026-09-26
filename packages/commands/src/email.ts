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
