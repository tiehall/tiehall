# Spec Delta: requester-loop

## Purpose

States that the web UI's live hall reads by pull, with a long-poll and no stream, and is no path by which updates reach a requester. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: No push paths other than the hooks

In v1, the only push path SHALL be the Claude Code hooks, or the plugin monitor in place of the Stop-hook waiter. Claude Code channels SHALL NOT ship in v1, and Tiehall SHALL NOT offer a server-sent event stream, a WebSocket or any other stream of events; the wait endpoint serves the loop. The web UI's live hall, which the web-ui capability defines, reads by pull as well: it reads its state and then holds a long-poll read in the style of the wait endpoint, offered to web sessions only and on no agent surface, and it is no path by which updates reach a requester or an agent.

Source: D8; D57 (12); design.md, Decisions this change rests on; design.md, Design: The live hall; design.md, Rules carried from earlier changes

#### Scenario: No channel in the plugin

- **WHEN** the v1 Claude Code plugin is inspected
- **THEN** it registers the SessionStart and Stop hooks
- **AND** it declares no channel

#### Scenario: No event stream in the API

- **WHEN** the OpenAPI document served by an install is read
- **THEN** it describes no operation that streams events as server-sent events

#### Scenario: The live hall reads by pull

- **WHEN** a member's browser shows the live hall for a minute while requests change
- **THEN** every answer the page reads is one complete JSON document in answer to one GET
- **AND** none is a server-sent event stream, and the page opens no WebSocket

#### Scenario: The live hall's reads are no agent surface

- **WHEN** the OpenAPI document and the MCP tools an install serves are read
- **THEN** neither offers the live hall's state or its wait
