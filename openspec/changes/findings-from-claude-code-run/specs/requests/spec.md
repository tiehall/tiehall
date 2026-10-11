# Spec Delta: requests

## Purpose

Says which side of a request a posted message is recorded for, so that a person on both sides who claimed the request speaks for its target team. The rest of the capability is unchanged.

## ADDED Requirements

### Requirement: The side a message is posted for

Every message that a caller posts on a request SHALL be recorded for one side of it, as the team in the message's provenance: for the request's claimant, while a member of its target team, the target team, even when the claimant opened the request or belongs to its requesting team; otherwise, for the requesting user, the requesting team; otherwise, for a member of the target team, the target team; and otherwise, for a member of the requesting team, the requesting team. Tiehall SHALL decide the side from the caller and the request when the message is posted, as it stamps the rest of the provenance, and SHALL NOT take it from the payload. An edit SHALL keep the side the message was posted for. The side of a question decides who it is asked of, as the requester-loop capability defines for its email. The side that a proposal records for its accountable human is as the requirement on cross-team commitments defines, not as this one does.

Source: design.md, Findings: F4 (7); design.md, Technical decisions: T5

#### Scenario: A claimant who opened the request asks for the target team

- **WHEN** Sam, a member of teams FE and BE, opened `BE-7` for team FE, then claimed it, and posts a question on it
- **THEN** the question is recorded for team BE
- **AND** `get_request` shows the team BE in the question's provenance

#### Scenario: The requester asks for the requesting team before a claim

- **WHEN** Sam, a member of teams FE and BE, opened `BE-7` for team FE, nobody has claimed it, and Sam posts a question on it in the web UI
- **THEN** the question is recorded for team FE

#### Scenario: A member of both teams who did not open the request

- **WHEN** Sam opened `BE-7` for team FE, Dana has claimed it, and Kim, a member of teams FE and BE, posts a comment on it
- **THEN** the comment is recorded for team BE

#### Scenario: A claimant who left the target team

- **WHEN** Sam opened `BE-7` for team FE and claimed it as a member of team BE, and an admin then took Sam out of team BE, and Sam posts a comment on `BE-7`
- **THEN** the comment is recorded for team FE

#### Scenario: An edit keeps the side

- **WHEN** Sam posted a question on `BE-7` before claiming it, which was recorded for team FE, then claimed `BE-7` and edits the question
- **THEN** the question stays recorded for team FE
