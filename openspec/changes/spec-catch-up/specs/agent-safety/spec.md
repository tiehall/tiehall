# Spec Delta: agent-safety

## Purpose

Brings the agent-safety capability up to what the code does: what the loop count leaves out and in which order the checks before its refusal run, when a flip is counted, what the per-token limit and the budget leave out, and how the team-pair cap counts.

## MODIFIED Requirements

### Requirement: Runaway agent loops flag the request needs_human

Tiehall SHALL count the agent writes on each request since the last human action on it. An agent write SHALL be any write on the request made with an OAuth token or a personal access token, on MCP, the CLI or `/api/v1`, which the requests capability records with the actor kind `agent`. Opening a request is not a write on the request it opens: the count of a request SHALL start with the first agent write on it after it exists, so the opening is never counted, whoever opened it; the caps on agent-opened requests, the per-token limit and the daily budget, which this capability defines, cover the opening. Tiehall SHALL flag the request `needs_human` when either of these holds:
- agents have made more than 6 writes on it within 10 minutes with no human action: the flag is set by the agent write that makes 7 agent writes within any 10-minute period after the last human action;
- agents have made 30 writes on it in total since the last human action: the thirtieth sets the flag.

The write that sets the flag SHALL be accepted. A human action on a request SHALL be a message posted on it from a web session, or a confirmation in the web UI, with the confirmation step that this capability defines, of a proposal on that request, including the first of the two confirmations of a cross-team commitment. Either SHALL clear the flag and SHALL reset both counts, so that only agent writes after the latest human action count. Rejecting a proposal, undoing a commitment, a claim or state change made in the web UI, and editing a message from a web session SHALL NOT be human actions: an edit from a web session adds its version and leaves the flag and both counts as they are. While the request is flagged, an agent write to that request SHALL be refused, as the error model in the public-api capability defines for a write to a request that needs a human: with HTTP 409 and the problem type `needs-human` on REST, and with a tool error that names that problem type on the MCP tools and in the CLI's output; a refused write SHALL NOT be counted. The flag SHALL be checked last: only once the write has passed its input schema, the caller's side, the request's state, the records its input names and, for a packet revision, the `If-Match` precondition, and has been counted against the per-token limit and the daily budget. So a write that the caller's side does not allow gets 403, and one that the request's state does not allow gets 409 without the problem type `needs-human`, whether or not the request is flagged, and neither is counted. Writes recorded with the actor kind `system`, `integration` or `web_session`, such as the packet revisions and system messages that a signed contract report adds, notices, close on merge, system withdrawals, proposal expiry, a tracker "Done" proposal, and a claim or state change made in the web UI, SHALL be neither counted nor refused. Acknowledging events moves a read cursor and is not a write on a request, so it SHALL never be counted or refused because of the flag. Reads SHALL never be refused because of the flag. The count and the flag SHALL be decided in the same transaction as the write, so that concurrent agent writes cannot pass the limit together. The limit is aimed at runaway loops, not at an ordinary exchange of questions and answers between agents, which stays under both counts.

Source: D28 #50; D30; D46 (3), (4), (6), (7); design.md, Decisions this change rests on; design.md, Design rules: Agent safety; design.md, Self-hosting decisions: S7; design.md, Decisions: D46 (3), (4), (6), (7)

#### Scenario: An ordinary exchange over an hour does not trip the flag

- **WHEN** between 09:00 and 10:00 UTC, agents on both sides post 20 questions and answers on FE-142, never more than 4 within any 10 minutes, with no human action on FE-142
- **THEN** every one of the 20 messages is accepted
- **AND** FE-142 is not flagged `needs_human`

#### Scenario: A fast loop trips the flag

- **WHEN** agents make 7 writes on FE-142 between 09:00 and 09:04 UTC, with no human action on FE-142
- **THEN** the seventh write is accepted and FE-142 is flagged `needs_human`
- **AND** an agent's next message on FE-142 through `/api/v1` gets HTTP 409 with the problem type `needs-human`
- **AND** an agent's next `post_message` call on FE-142 over MCP returns a tool error that names `needs-human` and posts nothing

#### Scenario: Six writes within 10 minutes do not trip the flag

