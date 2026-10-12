import type { ChangelogRelease } from "@tiehall/catalog/changelog";
import { compareVersions, MINIMUM_PLUGIN_VERSION, MINIMUM_SKILL_VERSION } from "@tiehall/core";
import { releaseNotes as apiChangesSection, type WaitingApiChanges } from "./api-changelog.ts";
import { documentedCommand, INSTALL_DOCS } from "./docs-commands.ts";
import { checkMarketplace, type ListedPlugin } from "./marketplace.ts";
import { RELEASE_FILES, RELEASE_NOTES_ASSET } from "./release-files.ts";
import type { ContractStep, NoSkipRelease } from "./release-sources.ts";

// The release notes (self-host-install: Releases carry signed attestations;
// self-host-install: `init` prints a complete `.env`; design.md, Technical
// decisions: T13). Each release's notes name its image, pinned by version and
// digest, its version tag and its digest; show how to check the image's
// signed build-provenance and SBOM attestations against the repository with
// GitHub's artifact attestation verification, which needs no credentials for
// a public repository's image; list the files the release offers; and show
// the install docs' commands with the release's own values, so the install
// command carries --image with the release's reference, and the upgrade. The
// upgrade names every release up to this one that must not be skipped and
// flags the contract steps the release adds, after which the way back is the
// backup taken before the upgrade (self-host-install: Upgrades apply
// migrations before the app starts; self-host-install: Migrations expand,
// then contract); and the notes end with the release's API changes, the same
// entries as the changelog page of an install running it (public-api: The
// changelog page and the release notes).
//
// Each release is also a release of the client pieces that the repository
// itself serves rather than npm (public-api: Client pieces are built from
// public source with provenance). The notes pin the contract Action to the
// commit the release's tag points to, by its full SHA with the tag as a
// comment, which dependency-update tools bump (contract-changes: The contract
// Action), and show how to install the release's Claude Code plugin from the
// repository's plugin marketplace at the release's tag (agent-surfaces: The
// Claude Code plugin).

/** The SPDX predicate type of the image's SBOM attestation, which the scanner writes as SPDX 2.3. */
export const SBOM_PREDICATE_TYPE = "https://spdx.dev/Document/v2.3";

/** The contract Action's folder in the repository, which a workflow names after the repository in `uses:`. */
export const CONTRACT_ACTION = "actions/contract";

/** The page of the plugin docs, relative to the repository's root. */
export const PLUGIN_DOCS = "docs/claude-code-plugin.md";

/** A full commit SHA, which is what a workflow pins an action by. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The commit a release's tag points to, as the notes pin the contract Action by; it throws on anything but a full SHA. */
export function parseReleaseCommit(commit: string): string {
  if (!COMMIT_SHA.test(commit)) {
    throw new Error(`The release's commit must be its full SHA, 40 lower-case hexadecimal digits, such as $GITHUB_SHA of the tag's run; ${JSON.stringify(commit)} is not.`);
  }
  return commit;
}

/** The workflow that builds and attests each release's image, which the verification names as the signer. */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

export interface ReleaseImage {
  /** The repository the image is pushed to, such as ghcr.io/acme/tiehall. */
  repository: string;
  /** The release's version, the image's version tag, such as 1.3.0. */
  version: string;
  /** The image's digest, such as sha256:…. */
  digest: string;
}

/** A path component of an image repository, as container engines read one; the first may name a registry's port. */
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const PINNED_IMAGE = new RegExp(`^(${COMPONENT}(?::\\d{1,5})?(?:/${COMPONENT})*):([\\w][\\w.-]{0,127})@(sha256:[0-9a-f]{64})$`);

/** The image a release names: its repository tagged with the release's version and pinned by digest; it throws otherwise. */
export function parseReleaseImage(reference: string, version: string): ReleaseImage {
  const match = PINNED_IMAGE.exec(reference);
  if (match === null || match[2] !== version) {
    throw new Error(
      `The release's image must be its repository tagged with the release's version and pinned by version and digest, ` +
        `such as ghcr.io/acme/tiehall:${version}@sha256:<digest>; ${JSON.stringify(reference)} is not.`,
    );
  }
  return { repository: match[1] as string, version, digest: match[3] as string };
}

/** The reference a release's notes give: the version tag pinned by digest. */
export function imageReference({ repository, version, digest }: ReleaseImage): string {
  return `${repository}:${version}@${digest}`;
}

