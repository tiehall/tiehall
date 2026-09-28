import { connectGitHubInstallation, disconnectGitHubInstallation, listGitHubInstallations } from "@tiehall/catalog";
import { githubInstallationConnected, githubInstallationDisconnected, Refusal } from "@tiehall/core";
import { githubConnectedInstallations, githubInstallations } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { connectInstallations, coveredRepositories, knownInstallations, syncGitHubInstallations } from "./github-installations.ts";
import type { OrgContext } from "./with-org.ts";

// Connecting and disconnecting the App's installations (tracker-mirrors:
// Admins connect GitHub installations with the confirmation step;
// tracker-mirrors: Covered repositories follow each connected installation;
// activity-log: Which actions are security events; github-app-reachability:
// design.md, Design rules: Finding installations). The admin page lists every
// installation Tiehall found by listing the App's installations, with the
// repositories the connected ones cover. An admin connects one with the
// confirmation step: the connection and its security event commit together,
// with a job that reads the installation's repositories at once, so they
// count as covered with no delivery. An admin disconnects one without the
// confirmation step, because that only narrows what Tiehall acts on: the
// repositories it covered stop counting, its security event is recorded, and
// no member is removed, whoever joined through its organization.

/** An installation Tiehall knows, by its id, with its row locked until the call's transaction ends; 404 when none. */
async function installationRecord({ tx, orgId }: OrgContext, id: string, lock: boolean) {
  const query = tx
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      repositorySelection: githubInstallations.repositorySelection,
      suspendedAt: githubInstallations.suspendedAt,
      deletedAt: githubInstallations.deletedAt,
      connectedAt: githubConnectedInstallations.connectedAt,
    })
    .from(githubInstallations)
    .leftJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubInstallations.orgId), eq(githubConnectedInstallations.installationId, githubInstallations.id)),
    )
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.id, id)));
  const [row] = lock ? await query.for("update", { of: githubInstallations }) : await query;
  if (row === undefined) throw new Refusal("record-not-found", "The install's GitHub App has no such installation.");
  return row;
}

export const GITHUB_INSTALLATION_HANDLERS: Handlers = {
  [listGitHubInstallations.id]: defineHandler(listGitHubInstallations, async (_input, context) => {
    const covered = await coveredRepositories(context);
    return {
      installations: (await knownInstallations(context)).map((installation) => ({
        id: installation.id,
        installationId: installation.installationId,
        account: installation.account.login,
        accountType: installation.account.type,
        repositorySelection: installation.repositorySelection,
        suspended: installation.suspended,
        deleted: installation.deleted,
        connected: installation.connected,
        repositories: covered.filter(({ installationId }) => installationId === installation.id).map(({ fullName }) => fullName),
      })),
    };
  }),

  [connectGitHubInstallation.id]: defineHandler(connectGitHubInstallation, async ({ installation }, context) => {
    const record = await installationRecord(context, installation, true);
    if (record.connectedAt !== null) return { installation, connected: true as const };
    if (record.deletedAt !== null) throw new Refusal("conflict", "That installation was deleted on GitHub, so it cannot be connected.");
    return context.write(async (writer) => {
      await connectInstallations(writer, [installation]);
      await writer.record(githubInstallationConnected, { installationId: installation });
      // Its repositories are read at once, with its own token, so they count as covered with no delivery.
      await writer.enqueue(syncGitHubInstallations.type, { repositoriesOf: [record.installationId] });
      return { installation, connected: true as const };
    });
  }),

  [disconnectGitHubInstallation.id]: defineHandler(disconnectGitHubInstallation, async ({ installation }, context) => {
    const record = await installationRecord(context, installation, true);
    if (record.connectedAt === null) return { installation, connected: false as const };
    return context.write(async (writer) => {
      // The repositories it covered go with it: the foreign key cascades.
      await writer.tx
        .delete(githubConnectedInstallations)
        .where(and(eq(githubConnectedInstallations.orgId, writer.orgId), eq(githubConnectedInstallations.installationId, installation)));
      await writer.record(githubInstallationDisconnected, { installationId: installation });
      return { installation, connected: false as const };
    });
  }),
};

export const GITHUB_INSTALLATION_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [connectGitHubInstallation.id]: async (input, context) => {
    const { installation } = input as { installation: string };
    const record = await installationRecord(context, installation, false);
    const account =
      record.accountType === "Organization" ? `the GitHub organization ${record.accountLogin}` : `the personal GitHub account ${record.accountLogin}`;
    const lines =
      record.connectedAt !== null
        ? [{ text: `The installation on ${account} is connected already, so confirming changes nothing.` }]
        : record.deletedAt !== null
          ? [{ text: `The installation on ${account} was deleted on GitHub, so it cannot be connected.` }]
          : [
              { text: `Connect the install's GitHub App installation on ${account} (GitHub's installation ${record.installationId}).` },
              {
                text:
                  record.repositorySelection === "all"
                    ? `It covers every repository of ${record.accountLogin}.`
                    : `It covers the repositories of ${record.accountLogin} chosen on GitHub.`,
              },
              {
                text:
                  "Tiehall then acts on it: the repositories it covers count as covered, so their pull requests can link and close requests " +
                  "and mirror issues can be created in them" +
                  (record.accountType === "Organization" ? `, and members of ${record.accountLogin} can sign in, as the sign-in policy allows.` : "."),
              },
              ...(record.suspendedAt === null ? [] : [{ text: "GitHub reports it suspended: it covers no repository until it is unsuspended." }]),
            ];
    return { title: "Connect a GitHub installation", lines };
  },
};