- **WHEN** agents make 6 writes on FE-142, the first at 09:00 UTC and the sixth at 09:05 UTC, and a seventh at 09:12 UTC, with no human action on FE-142
- **THEN** all 7 writes are accepted
- **AND** FE-142 is not flagged `needs_human`

#### Scenario: A slow loop trips the flag at 30 writes

- **WHEN** between 09:00 and 14:00 UTC agents make 30 writes on FE-142, never more than 6 within any 10 minutes, with no human action on FE-142
- **THEN** the thirtieth write is accepted and FE-142 is flagged `needs_human`
- **AND** an agent's thirty-first write on FE-142 through `/api/v1` gets HTTP 409

#### Scenario: Concurrent writes cannot both pass the limit

- **WHEN** agents have made 6 writes on FE-142 since 09:00 UTC, and at 09:03 UTC two agents each send a message on FE-142 at the same moment
- **THEN** exactly one of the two messages is accepted and sets the flag
- **AND** the other gets HTTP 409 with the problem type `needs-human` and is not added

#### Scenario: A web-session message clears the flag and resets both counts

- **WHEN** FE-142 is flagged `needs_human` after 30 agent writes
- **AND** a member posts a message on it in the web UI
- **AND** agents then make 6 writes on FE-142 within the next 10 minutes
- **THEN** FE-142 is no longer flagged `needs_human`
- **AND** all 6 agent writes are accepted and FE-142 stays unflagged

#### Scenario: A web confirmation clears the flag

- **WHEN** FE-142 is claimed by Bob and flagged `needs_human`, and a proposal to change its acceptance criteria waits for Alice, its requester and the proposal's accountable human
- **AND** Alice confirms the proposal on its confirm page in the web UI
- **THEN** FE-142 is no longer flagged `needs_human`
- **AND** the counts of agent writes on FE-142 start again from zero
- **AND** the proposal now waits for Bob's confirmation, as the requests capability defines for a scope change while the request is claimed

#### Scenario: A rejection or a web-UI state change does not clear the flag

- **WHEN** FE-142 is claimed by Bob and flagged `needs_human`, Alice rejects a pending due-date proposal on it in the web UI, and Bob then sets FE-142 to `in_progress` in the web UI
- **THEN** FE-142 is still flagged `needs_human`
- **AND** Bob's state change is applied

#### Scenario: A contract report still reaches a flagged request

- **WHEN** the claimed contract-change request FE-150 is flagged `needs_human`, and a signed contract report for its provider PR reports 3 breaking changes instead of 2
- **THEN** FE-150 gets the new packet revision and the system message
- **AND** FE-150 stays flagged and neither write is counted as an agent write

#### Scenario: Acknowledging events on a flagged request

- **WHEN** FE-142 is flagged `needs_human`, and an agent calls `whats_new`, gets the events on FE-142 and acknowledges them
- **THEN** the agent's cursor moves past those events

#### Scenario: Reads are never blocked

- **WHEN** FE-142 is flagged `needs_human`
- **AND** an agent calls `get_request` for FE-142
- **THEN** the call returns FE-142 with its thread

#### Scenario: The opening is not counted

- **WHEN** Alice's agent opens FE-142 at 08:59 UTC, and agents then make 6 writes on it between 09:00 and 09:03 UTC, with no human action on it
- **THEN** all 6 writes are accepted and FE-142 is not flagged `needs_human`
- **AND** a seventh agent write at 09:04 UTC is accepted and flags it

#### Scenario: The side and the state are checked before the flag

- **WHEN** FE-142 is claimed by Bob and flagged `needs_human`
- **AND** Carol, a member of team OPS only, posts a comment on it through `/api/v1`, Erin, a member of team FE, asks through `/api/v1` to claim it, and Bob's agent posts a comment on it through `/api/v1`
- **THEN** Carol's write is refused with 403
- **AND** Erin's claim is refused with 409 and a problem type that is not `needs-human`
- **AND** Bob's agent's write is refused with 409 and the problem type `needs-human`
- **AND** nothing is added to FE-142 and none of the three is counted

#### Scenario: An edit from a web session does not clear the flag

- **WHEN** FE-142 is flagged `needs_human` and Bob edits, in the web UI, a message they posted on it earlier
- **THEN** the message gets its next version
- **AND** FE-142 is still flagged `needs_human`, and an agent's next write on it gets HTTP 409 with the problem type `needs-human`

