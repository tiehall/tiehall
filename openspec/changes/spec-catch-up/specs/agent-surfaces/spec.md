# Spec Delta: agent-surfaces

## Purpose

Brings the agent-surfaces capability up to what the code does: `set_status` to `open` releases the claim as the requests capability defines, which keeps a request in `needs_info` while it waits on a blocking question.

## MODIFIED Requirements

### Requirement: Tools that change a request directly

For an agent acting for its own signed-in user, `claim`, `post_message`, `link_pr`, and `set_status` to a state change that is not a commitment SHALL take effect without a human confirmation, under the rules the requests capability defines. `set_status` to `open`, called for the claimant of a request, or for a member of the request's target team when the claimant is no longer a member of the install, SHALL release the claim as the requests capability defines, which returns the request to `open` with no claimant unless it waits on a blocking question, in which case it stays `needs_info` with no claimant until every blocking question has an answer; called for anyone else, it SHALL be refused as that capability defines. `post_message` SHALL take a message kind of comment, question or answer, and a question SHALL be able to carry `blocking`. An answer SHALL carry the id of the question it answers; an answer without one SHALL be refused as input that fails the schema: with a validation error on the MCP tools, and with HTTP 400 on the tool's `/api/v1` operation, as the public-api capability's error model defines. `open_request` SHALL take the requesting team, which SHALL be one of the caller's teams, and SHALL use the user's only team when they belong to exactly one team and name none; a user in several teams who names none, and a user in no team, are refused as the requests capability defines.

Source: D23; D28 #11, #13, #17; D29 (3); D46 (1); design.md, Decisions this change rests on; design.md, Design rules: Agent surfaces; design.md, Decisions: D46 (1)

#### Scenario: An agent claims a request

- **WHEN** an agent acting for Dana, a member of team FE, calls `claim` on the open request `FE-142`
- **THEN** `FE-142` becomes claimed by Dana
- **AND** no proposal is created

#### Scenario: A blocking question

- **WHEN** an agent calls `post_message` on `FE-142` with kind question and `blocking` set to true while `FE-142` is `in_progress`
- **THEN** the question is added to the thread of `FE-142`
- **AND** `FE-142` moves to `needs_info`, as the requests capability defines

#### Scenario: An answer names its question

- **WHEN** an agent calls `post_message` on `FE-142` with kind answer and no question id
- **THEN** the call is refused with a validation error
- **AND** nothing is added to the thread of `FE-142`

#### Scenario: The claimant releases a claim with set_status

- **WHEN** an agent acting for Dana calls `set_status` with the state `open` on `FE-142`, which Dana has claimed
- **THEN** `FE-142` is `open` with no claimant
- **AND** no proposal is created

#### Scenario: A team member releases the claim of someone who was removed

- **WHEN** `FE-142` is claimed by Lee, who has since been removed from the install, and an agent acting for Dana, a member of team FE, calls `set_status` with the state `open` on `FE-142`
- **THEN** `FE-142` is `open` with no claimant
- **AND** no proposal is created

#### Scenario: Opening a request from one of two teams

- **WHEN** an agent acting for Sam, a member of teams BE and QA, calls `open_request` to team FE and names QA as the requesting team
- **THEN** the new request records Sam and team QA as the requester

#### Scenario: set_status to open while the request waits on a question

- **WHEN** an agent acting for Dana calls `set_status` with the state `open` on `FE-142`, which Dana has claimed and which is `needs_info` after Dana's agent posted a blocking question while it was `in_progress`
- **THEN** `FE-142` stays `needs_info` with no claimant
- **AND** no proposal is created
- **AND** when the requester's agent answers the question, `FE-142` is `open` with no claimant
