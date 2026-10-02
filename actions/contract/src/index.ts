// @tiehall/contract-action: the contract Action, which runs the pinned oasdiff
// in the provider's CI and reports the classified changes to Tiehall with the
// pinned tiehall CLI (contract-changes: The contract Action). The runner starts
// src/main.ts; `runAction()` runs it with a runtime of the caller's own.

export { CLI_PIN, REPORTED_TYPES, runAction, type ActionRuntime, type ExecResult } from "./action.ts";
export { OASDIFF } from "./oasdiff.ts";