### Requirement: A request flips between needs_info and in_progress at most 3 times a day

Tiehall SHALL allow at most 3 counted flips of a request per UTC day. A flip SHALL be one round trip from `in_progress` to `needs_info` and back to `in_progress`. A flip SHALL be counted when its blocking question was posted with the actor kind `agent`, whoever answers it, and SHALL count on the UTC day its blocking question was posted. A flip SHALL be counted at the moment its blocking question is posted, and SHALL stay counted whether or not the round trip completes: a question left unanswered, a claim released, or a request reassigned, declined, withdrawn or marked done while it waits SHALL NOT uncount it. A blocking question posted while the request already waits in `needs_info` joins the round trip in progress and starts no new flip. A blocking question posted from a web session starts no counted flip, and a blocking question on a request that is `open` or `claimed` is no flip and is neither counted nor limited. A fourth counted flip on the same UTC day SHALL NOT happen: an agent's blocking question that would start it, on a request that is `in_progress`, SHALL be posted as a non-blocking question, with a notice from Tiehall, and a question posted that way records no flip.

Source: D28 #51; D46 (5); design.md, Decisions this change rests on; design.md, Design rules: Requests and events; design.md, Decisions: D46 (5)

#### Scenario: The fourth flip in a day does not happen

- **WHEN** agents have moved FE-142 from `in_progress` to `needs_info` and back 3 times today (UTC) and it is now `in_progress`
- **AND** an agent posts a blocking question on it
- **THEN** FE-142 stays in `in_progress`
- **AND** the question is posted as non-blocking
- **AND** Tiehall adds a notice to FE-142 that the question was posted as non-blocking

#### Scenario: The count starts again each UTC day

- **WHEN** agents moved FE-142 from `in_progress` to `needs_info` and back 3 times on 2026-10-01 (UTC)
- **AND** an agent posts a blocking question on it at 00:05 UTC on 2026-10-02
- **THEN** FE-142 moves to `needs_info`

#### Scenario: Flips that people start are not counted

- **WHEN** FE-142 has moved from `in_progress` to `needs_info` and back 3 times today, each time through a blocking question posted by a member in the web UI
- **AND** an agent posts a blocking question on it
- **THEN** FE-142 moves to `needs_info`

#### Scenario: An agent's question answered by a person still counts

- **WHEN** agents have posted 3 blocking questions on FE-142 today while it was `in_progress`, each answered by the requester in the web UI, and FE-142 is `in_progress` again
- **AND** an agent posts a fourth blocking question on it
- **THEN** the question is posted as non-blocking and FE-142 stays `in_progress`

#### Scenario: A question on a claimed request is no flip

- **WHEN** agents have made 3 counted flips on FE-142 today, Bob's claim was then released and FE-142 claimed again, so it is `claimed`
- **AND** an agent posts a blocking question on it
- **THEN** FE-142 moves to `needs_info`

#### Scenario: Two questions in one round trip count once

- **WHEN** FE-142 is `in_progress` and Bob's agent posts two blocking questions on it before either is answered, and the requester's agent then answers both
- **THEN** FE-142 has made one counted flip today
- **AND** two more round trips that agents start today move FE-142 to `needs_info` each time

#### Scenario: A round trip that never completes still counts

- **WHEN** three times today, Bob's agent posted a blocking question on FE-142 while it was `in_progress`, then released the claim while FE-142 waited, the requester's agent answered so that FE-142 returned to `open`, and Bob claimed it and started work again
- **AND** Bob's agent posts a fourth blocking question on FE-142 while it is `in_progress`
- **THEN** the question is posted as non-blocking and FE-142 stays `in_progress`

### Requirement: Agent writes are limited per token and budgeted per install

Tiehall SHALL accept at most 60 writes from one token within any 60 seconds, and at most 5,000 agent writes per UTC day in the install. The daily budget SHALL be 5,000 by default, and an admin SHALL be able to change it in the web UI with the confirmation step that this capability defines. A write beyond either limit SHALL be refused, with HTTP 429 and a `Retry-After` header on REST, as the error model in the public-api capability defines, and nothing SHALL be written. Both limits SHALL be counted in the same transaction as the write. A write is a call that changes something: opening a request, posting or editing a message, claiming, changing the state, proposing a commitment and adding a packet revision each count once, also when the call becomes a proposal. Reading, and acknowledging events, which only moves a read cursor, SHALL count toward neither the limit nor the budget and SHALL never be refused by them; nor SHALL writes recorded with the actor kind `web_session`, `system` or `integration`. A write that is refused, whatever refused it, SHALL NOT be counted.

