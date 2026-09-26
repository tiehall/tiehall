// CI check for activity-log: Which actions are security events. It fails when
// tools/repo-checks/security-events.json does not mirror the spec's list,
// when an action that a finished task built names no security event with the
// test that shows the action appending that event together with its change,
// when that test does not exist or does not run, and when a security event
// type is defined that no action of the list names. `pnpm test` runs the
// named tests; this check makes sure each built action has one.
// Usage: node tools/repo-checks/src/check-security-events.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { EVENT_TYPES } from "@tiehall/core";
import {
  builtActions,
  readSecurityEventInputs,
  REQUIREMENT,
  SECURITY_EVENT_LIST,
  securityEventCoverageProblems,
  type SecurityEventList,
} from "./security-event-coverage.ts";

const root = resolve(process.argv[2] ?? ".");
const inputs = readSecurityEventInputs(root, EVENT_TYPES);
const problems = securityEventCoverageProblems(inputs);

if (problems.length === 0) {
  const list = inputs.list as SecurityEventList;
  const actions = list.items.flatMap(({ actions }) => actions).length;
  console.log(
    `${SECURITY_EVENT_LIST} mirrors the ${list.items.length} items of ${REQUIREMENT}: ${actions} actions, ` +
      `${builtActions(list).length} built with their security events and the tests that show them appended, ` +
      "the rest waiting for the tasks that build them.",
  );
} else {
  for (const problem of problems) console.error(problem);
  console.error(
    `\nEvery action Tiehall records a security event for is listed in ${SECURITY_EVENT_LIST}, and a task that builds one ` +
      "names its security event there, with the test that shows the action appending it together with its change, before it is checked off.",
  );
  process.exitCode = 1;
}
