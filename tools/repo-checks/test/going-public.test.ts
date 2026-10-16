import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { docsCommands, fencedBlocks } from "../src/docs-commands.ts";
import { headings, linkProblems, links, section } from "../src/markdown.ts";
import { taskStates } from "../src/plan.ts";
import { trackedTextFiles } from "../src/tracked-files.ts";

// The checklist for making the repository public (task 30.2; design.md,
// Decisions this change rests on: D38), docs/maintainers/going-public.md.
// Each item is a `### GP-<n> <title>` heading with what to do and one or more
// `- Evidence:` lines, each linking what shows that the item holds: a check
// or a test of the repository, a file, a workflow, or GitHub's documentation
// of a setting that a command reads back. The check finds an item for each
// step the plan and the maintainer named, every item linked to its evidence,
// every link resolving, every task it names being one of the plan's, every
// pnpm script one of the repository's, the required checks of the branch
// protection being the jobs CI runs, and nothing personal in the page. The
// scans for personal data of GP-2 and GP-7 and GP-7's read-back of the
// identities are `sh` blocks named in their info strings, such as ```sh
// docs-test=history-personal-data, which the check runs on scratch
// repositories.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PATH = "docs/maintainers/going-public.md";
const checklist = existsSync(join(root, PATH)) ? readFileSync(join(root, PATH), "utf8") : "";

interface Item {
  id: string;
  title: string;
  text: string;
}

/** The checklist's items, in order. */
function items(): Item[] {
  return headings(checklist)
    .filter(({ level, text }) => level === 3 && /^GP-\d+ /.test(text))
    .map(({ text }) => {
      const [id = "", ...rest] = text.split(" ");
      return { id, title: rest.join(" "), text: section(checklist, text) ?? "" };
    });
}

/** The text of the item with this id, such as GP-7, or "" when there is none. */
const item = (id: string) => items().find((found) => found.id === id)?.text ?? "";

/** GitHub's documentation of the files its file view renders, which names no video, and of the files a Markdown page takes as attachments. */
const NON_CODE_FILES = "https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files";
const ATTACHING_FILES = "https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files";

/** The steps the checklist must cover, each found in one item's title. */
const STEPS = [
  "allowlist",
  "nothing personal or secret",
  "license files",
  "README",
  "CONTRIBUTING",
  "SECURITY",
  "rewrite the history",
  "secret scan",
  "path scan",
  "pull request refs",
  "description, homepage and topics",
  "social preview",
  "private vulnerability reporting",
  "branch protection",
  "workflow permissions",
  "image's package",
  "organization's settings",
  "organization's profile",
  "switch to public",
  "first public release",
  "Actions minutes",
  "landing page",
  "DNS records",
];