Source: D28 #49; D46 (3); design.md, Decisions this change rests on; design.md, Design rules: Agent safety; design.md, Self-hosting decisions: S7; design.md, Decisions: D46 (3)

#### Scenario: A token over its write limit is refused

- **WHEN** a token has made 60 writes within one minute
- **AND** it makes another write through `/api/v1` in that minute
- **THEN** the write is refused with HTTP 429 and a `Retry-After` header
- **AND** nothing is written

#### Scenario: The install's daily budget is spent

- **WHEN** agents in the install have made 5,000 writes today and the budget is the default
- **AND** an agent makes another write through `/api/v1` the same day
- **THEN** the write is refused with HTTP 429 and a `Retry-After` header
- **AND** nothing is written

#### Scenario: The limit counts any 60 seconds

- **WHEN** a token made 40 writes between 09:00:30 and 09:00:59 UTC, and then sends 30 more writes through `/api/v1` between 09:01:00 and 09:01:20 UTC
- **THEN** the first 20 of them are accepted
- **AND** the 21st is refused with HTTP 429 and a `Retry-After` header, because it would be the 61st write within 60 seconds

#### Scenario: The budget starts again each UTC day

- **WHEN** agents in the install made 5,000 writes on 2026-10-01 (UTC), the budget is the default, and an agent writes at 00:01 UTC on 2026-10-02
- **THEN** the write is accepted

#### Scenario: An admin raises the budget

- **WHEN** an admin sets the daily write budget to 10,000 in the web UI and confirms it with the confirmation step
- **AND** agents in the install have made 5,000 writes today
- **THEN** the next agent write through `/api/v1` is accepted

#### Scenario: Acknowledging and reading are not writes

- **WHEN** agents in the install have made 5,000 writes today and the budget is the default
- **AND** Bob's agent reads FE-142, reads its new events and acknowledges them through `/api/v1`
- **THEN** each call is answered 200
- **AND** the day's count stays at 5,000

### Requirement: Agent-opened requests are capped

Tiehall SHALL let agents open at most 20 requests per user per hour and at most 50 requests per pair of teams per day, so that loops spanning several requests stop. The hour SHALL be any 60-minute window, and the day a UTC day. A pair of teams SHALL be ordered, from the requesting team to the target team: the requests agents open from team BE to team FE and the requests they open from FE to BE are two pairs, each with its own count of 50. Requests people open in the web UI SHALL count toward neither cap. A request beyond either cap SHALL NOT be opened, and the call SHALL be refused with HTTP 429 and a `Retry-After` header on REST, as the error model in the public-api capability defines.

Source: D28 #49; D46 (2); design.md, Decisions this change rests on; design.md, Decisions: D46 (2)

#### Scenario: The hourly cap per user stops a loop

- **WHEN** agents acting for one user have opened 20 requests within the past hour
- **AND** an agent acting for that user opens another request through `/api/v1`
- **THEN** the call is refused with HTTP 429 and a `Retry-After` header
- **AND** no request is opened

#### Scenario: The daily cap per team pair stops a loop

- **WHEN** agents have opened 50 requests from team BE to team FE today
- **AND** an agent opens another request from BE to FE through `/api/v1` the same day
- **THEN** the call is refused with HTTP 429 and a `Retry-After` header
- **AND** no request is opened

#### Scenario: The other direction has its own count

- **WHEN** agents have opened 50 requests from team BE to team FE today, so that the next one from BE to FE is refused
- **AND** Bob's agent, acting for Bob of team FE, opens a request from FE to BE through `/api/v1` the same day
- **THEN** the request is opened

#### Scenario: Requests opened in the web UI are not counted

- **WHEN** members of team BE have opened 50 requests from BE to FE in the web UI today
- **AND** Alice's agent, acting for Alice of team BE, opens a request from BE to FE through `/api/v1` the same day
- **THEN** the request is opened
