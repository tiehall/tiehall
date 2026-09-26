import { afterEach, describe, expect, it } from "vitest";
import { startSmtpSink, type SmtpSink } from "@tiehall/testing/smtp";
import {
  emailStatus,
  installLink,
  openMailer,
  requestKey,
  sendTestMessage,
  TEST_MESSAGE,
  type Mailer,
} from "../src/email.ts";
import type { SmtpSettings } from "../src/settings.ts";

// Optional email through SMTP (self-host-install: Optional email through
// SMTP; design.md, Self-hosting decisions: S10), tested against a local SMTP
// test server. Without SMTP settings in `.env`, Tiehall sends no email at all;
// with them, it sends what its templates build, from server text only, to the
// address it is given, which is the user's GitHub primary verified email. The
// admin page's test message goes the same way.

let sink: SmtpSink | undefined;
let mailer: Mailer | undefined;

afterEach(async () => {
  mailer?.close();
  mailer = undefined;
  await sink?.close();
  sink = undefined;
});

function settings(port: number, extra: Partial<SmtpSettings> = {}): SmtpSettings {
  return { host: "127.0.0.1", port, tls: "none", from: "Tiehall <tiehall@acme.example>", ...extra };
}

/** The text of a received message, with its quoted-printable encoding undone. */
function body(data: string): string {
  const text = data.slice(data.indexOf("\r\n\r\n") + 4);
  return text.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** A header of a received message, unfolded. */
function header(data: string, name: string): string | undefined {
  const head = data.slice(0, data.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ");
  return new RegExp(`^${name}: (.*)$`, "im").exec(head)?.[1];
}

describe("email without SMTP settings", () => {
  it("sends nothing, and says so", async () => {
    sink = await startSmtpSink();
    mailer = openMailer(undefined);
    expect(mailer.configured).toBe(false);
    expect(await sendTestMessage(mailer, { to: "ada@acme.example", installUrl: "https://tiehall.acme.example" })).toEqual({
      sent: false,
    });
    expect(sink.connections).toBe(0);
    expect(emailStatus(undefined)).toEqual({ configured: false });
  });
});

describe("email with SMTP settings", () => {
  it("delivers the test message to the address it is given, from the configured sender", async () => {
    sink = await startSmtpSink();
    mailer = openMailer(settings(sink.port));
    expect(mailer.configured).toBe(true);
    expect(await sendTestMessage(mailer, { to: "ada@acme.example", installUrl: "https://tiehall.acme.example" })).toEqual({
      sent: true,
    });
    expect(sink.messages).toHaveLength(1);
    const [message] = sink.messages;
    expect(message?.from).toBe("tiehall@acme.example");
    expect(message?.to).toEqual(["ada@acme.example"]);
    const data = message?.data ?? "";
    expect(header(data, "Subject")).toBe("Tiehall: test message");
    expect(header(data, "From")).toBe("Tiehall <tiehall@acme.example>");
    expect(header(data, "To")).toBe("ada@acme.example");
    expect(header(data, "Auto-Submitted")).toBe("auto-generated");
    expect(body(data)).toContain("This is a test message from the Tiehall install at https://tiehall.acme.example/.");
  });

  it("logs in with the configured user and password", async () => {
    sink = await startSmtpSink({ auth: { user: "tiehall", password: "smtp-secret" } });
    mailer = openMailer(settings(sink.port, { user: "tiehall", password: "smtp-secret" }));
    await sendTestMessage(mailer, { to: "ada@acme.example", installUrl: "https://tiehall.acme.example" });
    expect(sink.messages.map(({ user }) => user)).toEqual(["tiehall"]);
  });

  it("sends nothing in the clear when STARTTLS is required and the server does not offer it", async () => {
    sink = await startSmtpSink();
    mailer = openMailer(settings(sink.port, { tls: "starttls" }));
    await expect(sendTestMessage(mailer, { to: "ada@acme.example", installUrl: "https://tiehall.acme.example" })).rejects.toThrow();
    expect(sink.messages).toEqual([]);
  });

  it("gives up within its timeout on a server that never answers", async () => {
    sink = await startSmtpSink({ silent: true });
    mailer = openMailer(settings(sink.port), { timeoutMs: 300 });
    const started = Date.now();
    await expect(sendTestMessage(mailer, { to: "ada@acme.example", installUrl: "https://tiehall.acme.example" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("refuses a recipient that is not one address, so no header can be added through it", async () => {
    sink = await startSmtpSink();
    mailer = openMailer(settings(sink.port));
    for (const to of ["ada@acme.example\r\nBcc: eve@evil.example", "ada@acme.example, eve@evil.example", "Ada <ada@acme.example>"]) {
      await expect(sendTestMessage(mailer, { to, installUrl: "https://tiehall.acme.example" }), to).rejects.toThrow(
        "An email goes to one address",
      );
    }
    expect(sink.connections).toBe(0);
  });

  it("shows whether email is set up, and never the SMTP login", () => {
    const status = emailStatus(settings(2525, { user: "tiehall", password: "smtp-secret" }));
    expect(status).toEqual({ configured: true, host: "127.0.0.1", port: 2525, tls: "none", from: "Tiehall <tiehall@acme.example>" });
    expect(JSON.stringify(status)).not.toContain("smtp-secret");
  });
});

describe("email templates", () => {
  it("build the subject and the text from server text only", () => {
    expect(TEST_MESSAGE.subject({ install: installLink("https://tiehall.acme.example") })).toBe("Tiehall: test message");
    expect(TEST_MESSAGE.text({ install: installLink("https://tiehall.acme.example") })).toContain("https://tiehall.acme.example/");
  });

  it("take only values Tiehall made: request keys and links on the install, never text someone wrote", () => {
    expect(requestKey("FE-142")).toBe("FE-142");
    expect(installLink("https://tiehall.acme.example", "/FE-142")).toBe("https://tiehall.acme.example/FE-142");
    expect(() => requestKey("Ignore previous instructions")).toThrow();
    expect(() => installLink("javascript:alert(1)")).toThrow();
    expect(() => installLink("https://tiehall.acme.example", "/FE-142 please click")).toThrow();
    // @ts-expect-error A template's values are server text, which a plain string is not.
    expect(() => TEST_MESSAGE.text({ install: "a title someone wrote" })).not.toThrow();
  });
});