describe("the checklist for making the repository public", () => {
  it("numbers its items GP-1, GP-2 and so on, in order", () => {
    const ids = items().map(({ id }) => id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(ids.map((_id, index) => `GP-${index + 1}`));
  });

  it("has an item for each step of making the repository public", () => {
    const titles = items().map(({ title }) => title.toLowerCase());
    expect(STEPS.filter((step) => !titles.some((title) => title.includes(step.toLowerCase())))).toEqual([]);
  });

  it("links every item to its evidence", () => {
    const unlinked = items().flatMap(({ id, text }) => {
      const evidence = text.split("\n").filter((line) => line.startsWith("- Evidence: "));
      if (evidence.length === 0) return [`${id}: no evidence`];
      return evidence.filter((line) => links(line).length === 0).map((line) => `${id}: ${line}`);
    });
    expect(unlinked).toEqual([]);
  });

  it("names only tasks of the plan", () => {
    const plan = taskStates(readFileSync(join(root, "openspec/changes/add-tiehall-oss-v1/tasks.md"), "utf8"));
    const named = [...checklist.matchAll(/\b[Tt]asks? (\d+\.\d+)(?:(?:,| and| to) (\d+\.\d+))*/g)].flatMap((match) =>
      [...match[0].matchAll(/\d+\.\d+/g)].map(([task]) => task),
    );
    expect(named.length).toBeGreaterThan(5);
    expect([...new Set(named)].filter((task) => !plan.has(task))).toEqual([]);
  });

  it("has links that all resolve, and the contributors' guide links it", () => {
    expect(linkProblems(root, PATH)).toEqual([]);
    expect(links(readFileSync(join(root, "CONTRIBUTING.md"), "utf8")).map(({ target }) => target)).toContain(PATH);
  });

  it("names only pnpm scripts the repository has, and only the repository's own scripts by path", () => {
    const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const spans = [...checklist.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
    const commands = [...spans, ...fencedBlocks(checklist).map(({ text }) => text)].join("\n");
    const named = [...commands.matchAll(/\bpnpm (?!install\b|-r\b|--filter\b|exec\b|vitest\b)([a-z][a-z0-9:-]*)/g)].map((match) => match[1] ?? "");
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)].filter((name) => !Object.hasOwn(scripts, name))).toEqual([]);
    const paths = [...commands.matchAll(/\btools\/repo-checks\/src\/[\w-]+\.ts\b/g)].map(([path]) => path);
    expect(paths.length).toBeGreaterThan(0);
    expect([...new Set(paths)].filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });

  it("lists, as the branch protection's required checks, the jobs that CI runs on a pull request", () => {
    type Job = { name?: string; needs?: string | string[]; uses?: string };
    const workflow = (file: string) => parse(readFileSync(join(root, ".github/workflows", file), "utf8")) as { jobs: Record<string, Job> };
    const ci = workflow("ci.yml").jobs;
    // The test job passes only when the typecheck and every shard passed, so it is the one the protection requires.
    const folded = new Set([ci["test"]?.needs ?? []].flat());
    const expected = [
      ...Object.entries(ci).flatMap(([id, job]) => {
        if (folded.has(id)) return [];
        if (job.uses === "./.github/workflows/image-checks.yml") {
          return Object.values(workflow("image-checks.yml").jobs).map((called) => `${job.name} / ${called.name}`);
        }
        return [job.name ?? id];
      }),
      ...Object.values(workflow("api-compatibility.yml").jobs).map((job) => job.name ?? ""),
    ];
    const line = checklist.split("\n").find((text) => text.startsWith("- Required checks: ")) ?? "";
    const listed = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
    expect(listed.sort()).toEqual(expected.sort());
  });

  it("rewrites a fresh clone with filter-repo run through uvx, unforced, and gives the rewritten clone its remote only to push it", () => {
    const gp7 = item("GP-7");
    // filter-repo runs through uvx, so that nothing is installed system-wide (design.md, D38 (4)).
    const rewrite = gp7.indexOf(FILTER_REPO);
    expect(rewrite).toBeGreaterThan(-1);
    expect(gp7).not.toMatch(/(?<!-)\bgit filter-repo\b/);
    expect(gp7).toContain(`\`${FILTER_REPO} --version\``);
    // filter-repo refuses a clone whose origin is gone unless forced, which turns off its other checks too, and
    // removes origin itself after the rewrite.
    expect(gp7.slice(0, rewrite)).not.toMatch(/\bremote (?:remove|rm) origin\b/);
    expect(gp7).not.toMatch(/git-filter-repo [^\n`]*--force/);
    expect(gp7).toContain("--force");
    expect(item("GP-10")).toContain("git remote add origin https://github.com/tiehall/tiehall.git");
  });

  it("drops the film's encode from the rewritten history and reads its blob back as gone (design.md, D38 (2))", () => {
    expect(item("GP-7")).toContain("`docs/assets/film/every-teams-line.mp4`");
    const gp9 = item("GP-9");
    expect(gp9).toContain("rev-list --all --objects");
    expect(gp9).toMatch(/`git -C \.\.\/tiehall-public cat-file -e [0-9a-f]{40}`/);
  });

  it("pushes the rewritten main alone to a new repository, the current one renamed and kept private as the archive (design.md, D38 (3))", () => {
    const gp10 = item("GP-10");
    const rename = gp10.indexOf("gh repo rename tiehall-private --repo tiehall/tiehall");
    const create = gp10.indexOf("gh repo create tiehall/tiehall --private");
    const push = gp10.indexOf("git push origin main");
    expect(rename).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(rename);
    expect(push).toBeGreaterThan(create);
    // Nothing of the old repository is pushed over or deleted: a force push would leave its pull request refs and branches.
    expect(gp10).not.toMatch(/git push [^\n`]*(?:--force|-f\b|--delete)/);
    expect(gp10).not.toMatch(/GitHub Support to remove/);
    expect(gp10).toContain("gh repo archive tiehall/tiehall-private");
    const readBack = gp10.split("\n").find((line) => line.startsWith("- Read back: ")) ?? "";
    expect(readBack).toContain("`git ls-remote https://github.com/tiehall/tiehall.git`");
    expect(readBack).toContain("nothing else: no other branch, no tag and no pull request ref");
    // The working clone's origin names the old address, which is the new repository's once it is created: a push from it
    // would put the old history there. So it points at the archive right after the rename, before the creation.
    const setUrl = gp10.indexOf("git remote set-url origin https://github.com/tiehall/tiehall-private.git");
    expect(setUrl).toBeGreaterThan(rename);
    expect(setUrl).toBeLessThan(create);
    const pointed = gp10.split("\n").find((line) => line.startsWith("- ") && line.includes("git remote set-url origin")) ?? "";
    expect(pointed).toMatch(/Read back: `git remote -v`/);
  });

  it("allows squash merges alone on the new repository, with a linear history, and reads both back (design.md, D38 (5))", () => {
    const gp14 = item("GP-14");
    // The squashed commit takes the pull request's title and description, as the contributors' guide says.
    expect(gp14).toContain(
      "gh api -X PATCH repos/tiehall/tiehall -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY",
    );
    expect(gp14).toContain(
      "`gh api repos/tiehall/tiehall --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title, squash_merge_commit_message}'`",
    );
    expect(gp14).toContain("required_linear_history");
    expect(gp14).toMatch(/linear: \.required_linear_history\.enabled/);
    expect(item("GP-9")).toContain("GP-14");
  });

  it("takes every change to main through a pull request, which required checks alone do not, and reads it back", () => {
    // With required checks alone, a commit whose checks have passed can be pushed to main directly, and its branch's
    // other commits with it; a required pull request with no approval keeps a pull request's own commits off main.
    const gp14 = item("GP-14");
    expect(gp14).toContain('`"required_pull_request_reviews": {"required_approving_review_count": 0}`');
    expect(gp14).toMatch(/Read back[^\n]*pull_requests: \.required_pull_request_reviews\.required_approving_review_count/);
    expect(gp14).toMatch(/strict: \.required_status_checks\.strict/);
  });

  it("requires two-factor authentication and stops members creating public repositories at the switch, reading both back (design.md, D38 (6))", () => {
    const gp17 = item("GP-17");
    expect(gp17).toMatch(/at the switch/);
    // GitHub removes every member without two-factor authentication once the organization requires it: list them first.
    expect(gp17).toContain("orgs/tiehall/members?filter=2fa_disabled");
    expect(gp17).toContain("gh api -X PATCH orgs/tiehall -F members_can_create_public_repositories=false");
    expect(gp17).toMatch(/Read back: `gh api orgs\/tiehall --jq '\{two_factor_requirement_enabled, default_repository_permission, members_can_create_public_repositories\}'` gives `\{"two_factor_requirement_enabled":true,/);
    // GitHub restricts members to private repositories alone only on GitHub Enterprise Cloud, so on the free plan the
    // setting stays true, and the design asks the maintainer how to meet D38 (6).
    const question = "Members creating public repositories on the free plan";
    expect(gp17).toContain("GitHub Enterprise Cloud");
    expect(gp17).toContain(`Open Question "${question}"`);
    const design = readFileSync(join(root, "openspec/changes/add-tiehall-oss-v1/design.md"), "utf8");
    expect(section(design, "Open Questions") ?? "").toContain(`**${question}**`);
    expect(design).toMatch(new RegExp(`\\*\\*\\(6\\) [^\\n]*Open Question "${question}"`));
    // GP-16 allowed the organization public packages, which lets members publish them too: GP-17 names that setting.
    expect(gp17).toMatch(/Package creation[^\n]*Read back/);
  });

  it("sets the new repository up again: its homepage and its workflow permissions (design.md, D38 (3))", () => {
    expect(item("GP-11")).toContain("--homepage https://tiehall.com");
    expect(item("GP-15")).toMatch(/new repository \(GP-10\)/);
    expect(item("GP-15")).toMatch(
      /Read back: `gh api repos\/tiehall\/tiehall\/actions\/permissions\/fork-pr-contributor-approval` gives `\{"approval_policy":"all_external_contributors"\}`/,
    );
  });

  it("sets up before the switch only GP-11 and GP-15, which a private repository takes, and the other settings after it", () => {
    // GitHub shows the social preview's setting, and the free plan offers private vulnerability reporting and branch
    // protection, only on a public repository; the package is built again by the first Build run on main (GP-16).
    const setUp = item("GP-10").split("\n").find((line) => line.startsWith("- Set the new repository up")) ?? "";
    expect(setUp).toContain("as GP-11 and GP-15 say");
    expect(setUp).toContain("GP-12 to GP-14 and GP-16 follow the switch");
    const steps = item("GP-19").split("\n").filter((line) => line.startsWith("- "));
    expect(steps[0]).toContain("GP-11 and GP-15 are set on the new repository: apply the organization's settings of GP-17");
    expect(steps[0]).toMatch(/GP-12's social preview follows the switch[^\n]*GP-16/);
    const recovery = steps.find((line) => line.includes("gh repo delete tiehall/tiehall")) ?? "";
    expect(recovery).toContain("run GP-10 again from its creation and GP-11 and GP-15 after it");
    expect(item("GP-12")).toMatch(/Upload it to the new repository[^\n]*after the switch/);
  });

  it("deletes the archive's image package, builds it again from the new repository and makes it public, read back without credentials (design.md, D38 (7))", () => {
    const gp16 = item("GP-16");
    const at = (text: string) => {
      const found = gp16.indexOf(text);
      expect(found, text).toBeGreaterThan(-1);
      return found;
    };
    // The archive's package refuses the new repository's push and holds the private history's images, so it is deleted
    // and the new repository's Build run creates it again, connected to tiehall/tiehall; no Write role is given.
    expect(gp16).toContain("D38 (7)");
    expect(gp16).toContain("denied: permission_denied: write_package");
    expect(gp16).not.toMatch(/the Write role/);
    expect(at("gh run rerun")).toBeGreaterThan(at("Delete this package"));
    expect(gp16).toContain("org.opencontainers.image.source");
    // The organization allows public packages before the package's visibility can change.
    expect(at("Package creation")).toBeLessThan(at("Change visibility"));
    // A new package holds no image of an earlier main commit, which the backup and upgrade jobs need.
    for (const job of ["`Image / Backup and restore`", "`Image / Upgrade and rollback`", "No previous image found"]) at(job);
    expect(gp16).toMatch(/Read back[^\n]*`curl -sS 'https:\/\/ghcr\.io\/token\?scope=repository:tiehall\/tiehall:pull'/);
    const design = readFileSync(join(root, "openspec/changes/add-tiehall-oss-v1/design.md"), "utf8");
    expect(section(design, "Open Questions") ?? "").not.toContain("The image's package after the move to a new repository");
    expect(design).toMatch(/\*\*\(7\) The image's package is deleted and built again from the public history\.\*\*/);
  });

  it("merges the first pull request, whose image jobs have no earlier image, once as an administrator, and protects main for administrators again right after", () => {
    const gp19 = item("GP-19");
    const at = (text: string) => {
      const found = gp19.indexOf(text);
      expect(found, text).toBeGreaterThan(-1);
      return found;
    };
    const lifted = at("`gh api -X DELETE repos/tiehall/tiehall/branches/main/protection/enforce_admins`");
    const merged = at("--squash --admin");
    const restored = at("`gh api -X POST repos/tiehall/tiehall/branches/main/protection/enforce_admins`");
    expect(lifted).toBeLessThan(merged);
    expect(merged).toBeLessThan(restored);
    expect(at("No previous image found")).toBeLessThan(lifted);
    expect(gp19.slice(restored)).toMatch(/[Rr]ead back `gh api repos\/tiehall\/tiehall\/branches\/main\/protection\/enforce_admins --jq \.enabled`, which gives `true`/);
  });

  it("deletes the archive's package before the film's merge, and makes the image public once that merge's Build run has pushed it (GP-16)", () => {
    // The archive's package refuses the new repository's push, so it goes before the first push to main that the
    // workflows see, the film's merge; the image that push builds is then made public.
    const steps = item("GP-19").split("\n").filter((line) => line.startsWith("- "));
    const step = (text: string) => {
      const found = steps.findIndex((line) => line.includes(text));
      expect(found, text).toBeGreaterThan(-1);
      return found;
    };
    const deletion = step("delete the archive's image package");
    const merge = step("--squash --admin");
    const published = step("make the image public");
    expect(deletion).toBeGreaterThan(step("actions/permissions -F enabled=true"));
    expect(deletion).toBeLessThan(merge);
    expect(published).toBeGreaterThan(merge);
    for (const found of [deletion, published]) expect(steps[found]).toContain("(GP-16)");
    expect(steps[merge]).toContain("the first push to `main` since the workflows were turned on");
  });

  it("installs no app on the new repository before the switch, and Renovate's only after its dry run, read back (design.md, D38 (3))", () => {
    // An app that writes to the new repository, such as Renovate's, which opens a branch and a pull request for each
    // update renovate.json allows, would give it refs that GP-19's read-back, HEAD and main alone, takes for the old
    // history's; and running GP-10 again, as GP-19 then says, would install the app again.
    const gp10 = item("GP-10");
    expect(gp10).not.toMatch(/app installations?, such as Renovate's/);
    const setUp = gp10.split("\n").find((line) => line.startsWith("- Set the new repository up")) ?? "";
    expect(setUp).toContain("Install no app on it before the switch");
    expect(setUp).toContain("GP-21");
    // An app installed for all of the organization's repositories reaches the new one as soon as it is created, so
    // the check comes before the creation.
    const installations = gp10.indexOf(
      "`gh api orgs/tiehall/installations --jq '.installations[] | {app_slug, repository_selection}'` lists no installation whose `repository_selection` is `all`",
    );
    expect(installations).toBeGreaterThan(-1);
    expect(installations).toBeLessThan(gp10.indexOf("`gh repo create tiehall/tiehall"));
    const steps = item("GP-21").split("\n").filter((line) => line.startsWith("- "));
    const dryRun = steps.findIndex((line) => line.includes("the Renovate dry run"));
    const install = steps.findIndex((line) => line.includes("https://github.com/apps/renovate"));
    expect(dryRun).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(dryRun);
    const installing = steps[install] ?? "";
    expect(installing).toContain("for `tiehall/tiehall` alone");
    expect(installing).toMatch(/Read back: `gh api orgs\/tiehall\/installations --jq '\.installations\[\] \| select\(\.app_slug == "renovate"\) \| \.repository_selection'` gives `selected`/);
    expect(installing).toContain("`gh issue list --repo tiehall/tiehall --app renovate");
  });

  it("switches in order: the organization's settings, the visibility, then protection, workflows, the film and the landing page (design.md, D38 (6))", () => {
    const gp19 = item("GP-19");
    const at = (text: string) => {
      const found = gp19.indexOf(text);
      expect(found, text).toBeGreaterThan(-1);
      return found;
    };
    const visibility = at("--visibility public");
    expect(at("GP-17")).toBeLessThan(visibility);
    // GP-10's archive follows the switch, so the switch cannot wait for all of GP-10.
    expect(gp19).not.toMatch(/GP-1 to GP-10 pass/);
    // A push from a clone of the old history since GP-10 would have put it in the new repository: its refs are read
    // back again right before the change of visibility.
    const refs = at("`git ls-remote https://github.com/tiehall/tiehall.git` lists `HEAD` and `refs/heads/main` and nothing else");
    expect(refs).toBeGreaterThan(at("GP-17"));
    expect(refs).toBeLessThan(visibility);
    expect(gp19.slice(refs, visibility)).toContain("merge-base --is-ancestor");
    // GP-10 keeps the new repository's workflows off until the switch; the film's pull request needs its required checks.
    const workflows = at("gh api -X PUT repos/tiehall/tiehall/actions/permissions -F enabled=true");
    expect(workflows).toBeGreaterThan(visibility);
    expect(at("`every-teams-line.mp4`")).toBeGreaterThan(workflows);
    expect(at("GP-22")).toBeGreaterThan(at("`every-teams-line.mp4`"));
    expect(gp19).toContain("`gh api repos/tiehall/tiehall/actions/permissions --jq .enabled`");
  });

  it("changes the film's end card when the first release ships, and puts the new encode in the README's player (design.md, D38 (1))", () => {
    const gp20 = item("GP-20");
    expect(gp20).toContain("Coming soon");
    expect(gp20).toContain("node tools/repo-checks/src/check-film.ts ");
    expect(gp20).toContain("pull request");
    expect(gp20).toMatch(/Read back[^\n]*signed out/);
    expect(item("GP-4")).toContain("GP-20");
  });

  it("puts the landing page live only at the switch, as a simple introduction that sends people to the repository", () => {
    const gp22 = item("GP-22");
    expect(gp22).toContain("goes live only at the switch");
    expect(gp22).toContain("https://github.com/tiehall/tiehall");
    expect(gp22).toMatch(/Read back: `curl -sSI https:\/\/tiehall\.com`/);
    expect(gp22).toContain("`https://tiehall.com/schemas/`");
    // Where the page is served was an Open Question of the design until the maintainer answered it on 2026-10-16:
    // GitHub Pages, from this repository's site/.
    expect(gp22).toContain("D38 (8)");
    expect(gp22).not.toContain("the maintainers' choice");
    expect(gp22).not.toContain("Open Question");
    const design = readFileSync(join(root, "openspec/changes/add-tiehall-oss-v1/design.md"), "utf8");
    expect(section(design, "Open Questions") ?? "").not.toContain("Where the landing page is served");
    expect(design).toMatch(/\*\*\(8\) The landing page is served on GitHub Pages from this repository's `site\/`/);
    // A resolver that still holds the domain's earlier address answers for another host: the read-back can pin GitHub's.
    expect(gp22).toContain("--resolve tiehall.com:443:185.199.108.153");
  });

  it("builds the landing page in site/ with its workflow, and plays the film there from YouTube (task 30.15; the change play-film-from-youtube)", () => {
    const gp22 = item("GP-22");
    const targets = links(gp22).map(({ target }) => target);
    expect(targets).toEqual(expect.arrayContaining(["../../site", "../../.github/workflows/pages.yml", "../../tools/repo-checks/test/site.test.ts"]));
    expect(gp22).toMatch(/task 30\.15/);
    expect(gp22).toContain("GP-23");
    // The README's attachment answers 404 to visitors who are not signed in to GitHub, so the page frames its own
    // film page, whose poster leads to YouTube's privacy-enhanced player once a visitor starts the film.
    expect(gp22).toContain("`site/film.html`");
    expect(gp22).toContain("`https://www.youtube-nocookie.com`");
    expect(links(gp22).map(({ target }) => target)).toContain("../../openspec/changes/play-film-from-youtube/design.md");
    expect(gp22).not.toContain("`data-film`");
  });

  it("points tiehall.com at GitHub Pages through Turhost's DNS, once the domain is verified, and enforces HTTPS once GitHub has its certificate (task 30.15)", () => {
    const gp23 = item("GP-23");
    const at = (text: string) => {
      const found = gp23.indexOf(text);
      expect(found, text).toBeGreaterThan(-1);
      return found;
    };
    expect(gp23).toContain("Turhost");
    // GitHub Pages' addresses for an apex domain, and the organization's default domain for www.
    for (const address of ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"]) expect(gp23).toContain(`\`${address}\``);
    for (const address of ["2606:50c0:8000::153", "2606:50c0:8001::153", "2606:50c0:8002::153", "2606:50c0:8003::153"]) expect(gp23).toContain(`\`${address}\``);
    expect(gp23).toMatch(/`www`[^\n]*`CNAME`[^\n]*`tiehall\.github\.io`/);
    // Only what conflicts with GitHub Pages leaves the zone: another A, AAAA, ALIAS or ANAME record or a forward at the
    // apex, any record for www, and any wildcard, which GitHub warns lets another account take a subdomain over. The
    // zone's NS and SOA records stay, and so do its MX, TXT and CAA records, a mailbox's among them once one exists.
    const zone = gp23.split("\n").find((line) => line.includes("Turhost's DNS zone")) ?? "";
    expect(zone).not.toMatch(/\bremove every other record\b/);
    const keep = zone.indexOf("Keep ");
    expect(keep, "the step says which records stay").toBeGreaterThan(-1);
    const [removed, kept] = [zone.slice(0, keep), zone.slice(keep)];
    for (const type of ["A", "AAAA", "ALIAS", "ANAME"]) expect(removed).toContain(`\`${type}\``);
    expect(removed).toMatch(/\bforward\b/);
    expect(removed).toMatch(/any record for `www`/);
    expect(removed).toMatch(/wildcard record \(`\*`\)/);
    for (const type of ["NS", "SOA", "MX", "TXT", "CAA"]) expect(kept).toContain(`\`${type}\``);
    // The domain is verified for the organization and for GitHub Pages before any record points at GitHub's servers.
    const records = at("`185.199.108.153`");
    expect(at("`_github-pages-challenge-tiehall.tiehall.com`")).toBeLessThan(records);
    expect(at("Verified and approved domains")).toBeLessThan(records);
    expect(gp23).toMatch(/Read back: `gh api graphql[^`]*organization\(login: \\?"tiehall\\?"\)[^`]*domains[^`]*isVerified/);
    // That read-back needs the admin:org scope; the organization's verified flag reads back without it.
    expect(gp23).toContain("`gh api orgs/tiehall --jq .is_verified`");
    for (const name of ["A tiehall.com", "AAAA tiehall.com", "CNAME www.tiehall.com"]) expect(gp23).toContain(`\`dig +short ${name}\``);
    // Turhost's zone editor offers no AAAA type, so the four A records alone serve the page, over IPv4.
    expect(gp23).toMatch(/Turhost's zone editor offers no `AAAA`/);
    expect(gp23).toMatch(/`dig \+short AAAA tiehall\.com` prints nothing at Turhost/);
    // GitHub Pages publishes the workflow's upload, under the custom domain, which the API sets: a workflow's upload has no CNAME file GitHub reads.
    const pages = at("gh api -X POST repos/tiehall/tiehall/pages -f build_type=workflow");
    const domain = at("gh api -X PUT repos/tiehall/tiehall/pages -f cname=tiehall.com");
    expect(pages).toBeLessThan(domain);
    expect(gp23).toContain("`site/CNAME`");
    // HTTPS is enforced only once GitHub's DNS check has passed and its certificate exists.
    const health = at("gh api repos/tiehall/tiehall/pages/health");
    const https = at("gh api -X PUT repos/tiehall/tiehall/pages -F https_enforced=true");
    expect(health).toBeLessThan(https);
    expect(domain).toBeLessThan(https);
    expect(at("gh workflow run pages.yml --repo tiehall/tiehall")).toBeGreaterThan(domain);
    expect(gp23).toMatch(/Read back: `gh api repos\/tiehall\/tiehall\/pages --jq '[^']*https_enforced[^']*'`/);
    expect(gp23).toContain("`curl -sSI http://tiehall.com`");
    expect(item("GP-17")).toContain("GP-23");
    expect(item("GP-22")).toContain("GP-23");
  });

  it("reads back every change it makes on GitHub", () => {
    // A step that changes GitHub, its repositories or its organization says how to read the result back.
    const changes = /`gh repo (?:create|rename|archive|edit)\b|`gh api -X (?:PUT|PATCH|POST|DELETE)\b/;
    const unread = items()
      .filter(({ text }) => changes.test(text) && !/\bread (?:it )?back\b/i.test(text))
      .map(({ id }) => id);
    expect(unread).toEqual([]);
    for (const step of ["gh repo rename", "gh repo create", "gh repo archive"]) {
      const bullet = item("GP-10").split("\n").find((line) => line.startsWith("- ") && line.includes(step)) ?? "";
      expect(bullet, step).toMatch(/Read back: `gh api repos\/tiehall\//);
    }
  });

  it("keeps the film's encode out of the repository, and puts GitHub's player for it in the README right after the switch, read back signed out (task 30.11)", () => {
    // The repository holds the film's poster alone (design.md, D38 (2)). GitHub's file view plays no video; a video
    // attached to a Markdown page plays there, and a private repository's attachments show to its members alone, so the
    // attachment waits for the switch. The encode is made and checked outside the repository, then uploaded.
    const gp4 = item("GP-4");
    expect(links(gp4).map(({ target }) => target)).toContain(NON_CODE_FILES);
    expect(gp4).toContain("GP-19");
    expect(gp4).toContain("node tools/repo-checks/src/check-film.ts ");
    const gp19 = item("GP-19");
    const steps = gp19.split("\n").filter((line) => line.startsWith("- "));
    const film = steps.find((line) => line.includes("`every-teams-line.mp4`")) ?? "";
    expect(film).not.toContain("docs/assets/film/every-teams-line.mp4");
    expect(film).toContain("`https://github.com/user-attachments/assets/<id>`");
    expect(film).toContain("pull request");
    expect(steps.indexOf(film)).toBeGreaterThan(steps.findIndex((line) => line.includes("--visibility public")));
    const readBack = steps.filter((line) => line.startsWith("- Read back")).join("\n");
    expect(readBack).toContain("signed out");
    expect(readBack).toContain("player");
    expect(links(gp19).map(({ target }) => target)).toContain(ATTACHING_FILES);
  });

  it("keeps personal data out: the repository's public address only, no mailbox, no local path, no earlier email", () => {
    expect(checklist).toContain("github.com/tiehall/tiehall");
    expect(links(checklist).filter(({ target }) => target.startsWith("mailto:"))).toEqual([]);
    expect(checklist).not.toMatch(/security@tiehall\.com/i);
    expect(checklist).not.toMatch(/gmail\.com/i);
    // A home folder's path names its owner; the bare prefixes, as a search names them, do not.
    expect(checklist).not.toMatch(/\/(?:Users|home)\/\w/);
    // Every address it names is the public identity the history will show, or GitHub's own committer of merges made on the web.
    const addresses = [...checklist.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([address]) => address);
    expect([...new Set(addresses)].filter((address) => !address.endsWith("@users.noreply.github.com") && address !== "noreply@github.com")).toEqual([]);
  });

  it("says what each part is for in its opening, and names the founder steps", () => {
    const level2 = headings(checklist)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(level2.length).toBeGreaterThanOrEqual(3);
    expect(checklist).toContain("founder step");
  });
});

describe("the checklist's scans for personal data", () => {
  let scratch: string;
  let count = 0;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-going-public-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** What names the fixture's maintainer: personal.txt, kept beside the checkout and the clone. */
  const PERSONAL = "kq7user\nkq7@example.invalid\n";
  /** A personal.txt whose one line no fixture holds, so only the search for any home folder's path finds anything. */
  const NO_ONE = "no-such-name-anywhere\n";

  function git(cwd: string, ...args: string[]): void {
    const run = spawnSync(
      "git",
      ["-c", "user.name=Public Author", "-c", "user.email=public@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }

  function commit(repo: string, files: Record<string, string | Buffer>, ...args: string[]): void {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), content);
    }
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "--allow-empty", ...args);
  }

  /** A folder of its own holding personal.txt and a repository, <folder>/<name>, whose first commit holds the files given. */
  function repository(name: string, files: Record<string, string | Buffer>): string {
    const repo = join(scratch, `workspace-${++count}`, name);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    commit(repo, files, "-m", "Start");
    return repo;
  }

  /** What the checklist's block with this name prints, run with sh in the repository with this personal.txt beside it. */
  function scan(name: string, repo: string, personal: string): string {
    const command = docsCommands(checklist).find(({ id }) => id === name);
    expect(command, `${PATH} holds no block named ${name}`).toBeDefined();
    writeFileSync(join(repo, "..", "personal.txt"), personal);
    const run = spawnSync("sh", ["-c", command?.text ?? ""], {
      cwd: repo,
      encoding: "utf8",
      // A user's git configuration that shows no diff for a first commit changes nothing.
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "log.showRoot", GIT_CONFIG_VALUE_0: "false" },
    });
    if (run.error) throw run.error;
    expect(run.stderr).toBe("");
    return run.stdout;
  }

  /** Text that names no one: a web address whose path holds home, and a relative folder named home. */
  const LINKS = "See https://example.com/news/home/2026 and ./home/readme.\n";

  it("GP-2 finds, in the tree, each line of personal.txt and any home folder's path, written with slashes or dashes", () => {
    expect(item("GP-2")).toContain("docs-test=tree-personal-data");
    const repo = repository("checkout", {
      "docs/notes.md": "Kept in /Users/kq7user/notes.\n",
      "tools/backup.test.ts": "writeFileSync(`/private/tmp/claude-501/-Users-kq7user-Projects-app/out.txt`);\n",
      "docs/contact.md": "Write to kq7@example.invalid.\n",
      "docs/links.md": LINKS,
    });

    const named = scan("tree-personal-data", repo, PERSONAL);
    for (const hit of ["docs/notes.md:1:", "tools/backup.test.ts:1:", "docs/contact.md:1:"]) expect(named).toContain(hit);
    expect(named).not.toContain("docs/links.md");

    const anyHome = scan("tree-personal-data", repo, NO_ONE);
    for (const hit of ["docs/notes.md:1:", "tools/backup.test.ts:1:"]) expect(anyHome).toContain(hit);
    expect(anyHome).not.toContain("docs/contact.md");
    expect(anyHome).not.toContain("docs/links.md");
  });

  it("GP-7 backs up, first, every ref of the repository on GitHub, its pull request refs included, and the working clone's own branches", () => {
    const gp7 = item("GP-7");
    expect(gp7.indexOf("docs-test=history-backup")).toBeGreaterThan(-1);
    expect(gp7.indexOf("docs-test=history-backup")).toBeLessThan(gp7.indexOf("docs-test=history-rewrite"));
    // GitHub's repository: main, a branch beside it and a pull request's ref, which only a mirror fetches.
    const checkout = repository("checkout", { "README.md": "# App\n" });
    const github = join(checkout, "..", "github.git");
    git(checkout, "init", "--quiet", "--bare", "--initial-branch=main", github);
    git(checkout, "remote", "add", "origin", github);
    git(checkout, "push", "--quiet", "origin", "main");
    git(checkout, "checkout", "--quiet", "-b", "deps/base-image");
    commit(checkout, { "Dockerfile": "FROM node\n" }, "-m", "Update the base image");
    git(checkout, "push", "--quiet", "origin", "deps/base-image", "deps/base-image:refs/pull/1/head");
    // A branch of the working clone that was never pushed, such as a spike's.
    git(checkout, "checkout", "--quiet", "-b", "spike/local", "main");
    commit(checkout, { "spikes/app.js": "// spike\n" }, "-m", "Spike");
    git(checkout, "checkout", "--quiet", "main");

    const block = docsCommands(checklist).find(({ id }) => id === "history-backup")?.text ?? "";
    expect(block).toContain("https://github.com/tiehall/tiehall.git");
    const run = spawnSync("sh", ["-c", block.replaceAll("https://github.com/tiehall/tiehall.git", github)], { cwd: checkout, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const heads = (bundle: string) =>
      spawnSync("git", ["bundle", "list-heads", join(checkout, "..", bundle)], { cwd: checkout, encoding: "utf8" })
        .stdout.split("\n")
        .map((line) => line.split(" ")[1] ?? "")
        .filter((ref) => ref !== "");
    expect(heads("tiehall-backup.bundle")).toEqual(expect.arrayContaining(["refs/heads/main", "refs/heads/deps/base-image", "refs/pull/1/head"]));
    expect(heads("tiehall-working.bundle")).toEqual(expect.arrayContaining(["refs/heads/main", "refs/heads/spike/local"]));
  });

  it("GP-7 clones GitHub's main only at the working main's commit, and lists the paths to remove by the clone's own allowlist", () => {
    const gp7 = item("GP-7");
    const order = ["history-backup", "history-fresh-clone", "history-outside", "history-rewrite"].map((name) => gp7.indexOf(`docs-test=${name}`));
    expect(order.every((at) => at > -1), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(item("GP-9")).toContain("`node ../tiehall-public/tools/repo-checks/src/check-public-paths.ts ../tiehall-public --history`");

    // The check reads the allowlist beside its own script, so the clone's copy reads the one the public main will hold.
    const allowlist = (paths: string[]) => `${JSON.stringify({ paths: { public: paths }, ignored: ["private/"] })}\n`;
    const check = Object.fromEntries(
      ["check-public-paths.ts", "public-paths.ts"].map((file) => [`tools/repo-checks/src/${file}`, readFileSync(join(root, "tools/repo-checks/src", file), "utf8")]),
    );
    const checkout = repository("checkout", {
      ...check,
      ".gitignore": "private/\n",
      "README.md": "# App\n",
      "tools/repo-checks/public-paths.json": allowlist(["README.md", ".gitignore", "tools/**"]),
    });
    commit(checkout, { "docs/film.mp4": "an encode\n" }, "-m", "Add the film");
    git(checkout, "rm", "--quiet", "docs/film.mp4");
    commit(checkout, {}, "-m", "Keep the film out");
    const github = join(checkout, "..", "github.git");
    git(checkout, "init", "--quiet", "--bare", "--initial-branch=main", github);
    git(checkout, "remote", "add", "origin", github);
    git(checkout, "push", "--quiet", "origin", "main");
    commit(checkout, { "README.md": "# App, not pushed yet\n" }, "-m", "Not pushed yet");

    const run = (name: string) => {
      const block = docsCommands(checklist).find(({ id }) => id === name)?.text ?? "";
      expect(block, `${PATH} holds no block named ${name}`).not.toBe("");
      return spawnSync("sh", ["-c", block.replaceAll("https://github.com/tiehall/tiehall.git", github)], { cwd: checkout, encoding: "utf8" });
    };
    const head = (repo: string, ref: string) => spawnSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const clone = join(checkout, "..", "tiehall-public");

    // GitHub's main lacks a commit of the working main: no clone is made.
    expect(run("history-fresh-clone").status).not.toBe(0);
    expect(existsSync(clone)).toBe(false);
    git(checkout, "push", "--quiet", "origin", "main");
    const cloned = run("history-fresh-clone");
    expect(cloned.status, cloned.stderr).toBe(0);
    expect(head(clone, "HEAD")).toBe(head(checkout, "main"));

    // A checkout whose allowlist holds more than the clone's changes nothing of the list.
    writeFileSync(join(checkout, "tools/repo-checks/public-paths.json"), allowlist(["**"]));
    expect(run("history-outside").status).toBe(1);
    expect(readFileSync(join(checkout, "..", "outside.txt"), "utf8")).toBe("docs/film.mp4\n");
  });

  describe("GP-7, over the rewritten history", () => {
    /**
     * A history whose personal data only a first commit, a file a later
     * commit removed, a binary file, an author, a message and a merge's
     * resolution hold, the merge at the tip of a branch that is not checked out.
     */
    function history(): string {
      const repo = repository("tiehall-public", { "README.md": "# App\n", "tools/first.ts": 'export const note = "first commit only: kq7user";\n' });
      commit(repo, { "tools/backup.test.ts": "writeFileSync(`/private/tmp/claude-501/-Users-kq7user-Projects-app/out.txt`);\n" }, "-m", "Write the output");
      git(repo, "rm", "--quiet", "tools/backup.test.ts");
      commit(repo, {}, "-m", "Stop writing the output");
      const binary = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from("binary only: kq7user"), Buffer.from([0, 255])]);
      commit(repo, { "tools/icon.bin": binary }, "--author=Pat <kq7@example.invalid>", "-m", "Add the icon");
      commit(repo, { "docs/links.md": LINKS }, "-m", "Add the links\n\nmessage only: kq7user ran it in /Users/kq7user/app");
      git(repo, "checkout", "--quiet", "-b", "side");
      commit(repo, { "docs/side.md": "# Side\n" }, "-m", "Side");
      git(repo, "checkout", "--quiet", "-b", "hosted", "main");
      git(repo, "merge", "--quiet", "--no-ff", "--no-commit", "side");
      commit(repo, { "deploy/merged.txt": "merge resolution only: kq7user\n" }, "-m", "Merge side");
      git(repo, "checkout", "--quiet", "main");
      return repo;
    }

    it("finds each line of personal.txt in every identity, message and line a commit adds or removes, binary files too", () => {
      const found = scan("history-personal-data", history(), PERSONAL);
      for (const hit of [
        "first commit only: kq7user",
        "-Users-kq7user-Projects-app",
        "binary only: kq7user",
        "Pat <kq7@example.invalid>",
        "message only: kq7user",
        "merge resolution only: kq7user",
      ]) {
        expect(found).toContain(hit);
      }
      expect(found).not.toContain("news/home");
    });

    it("finds any home folder's path, written with slashes or dashes, that personal.txt does not name", () => {
      const found = scan("history-personal-data", history(), NO_ONE);
      expect(found).toContain("-Users-kq7user-Projects-app");
      expect(found).toContain("/Users/kq7user/app");
      expect(found).not.toContain("first commit only");
      expect(found).not.toContain("news/home");
      expect(found).not.toContain("./home/readme");
    });

    it("reads back, once rewritten, every author and committer of every ref, each once", () => {
      const gp7 = item("GP-7");
      const readBack = gp7.split("\n").find((line) => line.startsWith("- Read back the identities")) ?? "";
      expect(readBack).toContain("the command below");
      expect(gp7.indexOf("docs-test=history-identities")).toBeGreaterThan(gp7.indexOf("docs-test=history-rewrite"));
      // A committer that is no commit's author, on a branch that is not checked out, as GitHub commits a merge made on the web.
      const repo = history();
      git(repo, "checkout", "--quiet", "-b", "web");
      commit(repo, { "docs/web.md": "# Web\n" }, "-m", "Web");
      git(repo, "-c", "user.name=Web Committer", "-c", "user.email=web@example.invalid", "commit", "--quiet", "--amend", "--no-edit");
      git(repo, "checkout", "--quiet", "main");
      expect(scan("history-identities", repo, NO_ONE).split("\n").filter((line) => line !== "")).toEqual([
        "Pat <kq7@example.invalid>",
        "Public Author <public@example.invalid>",
        "Web Committer <web@example.invalid>",
      ]);
    });

    it("scans the clone once rewritten, and rewrites what it finds from a fresh clone, messages included", () => {
      const gp7 = item("GP-7");
      const rewrite = gp7.indexOf("docs-test=history-rewrite");
      expect(rewrite).toBeGreaterThan(-1);
      expect(gp7.indexOf("docs-test=history-personal-data")).toBeGreaterThan(rewrite);
      const command = rewriteCommand();
      expect(command).toContain(`--replace-text ${REWRITE}/replace-text.txt`);
      expect(command).toContain(`--replace-message ${REWRITE}/replace-text.txt`);
    });
  });
});

// The rewrite's plan (task 30.9): GP-7 names what the scans of every branch's
// history found, by commit and path and never by value, and gives the one
// `git filter-repo` command of task 30.3, whose files are kept in
// docs/maintainers/history-rewrite/. The mailmap names the public author
// alone; the maintainer's own address is replaced by --email-callback, which
// names no address of theirs. Each line of replace-text.txt, which
// filter-repo reads for --replace-text and --replace-message alike, is a
// pattern that names no personal value: the check applies the rules, as
// filter-repo does with Python's re.sub, to made-up fixtures of each finding's
// form, and to every file of the tree, which they leave as it is.

/** The example ids that stand for the spikes' App, account and installation (packages/testing/test/fixtures/github-app-spike/README.md). */
const EXAMPLE_IDS = new Set(["1000001", "2000001", "3000001"]);

/** filter-repo, as uvx runs it, so that nothing is installed system-wide (design.md, D38 (4)). */
const FILTER_REPO = "uvx --from git-filter-repo git-filter-repo";

/** The rewrite's files, from the root and from the clone's root alike. */
const REWRITE = "docs/maintainers/history-rewrite";

/** The rewrite's command, the block of GP-7 named history-rewrite, as one line. */
function rewriteCommand(): string {
  return (docsCommands(item("GP-7")).find(({ id }) => id === "history-rewrite")?.text ?? "").replace(/\\\n\s*/g, " ");
}

/** One rule of replace-text.txt: a pattern, and its replacement in Python's re.sub form. */
interface Rule {
  line: string;
  pattern: RegExp;
  replacement: string;
}

/** The rules of replace-text.txt, as filter-repo reads them: a line is a rule, split at its last ==>. */
function rules(): Rule[] {
  const text = readFileSync(join(root, REWRITE, "replace-text.txt"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const at = line.lastIndexOf("==>");
      const [pattern, replacement] = at === -1 ? [line, "***REMOVED***"] : [line.slice(0, at), line.slice(at + 3)];
      // A literal rule names the very text it removes; only a pattern can name none.
      expect(pattern.startsWith("regex:"), line).toBe(true);
      return { line, pattern: new RegExp(pattern.slice("regex:".length), "g"), replacement };
    });
}

/** The text with every rule applied in order, a replacement's \1 or \g<1> standing for a group and \n for a newline, as in re.sub. */
function applyRules(text: string): string {
  return rules().reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, (...match: unknown[]) =>
        replacement.replace(/\\(?:g<(\d+)>|(\d+)|n)/g, (_escape, named?: string, numbered?: string) =>
          named === undefined && numbered === undefined ? "\n" : String(match[Number(named ?? numbered)] ?? ""),
        ),
      ),
    text,
  );
}

describe("the rewrite's command and its files", () => {
  /** The public author's no-reply address, as GP-7 names it. */
  const publicAddress = /`[^`<]+<(\d+\+[\w-]+@users\.noreply\.github\.com)>`/.exec(item("GP-7"))?.[1] ?? "";

  it("removes the paths outside the allowlist and maps every identity to the public author, GitHub's own aside", () => {
    expect(publicAddress).not.toBe("");
    const command = rewriteCommand();
    expect(command.startsWith(`${FILTER_REPO} --invert-paths --paths-from-file ../outside.txt `)).toBe(true);
    expect(command).toContain(`--mailmap ${REWRITE}/mailmap`);
    // filter-repo runs the body as def email_callback(email): ..., on bytes.
    expect(command).toContain(`--email-callback 'return email if email == b"noreply@github.com" else b"${publicAddress}"'`);
    expect(command).not.toMatch(/--force\b/);
    for (const [, path] of command.matchAll(/\s(docs\/maintainers\/history-rewrite\/\S+)/g)) expect(existsSync(join(root, path ?? "")), path).toBe(true);
  });

  it("has a mailmap that names the public author alone, by their no-reply address", () => {
    const lines = readFileSync(join(root, REWRITE, "mailmap"), "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => line !== "");
    const author = /`([^`<]+) <\d+\+[\w-]+@users\.noreply\.github\.com>`/.exec(item("GP-7"))?.[1] ?? "";
    expect(lines).toEqual([`${author} <${publicAddress}> <${publicAddress}>`]);
  });

  it("names no personal value in a rule: patterns only, with no address, home folder, user name or identifier", () => {
    const user = /\+([\w-]+)@/.exec(publicAddress)?.[1] ?? "";
    expect(user).not.toBe("");
    for (const { line } of rules()) {
      expect(line, line).not.toMatch(/@/);
      expect(line, line).not.toMatch(/\/(?:Users|home)\/\w|-(?:Users|home)-\w/);
      expect([...line.matchAll(/\d{5,}/g)].map(([number]) => number).filter((number) => !EXAMPLE_IDS.has(number)), line).toEqual([]);
      expect(line, line).not.toMatch(/Iv1\.|Iv23li/);
      expect(line.toLowerCase(), line).not.toContain(user.toLowerCase());
    }
  });

  it("rewrites the form of each finding in a made-up fixture", () => {
    // An agent's scratch folder under a home folder, written with dashes (backup.test.ts, task 21.3); built from parts, so that
    // the rule leaves this file alone.
    const scratch = ["/private/tmp/claude-501", "-Users-kq7user-Projects-Tiehall", "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b", "scratchpad/fix21"].join("/");
    expect(applyRules(`      writeFileSync(\`${scratch}/restore-x.txt\`, out);\n`)).toBe("      writeFileSync(`/tmp/scratchpad/fix21/restore-x.txt`, out);\n");
    // The spikes' GitHub App's name and slug, as the fixtures of the GitHub stub held them; built from parts, so that this file holds neither.
    const name = ["Tiehall", "spike", "localhost"].join(" ");
    const slug = ["tiehall", "spike", "localhost"].join("-");
    expect(applyRules(`"name": "${name}",\n"slug": "${slug}",\n"htmlUrl": "https://github.com/apps/${slug}"\n`)).toBe(
      '"name": "Tiehall example localhost",\n"slug": "tiehall-example-localhost",\n"htmlUrl": "https://github.com/apps/tiehall-example-localhost"\n',
    );
    // The App's id, as the setup gate's test stored it beside the stub's slug.
    expect(applyRules('        id: 1234567,\n        slug: "tiehall-localhost",\n')).toBe('        id: 2000001,\n        slug: "tiehall-localhost",\n');
    // Text that only looks alike stays.
    const alike = 'id: 1234567,\nname: "x"\n/private/tmp/claude-501/-Users-kq7user-Projects-app/out.txt Tiehall spikes localhost\n';
    expect(applyRules(alike)).toBe(alike);
  });

  it("changes no file of the tree, which holds the rewritten values already", () => {
    const changed = trackedTextFiles(root)
      .filter(({ text }) => applyRules(text) !== text)
      .map(({ path }) => path);
    expect(changed).toEqual([]);
  });

  it("names each finding of the scans by its commit and path, and no value", () => {
    const gp7 = item("GP-7");
    for (const path of [
      "tools/image-tests/test/install/backup.test.ts",
      "packages/commands/test/setup-gate.test.ts",
      "packages/testing/test/github-stub-contract.test.ts",
      "spikes/mcp-auth/src/app.js",
    ]) {
      expect(gp7, path).toContain(`\`${path}\``);
    }
    for (const commit of ["b2898ea4", "2af52a9d", "019680b3", "bbaf7edd", "1d7ee604", "6099409f"]) expect(gp7, commit).toContain(`\`${commit}\``);
    for (const branch of ["spike/github-app", "spike/m0-claude-hooks", "spike/m0-mcp-auth"]) expect(gp7, branch).toContain(`\`${branch}\``);
    // No App id, installation id or client id: no number of six or more digits but the public author's user id.
    const numbers = [...checklist.matchAll(/(?<![\w.])\d{6,}(?![\w.])/g)].map(([number]) => number);
    expect(numbers.filter((number) => !publicAddress.startsWith(`${number}+`) && !EXAMPLE_IDS.has(number))).toEqual([]);
    expect(checklist).not.toMatch(/Iv1\.[0-9a-f]|Iv23li/);
  });
});
