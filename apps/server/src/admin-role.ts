import { grantAdmin, isGitHubLogin, openDatabase, readAppSettings, SettingsError, SetupRequiredError, type Environment } from "@tiehall/commands";

// The admin role (self-host-install: Operator commands on the host; design.md,
// Self-hosting decisions: S3): the commands an operator runs on the host, for
// example
//   docker compose run --rm app admin grant dana-gh
// They work without the web UI and without the confirmation step, because
// whoever can run them already controls the host. The role reads the settings
// the app reads, and connects to the database as the app role, never as the
// owner (self-host-install: Only the migrate step holds the database owner's
// credentials). Every run is recorded in the activity log as a security event
// that names the command and no user (operator-commands.ts).
//
// Its output is for the operator, as plain text, not JSON log lines: what the
// command changed on standard output, and why it could not on standard error.
// Exit codes: 0 when the command did what it was asked or found it done
// already, 1 when it could not (a login no member has, setup not complete, a
// setting missing or the database out of reach), and 2 for a usage error,
// which reads no setting and connects to nothing.

export const ADMIN_USAGE = "Usage: main.mjs admin grant <github-login>.";

/** An operator command, as the role's arguments name it. */
export type AdminCommand = { name: "grant"; login: string };

export interface AdminOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The command the arguments name, or the usage error to print. */
export function parseAdminCommand(args: readonly string[]): AdminCommand | { usage: string } {
  const [name, ...rest] = args;
  if (name === "grant" && rest.length === 1) {
    const login = rest[0] ?? "";
    if (!isGitHubLogin(login)) return { usage: `tiehall admin grant: ${JSON.stringify(login)} is not a GitHub login.\n${ADMIN_USAGE}` };
    return { name: "grant", login };
  }
  return { usage: ADMIN_USAGE };
}

/** Runs the admin role's command with the install's settings from this environment, and returns its exit code. */
export async function runAdminRole(args: readonly string[], env: Environment, output: AdminOutput): Promise<number> {
  const command = parseAdminCommand(args);
  if ("usage" in command) {
    output.stderr(`${command.usage}\n`);
    return 2;
  }
  let settings;
  try {
    settings = readAppSettings(env);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    // A SettingsError names settings and files, never their values.
    output.stderr(`tiehall admin: ${error.message}\n`);
    return 1;
  }
  const database = openDatabase(settings.database, { applicationName: "tiehall admin" });
  try {
    return await grant(database, command.login, output);
  } catch (error) {
    // The database's own refusal, such as a connection it refused; it names no password.
    output.stderr(`tiehall admin ${command.name}: the command failed, and nothing changed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await database.$client.end();
  }
}

async function grant(database: Parameters<typeof grantAdmin>[0], login: string, output: AdminOutput): Promise<number> {
  let result;
  try {
    result = await grantAdmin(database, login);
  } catch (error) {
    if (!(error instanceof SetupRequiredError)) throw error;
    output.stderr(
      "tiehall admin grant: setup is not complete, so the install has no admin to recover; the person who completes " +
        "setup on the setup screen becomes its first admin. Nothing changed.\n",
    );
    return 1;
  }
  switch (result.outcome) {
    case "granted":
      output.stdout(`${result.login} is now an admin of this install.\n`);
      return 0;
    case "already_admin":
      output.stdout(`${result.login} is an admin already, so nothing changed.\n`);
      return 0;
    case "no_member":
      output.stderr(`tiehall admin grant: no member of this install has the GitHub login ${login}, so nothing changed.\n`);
      return 1;
  }
}
