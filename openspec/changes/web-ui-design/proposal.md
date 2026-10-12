# Proposal: Web UI design and the live hall

## Why

The web UI works but has no look: the web role's pages are plain HTML under a policy that loads no stylesheet, and nothing links them together. The maintainer opened an install in a browser, found nothing that reads as a product, and decided D57 on 2026-10-11, approving a design canvas and the recommended defaults: the web UI gets a real visual design, with motion, and a live hall where people watch requests flow between teams and see agents at work. D59 then chose its Navy & Gold palette, and D61 approved the change with the system's fonts and a gold New request. [design.md](design.md#decisions-this-change-rests-on) restates all three as public rules.

## What Changes

- **One look** (D57 (1), (2), (10); D59; D61): one stylesheet the install serves, built on named design tokens, navy and gold, light and dark; request states look the same everywhere; the mark TM1 is the favicon and the app icon; text in the system's own fonts.
- **A shell** (D57 (4); D61 (2)): a gold New request and navigation to the live hall, the inbox with what waits for the member, requests, members and, for admins, admin; a focused shell without navigation where a person makes one decision or has no session.
- **Themes, motion, phone width, accessibility** (D57 (5) to (8)): themes follow the system and the live hall is dark; motion means something, stops within 5 seconds outside the live hall, pauses on it, and stops under reduced motion; pages work 320 CSS pixels wide; contrast 4.5:1, real buttons, labels and focus rings.
- **A policy per kind of page** (D57 (9); D61 (1)): styles and images from the install only, and no font; only the live hall runs a script from the install; the framework's pages keep their nonce-bound scripts; review, confirm, consent, device, setup, sign-in and refusal pages stay script-free.
- **The live hall** (D57 (11) to (13)): every team, the lines of live requests between them, the people and agents at work, and a feed in Tiehall's words; a state read, then a long-poll for web sessions only, which does not extend the session; no event stream, no agent surface, no security event; readable at 20 teams, a list on a phone.
- **The request page** (D57 (15)) shows who works on it and a timeline.

## Capabilities

### New Capabilities

- `web-ui`: assets, look, shell, themes, motion, phone width, accessibility, page policies, the request page's activity and the live hall. `openspec/config.yaml` lists it.

### Modified Capabilities

- `agent-safety`: "The web UI renders no raw HTML and no remote images" and "The review page of the confirmation step".
- `self-host-install`: "The setup code guards the setup screen" serves the assets before setup.
- `requester-loop`: "No push paths other than the hooks" names the live hall as a pull read.
- `activity-log`: "Security events are shown to admins only" adds the live hall and the timeline, which say who caused each domain event.

## Impact

- **Code:** the pages of `packages/commands` and the Next.js app, the proxy, the setup gate, an asset route, four internal reads, the live hall's script, and a migration that adds two indexes.
- **Dependencies:** none, and no third-party files.
- **Public contracts:** none; `/api/v1`, the MCP tools and the packet schema are unchanged.
- **Order:** archived after the other changes in progress; it starts from `github-layer-hardening`'s text of the setup code requirement.
- **Approval:** approved by the maintainer on 2026-10-12 (D61), with two departures, which tasks 1.16 and 1.17 build.
