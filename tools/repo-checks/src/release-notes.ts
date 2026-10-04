import { documentedCommand, INSTALL_DOCS } from "./docs-commands.ts";
import { RELEASE_FILES, RELEASE_NOTES_ASSET } from "./release-files.ts";

// The release notes (self-host-install: Releases carry signed attestations;
// self-host-install: `init` prints a complete `.env`; design.md, Technical
// decisions: T13). Each release's notes name its image, pinned by version and
// digest, its version tag and its digest; show how to check the image's
// signed build-provenance and SBOM attestations against the repository with
// GitHub's artifact attestation verification, which needs no credentials for
// a public repository's image; list the files the release offers; and show
// the install docs' commands with the release's own values, so the install
// command carries --image with the release's reference, and the upgrade.

/** The SPDX predicate type of the image's SBOM attestation, which the scanner writes as SPDX 2.3. */
export const SBOM_PREDICATE_TYPE = "https://spdx.dev/Document/v2.3";

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
}

/** A Markdown block of shell commands. */
function commands(...lines: string[]): string {
  return ["```sh", ...lines, "```"].join("\n");
}

/** The release's notes, in Markdown. */
export function renderReleaseNotes({ root, version, image, repository }: ReleaseNotesInput): string {
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
    `Back up the install, set its \`TIEHALL_IMAGE\` in \`.env\` to this release's image, then pull the image and start it. ` +
      `The [upgrade docs](${docs}#upgrade) cover each step.`,
    commands(documentedCommand(root, "upgrade-backup")),
    ["```", `TIEHALL_IMAGE=${reference}`, "```"].join("\n"),
    commands(documentedCommand(root, "upgrade-pull-up")),
  ];
  return `${sections.join("\n\n")}\n`;
}
