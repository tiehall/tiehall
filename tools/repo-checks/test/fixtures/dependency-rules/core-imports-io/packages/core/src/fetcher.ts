// Fixture: an HTTP client library in packages/core.
import { fetch } from "undici";

export const get: typeof fetch = fetch;
