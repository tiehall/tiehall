# Spec Delta: requester-loop

## Purpose

Makes the Claude Code hooks tell the sessions that worked on a request: a session's project folder follows the requests its agent works on, and news on a followed request is announced once in each folder that follows it and in no other session. Leaves out of the agents' readers only what the user's agents did, so that an agent still hears what its person did in the web UI, and leaves every event of the user out of the readers people read. The rest of the capability is unchanged.

## ADDED Requirements

### Requirement: A project folder follows the requests its sessions work on

The Claude Code plugin SHALL register a PostToolUse hook for its own MCP tools that runs `tiehall hook follow`. After a call of `get_request`, `open_request`, `post_message`, `claim`, `set_status`, `link_pr`, `propose` or `attach_contract_changes` that succeeded, the hook SHALL record on the user's machine, for the user and the install, that the session's project folder follows the request the call named, by its key or by its URL on that install, or, for `open_request`, the request the call opened. A call of `whoami`, `directory`, `list_inbox` or `whats_new`, a call that failed, and a URL of another install SHALL make no folder follow anything. The hook SHALL write nothing that reaches Claude, SHALL NOT block or change the tool call, SHALL NOT call the install, and SHALL NOT acknowledge anything; when the `tiehall` CLI is not installed, it SHALL exit quietly, as the requirement that the hooks stay quiet without the CLI defines for the other hooks. A folder follows a request whichever of the user's sessions in it made the call, so a later session in the same folder follows it too, and how news on a followed request is announced is as the requirement that news is announced once defines.

Source: design.md, Findings: F1 (1); design.md, Technical decisions: T1

#### Scenario: Opening a request makes the folder follow it

- **WHEN** Sam's agent, in a Claude Code session whose project folder is `/home/sam/web`, opens `FE-142` through `open_request` on `https://tiehall.example.com`
- **THEN** the folder `/home/sam/web` follows `FE-142` for Sam on `https://tiehall.example.com`
- **AND** nothing from the hook reaches Claude

#### Scenario: Reading a request by its URL

- **WHEN** Sam's agent, in a session whose project folder is `/home/sam/api`, calls `get_request` with `https://tiehall.example.com/FE-142`
- **THEN** the folder `/home/sam/api` follows `FE-142`

#### Scenario: Listing follows nothing

- **WHEN** Sam's agent calls `list_inbox` and `whats_new`, whose results name `FE-142` and `FE-143`
- **THEN** no folder of Sam's follows `FE-142` or `FE-143` because of those calls

#### Scenario: A refused call follows nothing

- **WHEN** Sam's agent calls `claim` on `FE-150` and the install refuses it with 403
- **THEN** no folder of Sam's follows `FE-150` because of that call

#### Scenario: Without the CLI

- **WHEN** Sam has the plugin installed but no `tiehall` command on the machine, and Sam's agent opens `FE-142` through `open_request`
- **THEN** the tool call returns its result as it would without the plugin's hooks
- **AND** nothing from the hook reaches Claude

## MODIFIED Requirements

### Requirement: News is announced once

The CLI SHALL keep, on the user's machine, local marks of the updates already announced: one per user and install, and one per user, install and project folder for each folder that follows a request, as the requirement that a project folder follows the requests its sessions work on defines. The SessionStart digest and the Stop-hook waiter of a Claude Code session SHALL announce an update on a request that one or more of the user's folders follow only when the session's project folder is one of them and that folder's mark does not hold the update, so that the update is announced once in each folder that follows its request and in no session of another folder; a waiter SHALL keep waiting past an update it may not announce. They SHALL announce an update on a request that no folder follows only when the mark of the user and install does not hold it, so that it is announced once, by whichever digest, waiter or `tiehall watch` sees it first. `tiehall watch`, which runs outside Claude Code, SHALL read and add to the mark of the user and install only. Each SHALL add the updates it announces to the mark of the user and install, and the digest and the waiter also add those on requests their session's folder follows to that folder's mark, before they announce them. The marks SHALL NOT acknowledge anything: an announced update stays in every pull reader until the user or their agent acknowledges it.

Source: design.md, Findings: F1 (1), (2); design.md, Technical decisions: T2; design.md, Rules carried from earlier changes

#### Scenario: The next turn does not wake Claude again for the same news

- **WHEN** the waiter woke Claude for the question on `FE-142`, and Claude's turn ends without acknowledging it
- **THEN** the next waiter does not exit with code 2 because of that question
- **AND** it exits with code 2 when a new update arrives

