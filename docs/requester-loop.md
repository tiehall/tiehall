# The requester loop

Once a request is open, its questions, answers and changes have to reach the people on both sides, and their agents, without anyone pasting text between tools. This page covers how news on your requests reaches you and your agent, how commitments wait for a person to confirm them, and the email the install sends.

## Pull is the contract

Every update can be pulled, at any time, from three readers:

- `whats_new`, the MCP tool, for agents;
- `tiehall updates`, the CLI command, which runs the same operation;
- the update feed of your web inbox, at `/inbox`.

Your updates are the events on the requests you opened, claimed or are accountable for, and the new requests addressed to your teams; the web inbox's feed also holds the events on the requests your teams opened. What you did yourself is not news to you: `whats_new`, `tiehall updates` and the wait leave out what any of your agents did, through MCP, the CLI or a personal access token, and keep what you did in the web UI, such as confirming your agent's proposal or answering a question, so that your agent hears of it; the web inbox's feed and the daily digest leave out everything you did. Each reader keeps its own place, per person and per client, and nothing moves until you acknowledge: a reader passes the number of the last update it handled, and its next read starts after it. So an update your agent read but did not handle is still there next time, and acknowledging in one reader leaves the others as they were.

Push only makes delivery faster; nothing reaches you only by push. A client may wait for news with the long-poll endpoint `GET /api/v1/events/wait`, which takes a `cursor` and answers as soon as an update exists after it, or after at most 60 seconds with an empty list. Its answer holds only ids and the install's own words, each update's number, kind, request key, team and request URL, and the reader then pulls the content. While the app restarts for an upgrade, the wait ends with 503 and `Retry-After: 0`, and clients retry.

In Claude Code, the plugin's hooks show what is new when a session starts and wake Claude when news arrives, as [The Claude Code plugin](claude-code-plugin.md#the-hooks) describes. In other clients, the Tiehall skill has the agent call `whats_new` at the start of each session.

## The web inbox

Your web inbox, at `/inbox`, has two parts. The update feed holds your updates, as above, said in the install's own words with a link to each request, and a form that acknowledges what the page shows. The standing list holds what stays until it is dealt with, whatever you acknowledged:

- each proposal that waits for a confirmation you may give, with a link to its confirm page and a form that rejects it;
- the receipts of your confirmations and undos, each with its undo link while the commitment can still be undone;
- the reminders that your personal access tokens expire soon;
- for each of your teams, its daily digest of potentially breaking API changes, and its requests to re-confirm the APIs it consumes, as [Contract changes](contract-changes.md#the-consumer-map) describes.

## Questions and answers

Each request has one thread, where both sides post comments, questions and answers. A blocking question moves the request to `needs_info` until every blocking question has an answer, and then back to the state it had; an answer names the question it answers. Only the requester's side and the members of the target team post on a request. When agents flip a request between `in_progress` and `needs_info` three times in a UTC day, the next blocking question an agent posts is posted as a non-blocking one, with a notice, so that two agents cannot hold a request in a loop.

## Commitments and the confirmation step

Some changes bind a person or a team, and agents only propose them: a due date set or changed after the request was opened, a change to its scope (the need, the acceptance criteria or the contract section) after it was claimed, a decline, a reassignment to another team, a withdrawal, and marking it done without a merged pull request. Each becomes a proposal, which takes effect once the people it needs have confirmed it in the web UI, signed in with their web session, on its confirm page. The page reaches you through the standing list of your web inbox, through email when the install sends it, or through your MCP client when it shows a URL-mode elicitation; it never reaches your agent.

- A due date needs a person on each side: the proposal's accountable human first, then someone on the other side, a member of the target team or a person of the requesting side. A scope change while the request is claimed needs the claimant too. Every other commitment needs one confirmation.
- The accountable human can reject a proposal, and its proposer can withdraw it; neither needs the confirmation step. A proposal expires 7 days after it was made, and ends when the request reaches a final state.
- Every confirmation gets a receipt. A due date, a scope change, a reassignment and a decline can be undone for 15 minutes after they take effect, from the receipt, with the same step.
- Your agent learns the outcome through `whats_new`: the confirmations, and how a proposal ended when it ended without taking effect.

What the step cannot prove: An agent that drives your own signed-in browser can click confirm on a review page, and can post a message from the web UI that clears a request's `needs_human` flag. Do not give a browser-driving agent a browser profile that is signed in to Tiehall. Receipts, the undo window and keeping the confirm URL away from models reduce this risk; they do not remove it. [Security and trust](security-and-trust.md#what-the-confirmation-step-does-not-prove) says more.

## Email

The install sends email only when its operator has set the SMTP settings in `.env`; without them, every notice still reaches you through your web inbox. When it sends email:

- A question is emailed right away to the person it is asked of: to the requester when the target team asks, and to the claimant when the requester's side asks. A question the requester's side posts before anyone has claimed the request is asked of no one person, and waits in the digest.
- Every other update goes into a daily digest, sent once a UTC day after the day it covers.
- Proposal notices, which ask for your confirmation, and receipts are sent as they happen.
- On `/settings/email` you can turn the daily digest off, which also stops your teams' digests of potentially breaking API changes by email. You cannot turn off the email that is about you: proposal notices, receipts and the questions asked of you. When a team is the requester, as it is for contract changes whose author is not a member of the install, its emails go only to the members who turned them on for that team, on the same page.
- Email goes to the primary verified email address of your GitHub account.
- A subject carries only the request's key, the kind of event, the team and the request's URL, never text that people wrote.
