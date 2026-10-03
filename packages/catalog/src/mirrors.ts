import { z } from "zod";
import { defineCommand } from "./command.ts";
import { GITHUB_REPOSITORY } from "./schemas.ts";

// The teams' tracker mappings (tracker-mirrors: Each team maps to one
// tracker; tracker-mirrors: Mirror issues are created on claim by default;
// design.md, Decisions this change rests on: D28 #4, #81; design.md, Design
// rules: Tracker mirrors). Only admins set them, in the web UI: they are admin
// actions, internal commands that no agent surface offers. A team maps one
// tracker, and one place in it, or none: for GitHub Issues, its intake
// repository, which a connected installation of the install's GitHub App must
// cover; a team that maps one gets 409 when it is asked to map a second, and
// an admin removes the first. A mapping starts with mirroring on claim: a
// request's mirror issue is created when the request is claimed, unless an
// admin turns on mirroring on open for the team. It also starts with the
// setting for tracker "Done" proposals off: a close of a mirror issue then
// only adds a notice to the request's thread, until an admin turns it on
// (tracker-mirrors: A tracker "Done" never closes a request by itself).
// Mappings are not security
// events (design.md, Readings to confirm with the founder: R21) and change no
// request, so they record no event.

/** The trackers a team can map. */
export const TRACKER_NAMES = ["github", "jira"] as const;

/** A team's mapping, as the mapping operations return it. */
export const trackerMapping = z.object({
  teamId: z.uuid(),
  tracker: z.enum(TRACKER_NAMES),
  /** Where the team's mirror issues are created, as it is shown: for GitHub, the intake repository's owner/name. */
  place: z.string().meta({ description: "Where the team's mirror issues are created: for GitHub Issues, the intake repository, as owner/name." }),
  mirrorOnOpen: z.boolean().meta({ description: "Whether a request's mirror issue is created when it is opened, rather than when it is claimed." }),
  doneProposals: z.boolean().meta({ description: "Whether a close of a mirror issue by a member of the team becomes a done proposal for them, which they confirm." }),
});

export const listTrackerMappings = defineCommand({
  id: "mirrors.list_mappings",
  summary: "List the teams' tracker mappings, and the repositories a team can map as its intake repository.",
  input: z.object({}),
  output: z.object({
    mappings: z.array(trackerMapping),
    repositories: z.array(z.string()).meta({ description: "The repositories that connected installations of the install's GitHub App cover, as owner/name." }),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const mapIntakeRepository = defineCommand({
  id: "mirrors.map_repository",
  summary: "Map a team to an intake repository, in which its requests' GitHub mirror issues are created.",
  input: z.object({
    teamId: z.uuid(),
    repository: z.string().regex(GITHUB_REPOSITORY).meta({ description: "The intake repository, as owner/name; a connected installation must cover it." }),
    mirrorOnOpen: z.boolean().default(false),
  }),
  output: trackerMapping,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const setMirrorOnOpen = defineCommand({
  id: "mirrors.set_mirror_on_open",
  summary: "Turn mirroring on open on or off for a team: on, a request's mirror issue is created when it is opened; off, when it is claimed.",
  input: z.object({ teamId: z.uuid(), on: z.boolean() }),
  output: trackerMapping,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const setDoneProposals = defineCommand({
  id: "mirrors.set_done_proposals",
  summary: "Turn the setting for tracker \"Done\" proposals on or off for a team: on, a close of a mirror issue by a member of the team becomes a done proposal they confirm; off, it only adds a notice.",
  input: z.object({ teamId: z.uuid(), on: z.boolean() }),
  output: trackerMapping,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

export const removeTrackerMapping = defineCommand({
  id: "mirrors.remove_mapping",
  summary: "Remove a team's tracker mapping, so its requests get no new mirror issue.",
  input: z.object({ teamId: z.uuid() }),
  output: z.object({ teamId: z.uuid() }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "integrations",
  surfaces: [],
  stability: "beta",
});

/** An account in a tracker, by the tracker's own id and the name it shows. */
const trackerAccount = z.object({ id: z.string().min(1).max(100), login: z.string().min(1).max(100) });

/**
 * What a mirror issue shows now, read from its tracker by the processing of a
 * tracker's change (tracker-mirrors: Mirror writes are idempotent and never
 * echo; tracker-mirrors: Inbound tracker changes are recorded, not applied).
 * Only a verified integration event runs it: it records the changes the read
 * shows that Tiehall did not make itself, and drops the echoes of its own
 * writes; a tracker "Done" by a member of the target team, with the team's
 * setting on, becomes a done proposal for them.
 */
export const recordTrackerChange = defineCommand({
  id: "mirrors.record_tracker_change",
  summary: "Record what a mirror issue shows now, as read from its tracker: a close, a reopen or new assignees that Tiehall did not write.",
  input: z.object({
    mirrorId: z.uuid(),
    issue: z.object({
      open: z.boolean(),
      closeReason: z.enum(["completed", "not_planned", "duplicate"]).nullable(),
      assignees: z.array(trackerAccount).max(100),
    }),
    by: trackerAccount.nullable().meta({
      description:
        "The tracker account that made the changes recorded, as the tracker names it: who closed the issue, for its close, or who made the change the tracker's notice is about, for a reopen or new assignees; null when the tracker names none.",
    }),
    stateByOther: z.boolean().meta({
      description:
        "Whether the tracker names an account other than Tiehall's own as the one that made the issue's state, such as a person who closed it: a close or reopen that account made is no echo of a write of Tiehall's, even one Tiehall began and the tracker never applied. A change of the close reason alone is not told apart this way, since the tracker keeps naming whoever closed the issue.",
    }),
    only: z
      .enum(["state", "assignees"])
      .optional()
      .meta({
        description:
          "The one part of the read to record, when its parts were made by different accounts: whether the issue is open or closed, or its assignees; the other part is not compared. Both when left out.",
      }),
    writesSeen: z
      .number()
      .int()
      .min(0)
      .meta({
        description:
          "How many writes of the issue's state Tiehall had begun or ended, as the mirror counts them, when the read began: a read recorded after the count changed may show the issue as it was before Tiehall's write, so its open or closed state is not compared.",
      }),
  }),
  output: z.object({
    changes: z.array(z.enum(["closed", "reopened", "assignees_changed"])).meta({ description: "The changes the read showed that Tiehall did not write itself." }),
  }),
  scopes: [],
  // A tracker "Done" by a member of the target team, with the team's setting on, becomes a done proposal for them.
  commitment: true,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

/**
 * Retry for a request's mirror job that used up its attempts and moved to the
 * dead-letter queue (tracker-mirrors: Failed mirror jobs are shown with a
 * Retry button): the job runs again, and the banner about it goes once a
 * mirror job of the request succeeds. The admins and the members of the
 * request's target team, who see the banner, may press it, in the web UI.
 */
export const retryMirrorJob = defineCommand({
  id: "mirrors.retry_job",
  summary: "Run again a request's mirror job that failed until it moved to the dead-letter queue.",
  input: z.object({ requestId: z.uuid() }),
  output: z.object({ requestId: z.uuid() }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const MIRROR_COMMANDS = [listTrackerMappings, mapIntakeRepository, setMirrorOnOpen, setDoneProposals, removeTrackerMapping, recordTrackerChange, retryMirrorJob];
