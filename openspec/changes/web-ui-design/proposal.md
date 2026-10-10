# Proposal: Web UI design and the live hall

## Why

The web UI works but has no look: the web role's pages are plain HTML under a policy that loads no stylesheet, and nothing links them together. The maintainer opened an install in a browser, found nothing that reads as a product, and decided D57 on 2026-10-11: the web UI gets a real visual design, with motion, and a live hall where people watch requests flow between teams and see agents at work. The maintainer approved a design canvas and accepted the recommended defaults for the open points. [design.md](design.md#decisions-this-change-rests-on) restates D57 as public rules, with the alternatives that lost, so the canvas is not needed to build it.

## What Changes

- **One look** (D57 (1) to (3), (10)): one stylesheet the install serves, built on named design tokens with dark counterparts; request states look the same everywhere; the mark TM1 is the favicon and the app icon; IBM Plex Sans and Mono, IBM's own files under the SIL Open Font License, served by the install.
- **A shell** (D57 (4)): navigation to the live hall, the inbox with what waits for the member, requests, members and, for admins, admin; a focused shell without navigation where a person makes one decision or has no session.
- **Themes, motion, phone width, accessibility** (D57 (5) to (8)): themes follow the system and the live hall is dark; motion means something, stops within 5 seconds outside the live hall, pauses on it, and stops under reduced motion; pages work 320 CSS pixels wide; contrast 4.5:1, real buttons, labels and focus rings.
- **A policy per kind of page** (D57 (9)): styles, fonts and images from the install only; only the live hall runs a script from the install; the framework's pages keep their nonce-bound scripts; review, confirm, consent, device, setup, sign-in and refusal pages stay script-free.
- **The live hall** (D57 (11) to (13)): every team, the lines of live requests between them, the people and agents at work with their client's name as untrusted text, and a feed in Tiehall's words; a state read, then a long-poll in the style of the wait endpoint, for web sessions only; no event stream, no agent surface, no security event; readable at 20 teams, a list on a phone.
- **The request page** shows who works on it and a timeline.

## Capabilities

### New Capabilities

- `web-ui`: the assets, the stylesheet, states, the mark and icons, the fonts, the shell, themes, motion, phone width, accessibility, the policy of each kind of page, the request page's activity and the live hall. `openspec/config.yaml` lists it.

### Modified Capabilities

- `agent-safety`: "The web UI renders no raw HTML and no remote images" and "The review page of the confirmation step".
- `self-host-install`: "The setup code guards the setup screen" serves the assets before setup.
- `requester-loop`: "No push paths other than the hooks" names the live hall as a pull read.

## Impact

- **Code:** the page renderer and pages of `packages/commands`, the Next.js layout and pages, the setup gate, an asset route, three internal reads, the live hall's script, and one migration that adds an index.
- **Dependencies:** `@ibm/plex-sans` and `@ibm/plex-mono`, pinned exactly, past the 7-day release age, OFL-1.1.
- **Public contracts:** none; `/api/v1`, the MCP tools and the packet schema are unchanged. The new routes are the web UI's own.
- **Order:** archived after the other changes in progress; it starts from `github-layer-hardening`'s text of the setup code requirement.
- **Approval:** the maintainer approves this change before any of it is built.
