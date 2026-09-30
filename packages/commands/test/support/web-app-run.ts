import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";

// Vitest global setup: one id per run of this project, by which the test files
// that start the web app (web-app.ts) build it once per run between them,
// whichever of them gets there first, and never twice at once.
export default function setup(project: TestProject): void {
  project.provide("webAppRun", randomUUID());
}

declare module "vitest" {
  export interface ProvidedContext {
    webAppRun: string;
  }
}
