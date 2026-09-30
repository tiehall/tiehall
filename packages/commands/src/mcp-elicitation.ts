import { createHash, createHmac } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { canonicalJson, Refusal } from "@tiehall/core";
import { COMMITMENT_KINDS, elicitationMessage, noticeKey, type CommitmentKind } from "@tiehall/packet/notices";
import type { Caller } from "./caller.ts";

// URL-mode elicitation for MCP clients (agent-surfaces: URL-mode elicitation
// for MCP clients; agent-surfaces: Retrying after an elicitation; agent-safety:
// Notices that can reach a model carry only server text; agent-safety: The
// confirm URL never reaches the model; design.md, Technical decisions: T9;
// design.md, Self-hosting decisions: S7). When a client on protocol version
// 2026-07-28 declares URL-mode elicitation (`elicitation.url`) in the client
// capabilities its request carries, a tool call that creates a proposal
// answers with an input-required result instead of the proposal: one
// URL-mode elicitation of the proposal's confirm page on the install,
// TIEHALL_URL/confirm/{proposal}, where a person signed in to the web UI
// confirms or rejects it with the confirmation step. The URL carries the
// proposal's id and nothing else, so no personal data, and opens nothing
// without a web session: a browser without one is sent to sign in. The
// message is the notice template's, which takes only the request key and the
// kind of commitment, so no text anyone wrote can reach a model through it.
// It goes to the client whose call created the proposal and to nobody else.
//
// The result carries a request state, which the client echoes when it retries
// the call once its user has seen the page. It is minted with the SDK's codec,
// HMAC-SHA256 under a key of its own derived from TIEHALL_AUTH_SECRET, so it
// is signed but not encrypted, and holds only ids: the proposal's, and a
// digest of the call (the tool and its arguments), so it answers no other
// call. It is bound to the user the token acts for and to the client, the
// OAuth client's id or, for a personal access token, the token's id, which
// the codec keeps only as a keyed tag. It stays valid 8 days: the proposal's
// 7 days plus one, so a retry after the proposal expired can still say so
// (design.md, Readings to confirm with the founder: R13).

/** How long a request state stays valid after it was issued, in seconds: 8 days. */
export const REQUEST_STATE_TTL_SECONDS = 8 * 24 * 60 * 60;

/** Where the elicitation sits in the input-required result's embedded requests. */
export const CONFIRM_PAGE_INPUT = "confirm_page";

/** What a request state carries: the proposal the call created, and a digest of that call. */
export interface RetryState {
  proposal: string;
  call: string;
}

/** The digest of a tool call: its tool and its arguments, in canonical JSON, so the same call in any key order has the same one. */
export function callDigest(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ tool, arguments: args ?? {} }), "utf8")
    .digest("base64url");
}

/**
 * What a request state is bound to for this caller: the user the token acts
 * for and the client, the OAuth client's id or a personal access token's id;
 * none for a caller that holds no token.
 */
export function retryBinding(caller: Caller): string | undefined {
  if (caller.kind === "oauth_token") return `oauth\0${caller.userId}\0${caller.clientId}`;
  if (caller.kind === "personal_access_token") return `pat\0${caller.userId}\0${caller.tokenId}`;
  return undefined;
}

/** The binding the MCP route put in a call's authInfo, where the codec reads it. */
function bindingIn(context: ServerContext): string {
  const binding = (context.http?.authInfo?.extra as { binding?: unknown } | undefined)?.binding;
  if (typeof binding !== "string" || binding === "") throw new Error("bind");
  return binding;
}

/** A context that carries a binding the way a call's does, for minting or verifying a state outside a call. */
export function bindingContext(binding: string | undefined): ServerContext {
  return { http: { authInfo: { token: "", clientId: "", scopes: [], extra: { binding } } } } as unknown as ServerContext;
}

/** The key that signs request states, apart from every other use of the install's auth secret. */
function stateKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("tiehall mcp request state v1").digest();
}

/** The request states of the install, signed with a key derived from TIEHALL_AUTH_SECRET. */
export function createRetryStates(secret: string): RequestStateCodec<RetryState> {
  return createRequestStateCodec<RetryState>({ key: stateKey(secret), ttlSeconds: REQUEST_STATE_TTL_SECONDS, bind: bindingIn });
}

/** A payload a verified state decoded to, when it has the shape Tiehall mints; undefined otherwise. */
export function retryStateOf(payload: unknown): RetryState | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { proposal, call } = payload as Record<string, unknown>;
  return typeof proposal === "string" && typeof call === "string" ? { proposal, call } : undefined;
}

/** The refusal of a state that is not valid for the call that carries it. */
export function stateRefused(): Refusal {
  return new Refusal("request-state-refused", "The request state is not valid for this call: it was changed, has expired, or belongs to another user, client or call.");
}

/** Whether the request, on protocol version 2026-07-28, declares URL-mode elicitation in its client capabilities. */
export function declaresUrlElicitation(era: "legacy" | "modern", context: ServerContext): boolean {
  if (era !== "modern") return false;
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { url?: unknown } } | undefined;
  return capabilities?.elicitation?.url !== undefined && capabilities.elicitation.url !== null;
}

/** A proposal as the elicitation names it: its id, its request's key and its kind. */
export interface ElicitedProposal {
  id: string;
  request: { key: string };
  kind: string;
}

/** The input-required result for a proposal a call created: the URL-mode elicitation of its confirm page, and the state of the retry. */
export function confirmPageElicitation(installUrl: string, proposal: ElicitedProposal, state: string): InputRequiredResult {
  if (!(COMMITMENT_KINDS as readonly string[]).includes(proposal.kind)) throw new Error("A proposal's kind is one of the kinds of commitment.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposal.id)) throw new Error("A proposal's id is a UUID.");
  const url = `${new URL(installUrl).origin}/confirm/${proposal.id}`;
  const message = elicitationMessage({ key: noticeKey(proposal.request.key), commitment: proposal.kind as CommitmentKind });
  return inputRequired({ inputRequests: { [CONFIRM_PAGE_INPUT]: inputRequired.elicitUrl({ message, url }) }, requestState: state });
}
