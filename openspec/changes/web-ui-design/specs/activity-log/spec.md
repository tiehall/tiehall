# Spec Delta: activity-log

## Purpose

States that the web UI's live hall, its wait and the request page's timeline never show security events, and that members see there who caused each domain event about a request. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: Security events are shown to admins only

Security events SHALL appear only in the admin view and the export that this capability defines, which only admins can open. They SHALL NOT reach the pull readers, the long-poll wait endpoint, the web inbox, the live hall, its wait or the request page's timeline, which serve only domain events, as the requests and web-ui capabilities define, not even for an admin. A member who is not an admin and asks for the admin view or an export SHALL be refused with 403, as the error model in the public-api capability defines for a role that does not allow the action. Members see requests' domain events through the request pages, the live hall and the requester loop; the request page's timeline and the live hall also say who caused each one, with the actor kind and the client, as the web-ui capability defines.

Source: D28 #4; D57 (11), (15); design.md, Decisions this change rests on; design.md, Design: The live hall; design.md, Design: The request page's activity; design.md, Rules carried from earlier changes

#### Scenario: Updates leave out security events

- **WHEN** Pia, an admin, changes Lee's role, and then both Pia's agent and Bob's agent call `whats_new`
- **THEN** neither result includes the role-change event
- **AND** Pia sees the role-change event in the admin view

#### Scenario: A member cannot open the admin view

- **WHEN** Bob, a member who is not an admin, asks for the admin view of the activity log or an export of it
- **THEN** the request is refused with 403 and an RFC 9457 problem
- **AND** nothing is shown or exported

#### Scenario: The live hall and the timeline leave out security events

- **WHEN** Pia, an admin, changes Lee's role while Pia's browser shows the live hall, and then opens FE-142's page
- **THEN** neither the live hall, nor any answer of its wait, nor FE-142's timeline shows the role change
- **AND** Pia sees the role-change event in the admin view

#### Scenario: Members see who caused a claim

- **WHEN** Mert's agent claims FE-142 through a client whose metadata document names it `Example Agent`, and Bob, a member who is not an admin, opens FE-142's page and `/hall`
- **THEN** FE-142's timeline and the live hall's feed say that Mert's agent claimed FE-142, with the client's name `Example Agent`