#### Scenario: A new session does not list announced news again

- **WHEN** the waiter woke Claude for the question on `FE-142`, and Sam then starts a new Claude Code session without having acknowledged it
- **THEN** the SessionStart digest does not list the question on `FE-142`
- **AND** Sam's next `tiehall updates` still lists it

#### Scenario: Another install keeps its own mark

- **WHEN** Sam has saved logins for `https://tiehall.example.com` and `https://tiehall.example.net`, and the question on `FE-142` of `https://tiehall.example.com` has been announced
- **THEN** that announcement adds nothing to the mark for `https://tiehall.example.net`

#### Scenario: The session that worked on the request is told

- **WHEN** Sam's agent opened `FE-142` in a Claude Code session whose project folder is `/home/sam/web`, Sam has another idle session, whose project folder is `/home/sam/infra`, both sessions have a waiter armed, and Dana then posts a question on `FE-142`
- **THEN** the waiter of the session in `/home/sam/web` exits with code 2, and Claude wakes there
- **AND** the waiter of the session in `/home/sam/infra` keeps waiting, and Claude is not woken there

#### Scenario: A followed request's news waits for its folder

- **WHEN** the folder `/home/sam/web` follows `FE-142`, no Claude Code session runs in it, Sam's session in `/home/sam/infra` is idle with a waiter armed, and Dana posts a question on `FE-142`
- **THEN** the session in `/home/sam/infra` is not woken for the question
- **AND** the SessionStart digest of the next session Sam starts in `/home/sam/web` lists it
- **AND** the next `whats_new` call by Sam's agent, in either folder, includes it

#### Scenario: News on a request that no folder follows

- **WHEN** Lee opens `FE-150` to team FE, of which Sam is a member, no folder of Sam's follows `FE-150`, and Sam has two idle sessions with a waiter armed, one in `/home/sam/web` and one in `/home/sam/infra`
- **THEN** exactly one of the two waiters exits with code 2 for the opening of `FE-150`
- **AND** the SessionStart digest of the next session Sam starts, in either folder, does not list it

#### Scenario: Two sessions in one folder

- **WHEN** Sam has two idle sessions with a waiter armed whose project folder is `/home/sam/web`, which follows `FE-142`, and Dana posts a question on `FE-142`
- **THEN** exactly one of the two waiters exits with code 2 for the question

#### Scenario: The monitor keeps the mark of the user and install

- **WHEN** `tiehall watch` printed the question on `FE-142`, which the folder `/home/sam/web` follows, while no Claude Code session ran in that folder, and Sam then starts a session in `/home/sam/web`
- **THEN** that session's SessionStart digest lists the question
- **AND** `tiehall watch` does not print the question again

### Requirement: What whats_new covers

`whats_new` SHALL return the domain events on the requests whose requesting user is its user, the requests its user has claimed and the requests its user is accountable for, plus the new requests addressed to the user's teams. The requesting user of a request is the user who opened it, or, for a contract-change request, the user whom the contract-changes capability names as its requester: the member of the install whose GitHub account authored the provider PR. A request's events SHALL be in the user's updates for good once the user opened it, claimed it, is the accountable human of a proposal on it, or was the accountable human of any event on it, such as a message they or their agent posted or a PR they linked. Of a request addressed to one of the user's teams, only its opening and its reassignment into that team SHALL reach the user's updates through the team; its later events reach them only once the request is theirs by one of the rules above. Every event that one of the user's agents made, recorded with the actor kind `agent` and the user as its accountable human, on any surface, SHALL be left out, so that an agent is never told of what it or another agent of its user did; an event the user made in the web UI, recorded with the actor kind `web_session`, such as their confirmation of their agent's proposal or their answer to a question, SHALL stay in. Events on other requests of the install SHALL NOT appear in it. `tiehall updates` runs the same operation as `whats_new`, as the public-api capability requires of every operation, so it SHALL return the same updates. The Claude Code hooks read these updates with the CLI's cursor, as the requirement on the hooks defines, and the wait endpoint wakes only for them, so that no update reaches a reader only through a push path.

The web inbox's update feed SHALL use the same scope as `whats_new`, plus the events on the requests whose requesting team is one of the user's teams, as the requirement on when the requester is a team defines. Events on any other request of the install SHALL NOT appear in the update feed, even though the user may open those requests. The web inbox's update feed and the daily digest, which people read, SHALL leave out every event whose accountable human is the user, what they did in the web UI included.