/** The repository's owner/name from its web address, such as acme/tiehall from https://github.com/acme/tiehall. */
export function repositoryName(repository: string): string {
  const match = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+?)\/?$/.exec(repository);
  if (match === null) throw new Error("The repository must be its web address, such as https://github.com/acme/tiehall.");
  return match[1] as string;
}

export interface ReleaseNotesInput {
  /** The repository's root, whose install docs give the commands. */
  root: string;
  /** The release's version, such as 1.3.0 or 1.3.0-rc.1. */
  version: string;
  /** The image the release workflow pushed. */
  image: ReleaseImage;
  /** The repository's web address, such as https://github.com/acme/tiehall. */
  repository: string;
  /** The commit the release's tag points to, its full SHA. */
  commit: string;
  /** The marketplace that lists the release's Claude Code plugin, and the plugin; read from the repository unless given. */
  plugin?: { marketplace: string; plugin: ListedPlugin };
  /**
   * The release's API changes, as openapi/changelog.json records them; for a release candidate, its final version's
   * record, or the entries waiting for it while that is not recorded.
   */
  api: ChangelogRelease | WaitingApiChanges;
  /** The contract steps the release adds since the previous release. */
  contractSteps: readonly ContractStep[];
  /** The releases up to this one that must not be skipped. */
  noSkip: readonly NoSkipRelease[];
}

/** A Markdown block of shell commands. */
function commands(...lines: string[]): string {
  return ["```sh", ...lines, "```"].join("\n");
}

/** The release's notes, in Markdown. */
export function renderReleaseNotes({ root, version, image, repository, commit, plugin, api, contractSteps, noSkip }: ReleaseNotesInput): string {
  const web = repository.replace(/\/+$/, "");
  const name = repositoryName(web);
  const tag = `v${version}`;
  const reference = imageReference(image);
  const address = `${web}/releases/download/${tag}`;
  const docs = `${web}/blob/${tag}/${INSTALL_DOCS}`;
  const release = /^(\d+\.\d+\.\d+)-/.exec(version)?.[1];
  const verify = `gh attestation verify oci://${image.repository}@${image.digest} --repo ${name} --signer-workflow ${name}/${RELEASE_WORKFLOW} --source-ref refs/tags/${tag} --bundle-from-oci`;
  const files = RELEASE_FILES.map(({ asset, name: file }) => (asset === file ? `\`${file}\`` : `\`${file}\` (as \`${asset}\`)`));
  const renamed = RELEASE_FILES.filter(({ asset, name: file }) => asset !== file)
    .map(({ asset, name: file }) => ` GitHub keeps no leading period in a release file's name, so \`${file}\` is offered as \`${asset}\`, and the download below saves it as \`${file}\`.`)
    .join("");
  const sections = [
    `# Tiehall ${version}`,
    ...(release === undefined
      ? []
      : [
          `This is a release candidate of ${release}, for trying the release before it is out: the release page marks it as a pre-release, ` +
            `and an install that runs it upgrades to ${release} once that is released.`,
        ]),
    "## The image",
    `\`${reference}\``,
    `This release's image is the version tag \`${image.repository}:${version}\`, pinned by its digest \`${image.digest}\`. ` +
      `The release workflow built it once, from the tag \`${tag}\` of ${web}, and it carries signed build-provenance and SBOM attestations. ` +
      "Check them against the repository with GitHub's artifact attestation verification, which needs no credentials: " +
      "the first command checks where and how the image was built, and the second its SBOM, the list of the packages it holds.",
    commands(verify, `${verify} --predicate-type ${SBOM_PREDICATE_TYPE}`),
    "## The release files",
    `This release offers ${files.slice(0, -1).join(", ")} and ${files.at(-1)}, and these notes as \`${RELEASE_NOTES_ASSET}\`.${renamed}`,
    "## Install",
    `In a new folder for the install, download the release files, write \`.env\` with fresh secrets for the install's URL in place of ` +
      `\`https://tiehall.example.com\`, and start the install. The [install docs](${docs}) cover each step, TLS, the setup screen and backups.`,
    commands(
      documentedCommand(root, "install-download", { "<release>": address }),
      documentedCommand(root, "install-init", { "<image>": reference }),
      documentedCommand(root, "install-up"),
    ),
    "## Upgrade",
    ...skipping(version, noSkip),
    ...contracting(contractSteps, docs),
    `Back up the install, set its \`TIEHALL_IMAGE\` in \`.env\` to this release's image, then pull the image and start it. ` +
      `The [upgrade docs](${docs}#upgrade) cover each step.`,
    commands(documentedCommand(root, "upgrade-backup")),
    ["```", `TIEHALL_IMAGE=${reference}`, "```"].join("\n"),
    commands(documentedCommand(root, "upgrade-pull-up")),
    ...clientPieces(name, web, tag, parseReleaseCommit(commit), plugin ?? releasePlugin(root)),
    apiChangesSection(api, version).trimEnd(),
  ];
  return `${sections.join("\n\n")}\n`;
}

