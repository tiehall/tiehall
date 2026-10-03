import { createServer, type Server, type Socket } from "node:net";

// A local SMTP test server (design.md, Technical decisions: T17): it listens
// on 127.0.0.1 unless told otherwise, speaks enough SMTP for a mail client to deliver to it (EHLO,
// optional AUTH PLAIN and AUTH LOGIN, MAIL, RCPT, DATA, RSET, NOOP, QUIT), and
// keeps every message it receives, so tests read what Tiehall sent. It offers
// no STARTTLS, so a client that requires TLS refuses to send to it.

export interface ReceivedMessage {
  /** The envelope sender, from MAIL FROM. */
  from: string;
  /** The envelope recipients, from RCPT TO. */
  to: string[];
  /** The message as sent, headers and body, with the transparency dots removed. */
  data: string;
  /** The user the client logged in as, when it did. */
  user?: string;
}

export interface SmtpSink {
  readonly port: number;
  readonly messages: readonly ReceivedMessage[];
  /** How many connections clients opened. */
  readonly connections: number;
  close(): Promise<void>;
}

export interface SmtpSinkOptions {
  /** Require a login with this user and password before MAIL. */
  auth?: { user: string; password: string };
  /** Accept connections and never answer, as a hung server does. */
  silent?: boolean;
  /**
   * The address it listens on: 127.0.0.1 unless given, such as 0.0.0.0 for an
   * install whose containers reach it through the host's gateway.
   */
  listenHost?: string;
}

export async function startSmtpSink(options: SmtpSinkOptions = {}): Promise<SmtpSink> {
  const messages: ReceivedMessage[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (options.silent) return;
    converse(socket, options, messages);
  });
  await new Promise<void>((resolve) => server.listen(0, options.listenHost ?? "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    messages,
    get connections() {
      return connections;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function converse(socket: Socket, options: SmtpSinkOptions, messages: ReceivedMessage[]): void {
  const reply = (line: string) => socket.write(`${line}\r\n`);
  let buffer = "";
  let from: string | undefined;
  let to: string[] = [];
  let user: string | undefined;
  /** What the next lines are: commands, the message's data, or a step of AUTH LOGIN. */
  let mode: "command" | "data" | "login-user" | "login-password" = "command";
  let loginUser = "";
  let data: string[] = [];

  const loggedIn = (name: string, password: string) => {
    if (options.auth !== undefined && (name !== options.auth.user || password !== options.auth.password)) {
      reply("535 5.7.8 Authentication credentials invalid");
      return;
    }
    user = name;
    reply("235 2.7.0 Authentication successful");
  };

  const command = (line: string) => {
    const [verb = "", ...rest] = line.split(" ");
    const argument = rest.join(" ");
    switch (verb.toUpperCase()) {
      case "EHLO":
        socket.write("250-sink.test\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 AUTH PLAIN LOGIN\r\n");
        return;
      case "HELO":
        return reply("250 sink.test");
      case "AUTH": {
        const [mechanism = "", initial] = argument.split(" ");
        if (mechanism.toUpperCase() === "PLAIN" && initial !== undefined) {
          const [, name = "", password = ""] = Buffer.from(initial, "base64").toString("utf8").split("\0");
          return loggedIn(name, password);
        }
        if (mechanism.toUpperCase() === "LOGIN") {
          mode = "login-user";
          return reply(`334 ${Buffer.from("Username:").toString("base64")}`);
        }
        return reply("504 5.5.4 Unrecognized authentication type");
      }
      case "MAIL":
        if (options.auth !== undefined && user === undefined) return reply("530 5.7.0 Authentication required");
        from = /<([^>]*)>/.exec(argument)?.[1] ?? "";
        to = [];
        return reply("250 2.1.0 OK");
      case "RCPT":
        to.push(/<([^>]*)>/.exec(argument)?.[1] ?? "");
        return reply("250 2.1.5 OK");
      case "DATA":
        if (from === undefined || to.length === 0) return reply("503 5.5.1 Bad sequence of commands");
        mode = "data";
        data = [];
        return reply("354 End data with <CR><LF>.<CR><LF>");
      case "RSET":
        from = undefined;
        to = [];
        return reply("250 2.0.0 OK");
      case "NOOP":
        return reply("250 2.0.0 OK");
      case "QUIT":
        reply("221 2.0.0 Bye");
        socket.end();
        return;
      default:
        return reply("502 5.5.2 Command not implemented");
    }
  };

  const line = (text: string) => {
    switch (mode) {
      case "data":
        if (text === ".") {
          messages.push({ from: from ?? "", to, data: data.join("\r\n"), ...(user === undefined ? {} : { user }) });
          from = undefined;
          to = [];
          mode = "command";
          return reply("250 2.0.0 Queued");
        }
        data.push(text.startsWith(".") ? text.slice(1) : text);
        return;
      case "login-user":
        loginUser = Buffer.from(text, "base64").toString("utf8");
        mode = "login-password";
        return reply(`334 ${Buffer.from("Password:").toString("base64")}`);
      case "login-password":
        mode = "command";
        return loggedIn(loginUser, Buffer.from(text, "base64").toString("utf8"));
      case "command":
        return command(text);
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\r\n");
    while (end !== -1) {
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\r\n");
    }
  });
  reply("220 sink.test ESMTP");
}