Source: D14; D28 #58, #60, #62, #75; D29 (5); D55 (43), (45), (46); design.md, Findings: F2 (4); design.md, Technical decisions: T3; design.md, Rules carried from earlier changes

#### Scenario: The author of a provider PR gets the consumers' questions

- **WHEN** Deniz is the requester of the contract-change request `FE-150` because the GitHub account they sign in to Tiehall with authored provider PR #310, and FE's agent posts a question on `FE-150`
- **THEN** the next `whats_new` call by Deniz's agent includes the question event on `FE-150`, though Deniz did not open `FE-150` themselves

#### Scenario: A request the user claimed

- **WHEN** Dana has claimed `FE-142`, which Sam opened, and Sam posts an answer on it
- **THEN** the next `whats_new` call by Dana's agent includes the answer event on `FE-142`

#### Scenario: A new request to the user's team

- **WHEN** Sam opens `FE-143` to team FE, of which Dana is a member
- **THEN** the next `whats_new` call by Dana's agent includes the new request `FE-143`

#### Scenario: A request the user has no part in

- **WHEN** Lee, a member of team BE, opens `OPS-7` to team OPS, and Dana is in neither team, has not claimed `OPS-7` and is not accountable for anything on it
- **AND** a question is then posted on `OPS-7`
- **THEN** no event on `OPS-7` appears in Dana's `whats_new`
- **AND** no event on `OPS-7` appears when Dana runs `tiehall updates`
- **AND** no event on `OPS-7` appears in Dana's web inbox, though Dana can open `OPS-7` in the web UI

#### Scenario: The web inbox shows the user's updates

- **WHEN** Dana has claimed `FE-142`, which Sam opened, and Sam posts an answer on it
- **THEN** Dana's web inbox lists the answer event on `FE-142`

#### Scenario: The web inbox adds requests whose requester is the user's team

- **WHEN** team PAY is the requester of `FE-150` because the author of the provider PR is not a member of the install, Kim is a member of PAY and not of FE, has not claimed `FE-150` and is not accountable for anything on it, and FE's agent posts a question on `FE-150`
- **THEN** Kim's web inbox lists the question event on `FE-150`
- **AND** Kim's `whats_new` does not include it

#### Scenario: A user's own write is not their update

- **WHEN** Dana has claimed `FE-142`, which Sam opened, and Dana's agent posts a question on it
- **THEN** the next `whats_new` call by Dana's agent does not include the question event
- **AND** the next `whats_new` call by Sam's agent includes it

#### Scenario: A request the user took part in stays in their updates

- **WHEN** Dana, a member of team BE only, posted a comment on `OPS-7`, which Lee opened to team OPS, and Lee later posts an answer on `OPS-7`
- **THEN** the next `whats_new` call by Dana's agent includes Lee's answer

#### Scenario: A team's new request reaches its members once

- **WHEN** Sam opens `FE-143` to team FE, of which Dana is a member, and Sam later posts a comment on `FE-143`, which nobody has claimed
- **THEN** Dana's `whats_new` includes the opening of `FE-143`
- **AND** it does not include Sam's comment

#### Scenario: The user's confirmation in the web UI reaches their agent

- **WHEN** Dana has claimed `FE-142`, Dana's agent proposes declining it, and Dana confirms the proposal in the web UI
- **THEN** the next `whats_new` call by Dana's agent includes the confirmation
- **AND** Dana's web inbox's update feed does not list it

#### Scenario: The user's answer in the web UI reaches their agent's readers

- **WHEN** Sam opened `FE-142`, Dana's agent posts a blocking question on it, and Sam answers the question in the web UI while Sam's CLI client waits on `/api/v1/events/wait`
- **THEN** the wait answers with an entry for Sam's answer
- **AND** the next `whats_new` call by Sam's agent includes the answer
- **AND** neither Sam's web inbox's update feed nor Sam's daily digest lists it

#### Scenario: A write through the CLI is the agent's too

- **WHEN** Dana has claimed `FE-142` and posts a question on it with `tiehall ask`, which Tiehall records with the actor kind `agent` and the surface `cli`
- **THEN** Dana's next `tiehall updates` does not list the question
- **AND** the next `whats_new` call by Sam's agent includes it