/** The marketplace and the plugin it lists, as the repository at this root holds them; it throws when the marketplace check fails. */
export function releasePlugin(root: string): { marketplace: string; plugin: ListedPlugin } {
  const report = checkMarketplace(root, { plugin: MINIMUM_PLUGIN_VERSION, skill: MINIMUM_SKILL_VERSION });
  const plugin = report.plugins[0];
  if (report.problems.length > 0 || report.name === undefined || plugin === undefined) {
    throw new Error(`The release's Claude Code plugin marketplace does not pass its check (pnpm check:plugin):\n${report.problems.join("\n")}`);
  }
  return { marketplace: report.name, plugin };
}

/** What the notes say about the client pieces the release itself carries: the contract Action and the Claude Code plugin. */
function clientPieces(name: string, web: string, tag: string, commit: string, { marketplace, plugin }: { marketplace: string; plugin: ListedPlugin }): string[] {
  return [
    "## The contract Action",
    `This release's contract Action is \`${CONTRACT_ACTION}\` at the commit the tag \`${tag}\` points to. ` +
      `Pin it by that commit's full SHA, with the tag as a comment, as [its README](${web}/blob/${tag}/${CONTRACT_ACTION}/README.md) shows: ` +
      "a tag can be moved, a commit cannot, and the comment lets Renovate and Dependabot propose the next release.",
    ["```yaml", `- uses: ${name}/${CONTRACT_ACTION}@${commit} # ${tag}`, "```"].join("\n"),
    "## The Claude Code plugin",
    `This release holds the Claude Code plugin ${plugin.name} ${plugin.version}. ` +
      `Add the repository's plugin marketplace at the tag \`${tag}\`, then install the plugin, ` +
      `as [the plugin docs](${web}/blob/${tag}/${PLUGIN_DOCS}) describe with what it needs: the \`tiehall\` CLI and \`TIEHALL_URL\`.`,
    commands(`claude plugin marketplace add ${name}#${tag}`, `claude plugin install ${plugin.name}@${marketplace}`),
  ];
}

/** What the notes say about skipping releases: each release up to this one that must not be skipped, oldest first. */
function skipping(version: string, noSkip: readonly NoSkipRelease[]): string[] {
  const named = [...noSkip].filter((entry) => compareVersions(entry.version, version) <= 0).sort((a, b) => compareVersions(a.version, b.version));
  if (named.length === 0) return ["No release must be skipped: an install on any earlier release upgrades straight to this one, because the migrations run in order."];
  return named.map(({ version: release, reason }) =>
    release === version
      ? `This release must not be skipped: ${reason} An install upgrades to it before it upgrades to a later release.`
      : `Release ${release} must not be skipped: ${reason} An install on a release before ${release} upgrades to ${release} first, and to this release after it.`,
  );
}

/** What the notes say about contract steps: the ones the release adds, flagged with the way back after them. */
function contracting(steps: readonly ContractStep[], docs: string): string[] {
  const rollback = `[rollback docs](${docs}#rollback)`;
  if (steps.length === 0) {
    return [`This release has no contract step, so until a later release's contract step has run, going back to the previous release's image works as the ${rollback} describe.`];
  }
  const one = steps.length === 1;
  return [
    `This release has ${one ? "a contract step, which removes" : "contract steps, which remove"} or rewrite${one ? "s" : ""} what an earlier release replaced:`,
    steps.map(({ migration, after }) => `- \`${migration}\`, after the expand step of ${after}`).join("\n"),
    `Once ${one ? "it has" : "they have"} run, an image of an earlier release no longer starts on the install's database: ` +
      `the way back is the backup taken before the upgrade, restored with the previous image, as the ${rollback} describe. Take that backup first.`,
  ];
}
