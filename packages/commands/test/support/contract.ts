import { readFileSync } from "node:fs";

// The classified changes of the recorded oasdiff outputs (task 23.1) for the
// contract tests: the changelog the pinned oasdiff wrote for a fixture pair of
// actions/contract/test/fixtures/oasdiff, as a contract report and an attached
// diff carry it: each change's engine id, its level, and the operation it
// touches, or the section of the document for a change that touches none, as
// `tiehall contract report` and `tiehall contract diff` read the changelog.

/** The fixture pairs: ERR, WARN and INFO changes; WARN and INFO; INFO alone; none. */
export type OasdiffPair = "breaking" | "warning" | "informational" | "unchanged";

/** A change as reports and contract sections carry it. */
export interface ClassifiedChange {
  id: string;
  level: "ERR" | "WARN" | "INFO";
  operation: string;
}

const LEVELS: Readonly<Record<number, ClassifiedChange["level"]>> = { 3: "ERR", 2: "WARN", 1: "INFO" };

/** The recorded changelog of a fixture pair, as oasdiff wrote it. */
export function recordedChangelog(pair: OasdiffPair): string {
  return readFileSync(new URL(`../../../../actions/contract/test/fixtures/oasdiff/${pair}/changelog.json`, import.meta.url), "utf8");
}

/** The classified changes of a fixture pair's recorded changelog. */
export function changesOf(pair: OasdiffPair): ClassifiedChange[] {
  const changelog = JSON.parse(recordedChangelog(pair)) as { id: string; level: number; operation?: string; path?: string; section?: string }[];
  return changelog.map(({ id, level, operation, path, section }) => ({
    id,
    level: LEVELS[level] ?? "INFO",
    operation: operation !== undefined && path !== undefined ? `${operation} ${path}` : (path ?? (section !== undefined ? `the ${section} section` : "the document")),
  }));
}
