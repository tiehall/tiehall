// The size limits on request bodies (public-api: Request bodies have a size
// limit; request-body-limit's design.md, Design rules: Request body limit). A
// request body may be 2 MiB, and the body of a contract.report 16 MiB, because
// it carries classified OpenAPI diffs that can be large. A MiB is 1,048,576
// bytes, and a body of exactly the limit is not refused for its size.
//
// The numbers live beside the command definitions because the OpenAPI
// document, which is generated here, states each operation's limit.
// @tiehall/commands applies them, in the web role's request guard and the
// routes that read bodies, and re-exports them with the rest of what applies
// them (bodyLimitFor, the bounded reader and the refusal).

/** 1,048,576 bytes. */
export const MIB = 1024 * 1024;

/** The limit on every request body, except the one that carries a contract.report. */
export const BODY_LIMIT = 2 * MIB;

/** The limit on a contract.report body. */
export const CONTRACT_REPORT_BODY_LIMIT = 16 * MIB;

/** The operation whose body gets the larger limit. */
export const CONTRACT_REPORT_ID = "contract.report";

/** The limit on the body of the operation with this id. */
export function bodyLimitOf(commandId: string): number {
  return commandId === CONTRACT_REPORT_ID ? CONTRACT_REPORT_BODY_LIMIT : BODY_LIMIT;
}
