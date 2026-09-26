import { afterAll, expect } from "vitest";

// A Vitest setup file for the projects that use Postgres. A test file fails
// when pg warns that it was used in a way its next major version removes, such
// as a query sent on a client that is still running another one. That use
// works today and breaks on the upgrade to pg 9, so it is caught now. A
// package opts in by listing this file under `setupFiles` in its
// vitest.config.ts.

const removedInPg9: string[] = [];

function onWarning(warning: Error): void {
  if (warning.name === "DeprecationWarning" && warning.message.includes("will be removed in pg@9")) {
    removedInPg9.push(warning.message);
  }
}

process.on("warning", onWarning);

afterAll(() => {
  process.off("warning", onWarning);
  expect(removedInPg9, "uses of pg that pg 9 removes").toEqual([]);
});
