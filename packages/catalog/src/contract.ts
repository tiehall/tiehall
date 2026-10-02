import { z } from "zod";
import { API_NAME, apiName } from "./apis.ts";
import { CONTRACT_REPORT_ID } from "./body-limits.ts";
import { defineCommand } from "./command.ts";
import { CHANGE_LEVELS } from "./packet.ts";

// contract.report, the one way contract changes reach Tiehall
// (contract-changes: One report operation that never takes a whole spec;
// contract-changes: Admins register APIs, each bound to one repository;
// agent-access: CI authenticates with GitHub Actions OIDC bound to registered
// repositories; agent-access: OAuth scopes are coarse; public-api: Each
// operation carries a stability level; design.md, Design rules: Contract
// changes; design.md, Technical decisions: T12). The contract Action computes
// the classified diff in the provider's CI and reports it, with a pinned
// `tiehall contract report`, for one registered API: the provider pull
// request, by its number in the repository the API is bound to, which is the
// run's own; the base and head refs with their commit SHAs; the diff engine's
// name and version; and the engine's classified changes, each with the
// engine's id for it, its level (ERR, WARN or INFO) and the operation it
// touches. That is all a report holds: its input is strict, at every level, so
// it has no field for an OpenAPI document and a body with any field it does
// not know is refused with 400, and Tiehall never receives or parses a spec.
// It accepts the CI caller alone, authenticated with its run's GitHub Actions
// OIDC token, and a report only for an API registered to the run's repository
// and, for an API bound to a workflow, from that workflow; every other caller,
// a personal access token or an OAuth token with every scope included, gets
// 403. It is offered on REST and the CLI, and is stable from its first
// release, because pinned Actions in companies' repositories call it: its
// shape only gains, and a breaking change waits 180 days or goes to a new
// major version. Its body may be 16 MiB, the larger limit that classified
// diffs need (body-limits.ts).

/** Text of a report: 1 to max characters, not all blank, kept exactly as sent. */
function text(max: number) {
  return z.string().min(1).max(max).regex(/\S/, "The text is not blank.");
}

/** The most classified changes one report carries, as many as a packet's contract section holds. */
export const REPORT_CHANGES_MAX = 1000;

/** A branch or tag with its commit. */
const gitRef = z.strictObject({
  ref: text(255).meta({ description: "The branch or tag, such as main." }),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "A commit sha is 40 or 64 lower-case hex digits.")
    .meta({ description: "The full commit sha." }),
});

/** One change, as the diff engine classified it. */
const classifiedChange = z.strictObject({
  id: text(200).meta({ description: "The diff engine's id for the kind of change, such as response-property-removed." }),
  level: z.enum(CHANGE_LEVELS).meta({ description: "ERR for a breaking change, WARN for a potentially breaking one, INFO for any other." }),
  operation: text(1000).meta({ description: "The operation the change touches, such as GET /payments/{id}." }),
});

export const reportContractChanges = defineCommand({
  id: CONTRACT_REPORT_ID,
  summary:
    "Report the classified changes that a provider pull request makes to a registered API, from a CI run of the contract Action in the API's repository, authenticated with the run's GitHub Actions OIDC token; it takes no OpenAPI document.",
  input: z.strictObject({
    api: apiName.meta({ description: "The registered API the changes are to, such as payments-api." }),
    pullRequest: z
      .strictObject({ number: z.int().min(1).max(2_147_483_647).meta({ description: "The pull request's number, such as 310." }) })
      .meta({ description: "The provider pull request that makes the changes, in the repository the API is registered to, which is the run's own." }),
    base: gitRef.meta({ description: "The ref and commit the changes are compared against: the pull request's base." }),
    head: gitRef.meta({ description: "The ref and commit that make the changes: the pull request's head." }),
    engine: z
      .strictObject({
        name: text(100).meta({ description: "The diff engine's name, such as oasdiff." }),
        version: text(100).meta({ description: "The diff engine's version, such as 1.32.1." }),
      })
      .meta({ description: "The diff engine that classified the changes." }),
    changes: z
      .array(classifiedChange)
      .max(REPORT_CHANGES_MAX)
      .meta({ description: `The classified changes, each with the engine's id for it, its level and its operation; at most ${REPORT_CHANGES_MAX}, and none when the pull request changes nothing of the API.` }),
  }),
  output: z.object({
    id: z.uuid().meta({ description: "The report's id." }),
    api: z.string().regex(API_NAME).meta({ description: "The registered API the report is for." }),
    receivedAt: z.iso.datetime().meta({ description: "When Tiehall accepted the report." }),
  }),
  method: "POST",
  path: "/api/v1/contract-reports",
  scopes: ["contracts:report"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "cli"],
  cli: [{ command: "contract report" }],
  stability: "stable",
});

export const CONTRACT_COMMANDS = [reportContractChanges];
