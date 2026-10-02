import { z } from "zod";
import { defineCommand } from "./command.ts";
import { GITHUB_REPOSITORY } from "./pull-requests.ts";
import { teamRef } from "./requests.ts";
import { user } from "./schemas.ts";

// The APIs registered for contract reports (contract-changes: Admins register
// APIs, each bound to one repository; teams-and-roles: What admins and
// members may do; agent-safety: Actions that need the confirmation step;
// agent-surfaces: Admin actions and trust changes are on no agent surface;
// design.md, Decisions this change rests on: D28 #4, #44; design.md, Readings
// to confirm with the founder: R19). An admin registers an API in the web UI,
// with the confirmation step, so no agent surface offers it: by its name, such
// as payments-api, which the contract reports and the packet's contract
// section name it by, for one provider team, bound to one GitHub repository
// that a connected installation of the install's GitHub App covers, and, if
// the admin names one, to one workflow, by the job_workflow_ref of the runs
// that may report for it. A repository that no connected installation covers
// gets 409, as a name that another API has does. The admin page lists the
// registered APIs, to admins only.

/** An API's name: 1 to 100 lower-case letters, digits, dots, hyphens and underscores, starting with a letter or digit, such as payments-api. */
export const API_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const apiName = z
  .string()
  .regex(API_NAME, "An API's name has 1 to 100 lower-case letters, digits, dots, hyphens and underscores, and starts with a letter or digit, such as payments-api.")
  .meta({ description: "The API's name, such as payments-api." });

/**
 * A workflow's job_workflow_ref, as GitHub Actions names it in the OIDC token
 * of a run: the repository that holds the workflow file, the file's path under
 * .github/workflows, and the ref it ran from, such as
 * acme/payments/.github/workflows/contract.yml@refs/heads/main. The workflow
 * may live in another repository than the API's, as a reusable workflow does.
 */
export const JOB_WORKFLOW_REF = new RegExp(`^${GITHUB_REPOSITORY.source.slice(1, -1)}/\\.github/workflows/[^@\\s]+\\.ya?ml@\\S+$`);

export const jobWorkflowRef = z
  .string()
  .max(1024)
  .regex(JOB_WORKFLOW_REF, "A workflow is named by its job_workflow_ref, such as acme/payments/.github/workflows/contract.yml@refs/heads/main.")
  .meta({ description: "The one workflow whose runs may report for the API, such as acme/payments/.github/workflows/contract.yml@refs/heads/main." });

/** A repository on GitHub.com, as owner/name, such as acme/payments. */
const repository = z
  .string()
  .max(200)
  .regex(GITHUB_REPOSITORY, "A repository is named as owner/name, such as acme/payments.")
  .meta({ description: "The GitHub repository whose CI runs report for the API, as owner/name, such as acme/payments." });

/** A registered API, as an admin sees it. */
export const registeredApi = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: teamRef,
  /** The repository, as owner/name, as GitHub named it when the API was registered. */
  repository: z.string(),
  /** The workflow whose runs alone may report for it; null for any workflow of its repository. */
  jobWorkflowRef: z.string().nullable(),
  registeredAt: z.iso.datetime(),
  registeredBy: user,
});

export const registerApi = defineCommand({
  id: "apis.register",
  summary:
    "Register an API for contract reports, for one provider team, bound to one GitHub repository that a connected installation covers, and, if named, to one workflow of it.",
  input: z.object({
    name: apiName,
    team: z.uuid().meta({ description: "The provider team, which the API is registered to." }),
    repository,
    jobWorkflowRef: jobWorkflowRef.optional(),
  }),
  output: z.object({ api: registeredApi }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "apis",
  surfaces: [],
  stability: "beta",
});

export const listApis = defineCommand({
  id: "apis.list",
  summary: "List the registered APIs, each with its provider team, the repository it is bound to and its workflow, if any.",
  input: z.object({}),
  output: z.object({ apis: z.array(registeredApi) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "apis",
  surfaces: [],
  stability: "beta",
});

export const API_COMMANDS = [registerApi, listApis];
