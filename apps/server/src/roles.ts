// The image has one entrypoint and these roles (design.md, Technical decisions: T1):
// - web serves the UI, /api/v1, /mcp, the OAuth server and webhooks;
// - worker runs the job handlers and crons;
// - migrate runs the migrations once and exits, before each roll;
// - all runs web and worker together, for self-hosting and the CI boot test;
// - init prints a complete `.env` with fresh secrets (self-host-install: `init` prints a complete `.env`);
// - admin runs the operator commands on the host, such as `admin grant <github-login>`
//   (self-host-install: Operator commands on the host).

export const ROLES = ["web", "worker", "migrate", "all", "init", "admin"] as const;

export type Role = (typeof ROLES)[number];

export function parseRole(argument: string | undefined): Role | undefined {
  return ROLES.find((role) => role === argument);
}

export function usage(argument: string | undefined): string {
  const problem = argument === undefined ? "No role given." : `Unknown role "${argument}".`;
  return `${problem} Usage: main.mjs <role>, where role is web, worker, migrate, all, init or admin.`;
}
