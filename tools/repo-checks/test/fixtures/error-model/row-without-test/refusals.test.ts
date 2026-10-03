// A fixture of the error model's test coverage check, never run: a test file whose test shows the refusal of every
// row of the error model but conflict, by naming their problem types:
// problems/route-not-found problems/record-not-found problems/setup-required problems/shutting-down
// problems/invalid-input problems/outside-settings problems/upgrade-required problems/forbidden
// problems/sign-in-refused problems/personal-access-tokens-off problems/confirmation-required problems/removed-member
// problems/request-state-refused problems/invalid-token problems/ci-caller-refused problems/needs-human
// problems/payload-too-large problems/if-match-required problems/rate-limited problems/integration-unavailable
// problems/unauthenticated problems/insufficient-scope problems/precondition-failed problems/idempotency-key-reused
import { it } from "vitest";

it("refuses on each row but one", () => {});
