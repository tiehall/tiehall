# Proposal: Spec catch-up for D45 and D46

## Why

The code built for `add-tiehall-oss-v1` settled points that its specs left open. Some are additions the specs never named: the packet's `kind`, the request title, the length limits of text fields, the read operations for one message and for the members list, the state-change event, the org row's name and completion time, the answer to `If-Match: *`, and the lifetime of a setup session. Others are readings the code chose where the specs were silent: a release while a request waits on a question, the direction of the team-pair cap, what acknowledging and opening count toward, when a flip is counted, the order of the checks before the `needs_human` refusal, and whether an edit clears the flag. The maintainer accepted the first set as D45 and the second as D46, on 2026-09-27.

The specs are the contract, so they have to say what the code does. [design.md](design.md#decisions) restates D45 and D46 item by item, with the code that implements each, and the spec deltas put each rule in the requirement it belongs to.

## What Changes

- Spec-only. No code, no migration and no new behavior: every rule below is already implemented and, except where tasks.md says a test is written, already tested.
- MODIFIED requirements in seven capabilities:
  - `requests`: the request title and its bounds; a release, a reassignment or a departed member's release while `needs_info`, and the unclaimed request that returns to `open`; the bounds of a message body; the read of one message with all its versions; the state-change event.
  - `handoff-packet`: the packet's top level (`schema_version`, `kind`, `due_date`), the `kind` discriminator, and the bounds of every text field.
  - `public-api`: `If-Match` names one revision by its strong entity tag; `*`, a weak tag, a list and a body field are refused with 412 or 428.
  - `agent-safety`: opening a request is not written to that request's loop count; acknowledging and reading count toward no limit; the `needs_human` refusal comes after the side and state checks; an edit from a web session is no human action; a flip is counted when its question is posted and never uncounted; the team-pair cap counts each direction apart.
  - `teams-and-roles`: the org exists unnamed from the first start and records when setup completed; every member sees the members list; a team name's bounds.
  - `self-host-install`: what "setup is complete" is; setup sessions have no expiry and end only when setup completes.
  - `agent-surfaces`: `set_status` to `open` releases the claim as the requests capability defines, so a waiting request stays `needs_info`.
- No ADDED requirement: every rule has a requirement that already covers its area.
- tasks.md holds one group of verification tasks: one per item, naming the tests that cover it, and, in the nine tasks whose item no test covers in full, the test to write.

## Impact

- **Code:** none.
- **Specs:** `requests`, `handoff-packet`, `public-api`, `agent-safety`, `teams-and-roles`, `self-host-install` and `agent-surfaces`. `activity-log` needs no delta: the state-change event is a domain event the requests capability lists.
- **Archive:** this change is archived after `add-tiehall-oss-v1`, because every delta modifies a requirement that change adds. Until then `openspec validate` notes that the archive would refuse the MODIFIED deltas; that is expected.
- **Open points for the maintainer**, stated in design.md: a later start's new setup code leaves the setup sessions opened with an earlier code valid; `setup reopen` is not built yet, so what it does to setup sessions is unstated.
