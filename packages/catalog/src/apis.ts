import { z } from "zod";
import { defineCommand } from "./command.ts";
import { GITHUB_REPOSITORY } from "./pull-requests.ts";
import { teamRef } from "./requests.ts";
import { teamKey } from "./teams.ts";
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
// gets 409, as a name that another registered API has does. The admin page
// lists the registered APIs, to admins only.
//
// An admin unregisters an API with no confirmation step, because that only
// stops its reports (contract-changes: Admins unregister APIs; design.md,
// Self-hosting decisions: S6): it then takes no report, and the declarations
// that teams consume it route nothing, while the requests its reports opened
// stay as they are. Registering it again, by its name, is how its provider
// team, repository or workflow changes: the API keeps its id, and the teams'
// declarations route again.

/** An API's name: 1 to 100 lower-case letters, digits, dots, hyphens and underscores, starting with a letter or digit, such as payments-api. */
export const API_NAME = /^[a-z0-9][a-z0-9\._-]{0,99}$/;

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

export const unregisterApi = defineCommand({
  id: "apis.unregister",
  summary:
    "Unregister an API, so that it takes no more contract reports and the declarations that teams consume it route nothing; the requests its reports opened stay as they are.",
  input: z.object({ api: z.uuid().meta({ description: "The API to unregister." }) }),
  output: z.object({ api: z.uuid(), unregistered: z.literal(true) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "apis",
  surfaces: [],
  stability: "beta",
});

// The consumer map (contract-changes: Teams declare the APIs they consume;
// teams-and-roles: What admins and members may do; design.md, Decisions this
// change rests on: D15, D28 #4, #72). Each declaration states that one team
// consumes one registered API. Any member of the team declares it, in the web
// UI on the team's page, which records who declared it and when it was last
// confirmed; any member of the team removes it. Someone who is not a member of
// that team, whatever their role, gets 403: an admin who is in no team
// declares nothing for one. A declaration made again changes nothing. No agent
// surface offers them; routing reads the declarations alone.

/**
 * A team's declaration that it consumes an API: who declared it and when, when
 * it was last confirmed, and whether it is stale, unconfirmed for 120 days
 * since then (contract-changes: Declarations are re-confirmed every 90 days).
 */
export const consumerDeclaration = z.object({
  declaredBy: user,
  declaredAt: z.iso.datetime(),
  lastConfirmedAt: z.iso.datetime(),
  /** Unconfirmed 120 days after its last confirmation: it keeps routing like any other declaration until it is re-confirmed. */
  stale: z.boolean(),
});

/** The API and the team a declaration is about, by their ids. */
const declarationInput = z.object({
  api: z.uuid().meta({ description: "The registered API." }),
  team: z.uuid().meta({ description: "The team that consumes it." }),
});

export const declareConsumer = defineCommand({
  id: "apis.declare_consumer",
  summary: "Declare that a team you are a member of consumes a registered API, so that breaking changes to it open requests to the team.",
  input: declarationInput,
  output: z.object({
    declaration: consumerDeclaration.extend({ api: z.object({ id: z.uuid(), name: z.string() }), team: teamRef }),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const removeConsumer = defineCommand({
  id: "apis.remove_consumer",
  summary: "Remove the declaration that a team you are a member of consumes an API, so that changes to it no longer route to the team.",
  input: declarationInput,
  output: z.object({ api: z.uuid(), team: z.uuid(), declared: z.literal(false) }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const listTeamApis = defineCommand({
  id: "apis.list_for_team",
  summary: "List the registered APIs, each with its provider team and the team's declaration that it consumes it, if any, as the team's page shows them.",
  input: z.object({ team: teamKey.meta({ description: "The team's key, such as FE, or one it had before." }) }),
  output: z.object({
    team: teamRef,
    /** Whether the reader is a member of the team, and so may declare and remove its declarations. */
    member: z.boolean(),
    apis: z.array(
      z.object({
        id: z.uuid(),
        provider: teamRef,
        declaration: consumerDeclaration.nullable(),
        untrusted: z.object({ name: z.string() }),
      }),
    ),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

// Re-confirmation (contract-changes: Declarations are re-confirmed every 90
// days): any member of the consuming team re-confirms a declaration, which
// moves its last confirmation to now, keeps its declarer, and clears the
// request to re-confirm it and its stale mark; anyone else gets 403.

export const reconfirmConsumer = defineCommand({
  id: "apis.reconfirm_consumer",
  summary: "Re-confirm that a team you are a member of still consumes an API it declared, which moves the declaration's last confirmation to now.",
  input: declarationInput,
  output: z.object({
    declaration: consumerDeclaration.extend({ api: z.object({ id: z.uuid(), name: z.string() }), team: teamRef }),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const API_COMMANDS = [registerApi, listApis, unregisterApi, declareConsumer, removeConsumer, listTeamApis, reconfirmConsumer];
