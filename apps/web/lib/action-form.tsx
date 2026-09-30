"use client";

import { useActionState, type ReactNode } from "react";
import type { RequestPageAction, RequestPageActionState } from "@tiehall/commands/web";
import { requestPageAction } from "./request-actions.ts";

// A form of a request's page, which runs its action through the page's server
// action (request-actions.ts) and shows what came of it: the refusal, with
// its status, title and detail, as /api/v1 gives it for the same call, and,
// for an action that made a proposal, a link to the proposal's confirm page.
// The form works without the page's scripts too: the browser then posts it,
// and the page it gets back shows the same.

export interface ActionFormProps {
  requestKey: string;
  action: RequestPageAction;
  csrf: string;
  button: string;
  children?: ReactNode;
}

/** The refusal an action got, in the words of its problem. */
function Refused({ state }: { state: Extract<RequestPageActionState, { ok: false }> }): ReactNode {
  const { status, title, detail, errors } = state.problem;
  return (
    <div role="alert">
      <p>{`Refused with ${status} (${title}): ${detail}`}</p>
      {errors === undefined || errors.length === 0 ? null : (
        <ul>
          {errors.map(({ path, message }, index) => (
            <li key={index}>{path.length === 0 ? message : `${path.join(".")}: ${message}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ActionForm({ requestKey, action, csrf, button, children }: ActionFormProps): ReactNode {
  const [state, formAction, pending] = useActionState(requestPageAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="key" value={requestKey} />
      <input type="hidden" name="action" value={action} />
      {children}
      <button type="submit" disabled={pending}>
        {button}
      </button>
      {state === null || state.ok ? null : <Refused state={state} />}
      {state !== null && state.ok && state.proposal !== undefined ? (
        <p role="status">
          It waits as a proposal. <a href={`/confirm/${state.proposal.id}`}>Review it, then confirm or reject it</a>
        </p>
      ) : null}
    </form>
  );
}
