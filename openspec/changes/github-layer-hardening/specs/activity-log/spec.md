# Spec Delta: activity-log

## Purpose

States how long Tiehall keeps the record of a refused GitHub account that a refused sign-in's security event names. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: IP addresses and user agents are kept apart for 90 days

Tiehall SHALL keep the IP address and the user agent recorded with a security event apart from the event itself, and SHALL delete them 90 days after the event. The event SHALL stay in the activity log after they are deleted. While they are kept, the admin view SHALL show them next to their event; the export SHALL NOT include them. The security event of a refused sign-in SHALL name a record of the refused GitHub account, which SHALL hold only the account's numeric id, the login it had and the time of the refusal, and which SHALL be kept as long as the event, so that the admin view always says whose sign-in was refused; the refusal's IP address and user agent SHALL be deleted after 90 days like those of every other security event.

Source: D28 #9; D50 (5); design.md, Decisions this change rests on; design.md, Rules carried from earlier changes

#### Scenario: The IP address is gone after 90 days

- **WHEN** 91 days have passed since Alice created a personal access token from the IP address 203.0.113.7
- **THEN** the database no longer holds 203.0.113.7 or the user agent recorded with that security event
- **AND** the security event for the token's creation is still in the activity log

#### Scenario: The IP address is kept within 90 days

- **WHEN** 30 days have passed since Alice created a personal access token from the IP address 203.0.113.7
- **THEN** the database still holds 203.0.113.7 with that security event
- **AND** the admin view shows 203.0.113.7 next to that event

#### Scenario: The export leaves IP addresses out

- **WHEN** Pia exports the activity log with the confirmation step 30 days after Alice created a personal access token from the IP address 203.0.113.7
- **THEN** the export holds the event for the token's creation
- **AND** it does not contain 203.0.113.7

#### Scenario: A refused sign-in is still named after 90 days

- **WHEN** 91 days have passed since the sign-in of the GitHub account `kim-x` was refused from the IP address 203.0.113.9
- **THEN** the database no longer holds 203.0.113.9 or the user agent recorded with that refusal
- **AND** the admin view still shows the refused sign-in, naming the account `kim-x` and its numeric id
