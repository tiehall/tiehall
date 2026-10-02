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
// admin turns on mirroring on open for the team. Mappings are not security
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
 * writes.
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
      closedBy: trackerAccount.nullable(),
    }),
  }),
  output: z.object({
    changes: z.array(z.enum(["closed", "reopened", "assignees_changed"])).meta({ description: "The changes the read showed that Tiehall did not write itself." }),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const MIRROR_COMMANDS = [listTrackerMappings, mapIntakeRepository, setMirrorOnOpen, removeTrackerMapping, recordTrackerChange];
