import { compareVersions } from "@tiehall/core";
import type { Changelog } from "@tiehall/catalog/changelog";

// contract.report's own CLI floor rises only with 180 days' notice in the API
// changelog (public-api: `contract.report` has its own version floor;
// design.md, Design rules: Public API). Companies' CI runs the CLI version the
// contract Action pins, so a floor that rises refuses their reports from then
// on: the rise needs an entry of openapi/changelog.json about contract.report
// that names the new floor and is dated at least 180 days before it.

/** How many days the notice before a rise of the floor runs, at the least. */
export const FLOOR_NOTICE_DAYS = 180;

/** The name of the floor in packages/core/src/client-versions.ts. */
const FLOOR_NAME = "MINIMUM_CONTRACT_REPORT_CLI_VERSION";

/** The floor a source of client-versions.ts sets, or undefined when it sets none. */
export function floorOf(source: string): string | undefined {
  return new RegExp(`\\b${FLOOR_NAME}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar day, in UTC, as the changelog writes it: 2026-11-02. */
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Every way a change of the floor from `baseFloor` to `floor` breaks the
 * notice rule, as a sentence; none when it stays, falls, or rises with an
 * entry about contract.report, among the unreleased ones or a release's, that
 * names the new floor and is dated FLOOR_NOTICE_DAYS or more before `today`.
 */
export function floorRiseProblems(input: { baseFloor: string; floor: string; changelog: Changelog; today: Date }): string[] {
  const { baseFloor, floor, changelog, today } = input;
  if (compareVersions(floor, baseFloor) <= 0) return [];
  const latest = dayOf(new Date(today.getTime() - FLOOR_NOTICE_DAYS * DAY_MS));
  const entries = [...changelog.unreleased, ...changelog.releases.flatMap(({ entries }) => entries)];
  const noticed = entries.some(({ date, text, operationIds }) => (operationIds ?? []).includes("contract.report") && text.includes(floor) && date <= latest);
  if (noticed) return [];
  return [
    `${FLOOR_NAME} rises from ${baseFloor} to ${floor}, but openapi/changelog.json gives no notice of it about contract.report, naming ${floor}, dated ${latest} or earlier: ${FLOOR_NOTICE_DAYS} days before the floor rises.`,
  ];
}
