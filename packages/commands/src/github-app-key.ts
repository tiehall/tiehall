import { createPrivateKey } from "node:crypto";
import { uploadGitHubPrivateKey } from "@tiehall/catalog";
import { githubPrivateKeyUploaded, Refusal } from "@tiehall/core";
import { githubApp } from "@tiehall/db";
import { eq } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { anyLiveInstallation } from "./github-installations.ts";
import { storeSecret } from "./integration-secrets.ts";

// Uploading a rotated private key for the install's GitHub App
// (self-host-install: A rotated App key can be uploaded; agent-safety: Actions
// that need the confirmation step; activity-log: Which actions are security
// events; design.md, Self-hosting decisions: S4 and S7). After an admin
// generates a new private key in the App's settings on GitHub, they upload it
// in the web UI, with the confirmation step. The key is no part of the
// action's input, which the review page's URL carries: the admin picks the key
// file in a field of the review page's form, and it travels only in the body
// of the POST that applies the action, as the webhook secret does
// (github-app-reachability: design.md, Design rules: Moving to webhook mode).
// Before it is stored, Tiehall checks it by requesting an installation token
// with it, through an installation of the App that is neither suspended nor
// deleted. A file that is no private key, and a key GitHub does not accept,
// such as one of another App or one deleted on GitHub, get 400 and are not
// stored, and the key in use stays. A key GitHub accepts is stored encrypted
// in place of the key in use, used for the next call to GitHub, and recorded
// as a security event, in one write. The key is never shown again.

/** Whether the text is a private key in PEM form, as GitHub gives an App's key. */
function isPrivateKey(pem: string): boolean {
  try {
    createPrivateKey({ key: pem, format: "pem" });
    return true;
  } catch {
    return false;
  }
}

function refused(message: string): Refusal {
  return new Refusal("invalid-input", message, { issues: [{ path: ["privateKey"], message }] });
}

export const GITHUB_APP_KEY_HANDLERS: Handlers = {
  [uploadGitHubPrivateKey.id]: defineHandler(uploadGitHubPrivateKey, async (_input, context) => {
    const [row] = await context.tx
      .select({ appId: githubApp.appId, clientId: githubApp.clientId })
      .from(githubApp)
      .where(eq(githubApp.orgId, context.orgId))
      .for("update");
    if (row === undefined) throw new Refusal("conflict", "The install has no GitHub App yet, so there is no key to replace.");
    const { github, secrets } = context;
    if (github === undefined || secrets === undefined) throw new Error("This process has no GitHub App access or TIEHALL_SECRET_KEY to check and store a key with.");
    const privateKey = context.sealed["privateKey"];
    if (privateKey === undefined) throw new Error("execute() gave no private key to upload.");
    if (!isPrivateKey(privateKey)) throw refused("The file is not a private key in PEM form, such as the .pem file GitHub downloads.");
    const installationId = await anyLiveInstallation(context, row.appId);
    if (installationId === undefined) {
      throw new Refusal("conflict", "The install's GitHub App has no installation to check the key with. Install the App on GitHub first.");
    }
    if (!(await github.checkKey({ clientId: row.clientId, privateKey }, installationId))) {
      throw refused("GitHub did not accept the key for the install's App: it belongs to another App, or it was deleted on GitHub.");
    }
    return context.write(async (writer) => {
      await storeSecret(writer, secrets(), "github_app.private_key", privateKey);
      await writer.record(githubPrivateKeyUploaded, {});
      return { uploaded: true as const };
    });
  }),
};

/** The review page of an upload, which names the action and never the key. */
export const GITHUB_APP_KEY_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [uploadGitHubPrivateKey.id]: async (_input, context) => {
    const title = "Upload a new private key for the GitHub App";
    const [row] = await context.tx.select({ name: githubApp.name }).from(githubApp).where(eq(githubApp.orgId, context.orgId));
    if (row === undefined) return { title, lines: [{ text: "The install has no GitHub App yet, so there is no key to replace." }] };
    return {
      title,
      lines: [
        { text: `Upload a new private key for the install's GitHub App, ${row.name}, in place of the key in use.` },
        {
          text:
            "Before storing it, Tiehall asks GitHub for an installation token with it. A key GitHub does not accept is not stored, " +
            "and Tiehall keeps calling GitHub with the key in use.",
        },
        {
          text: "Tiehall stores the key encrypted and never shows it again. Once Tiehall uses the new key, delete the old one in the App's settings on GitHub.",
        },
      ],
    };
  },
};
