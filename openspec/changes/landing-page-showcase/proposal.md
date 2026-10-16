# Proposal: a showcase on the landing page

## Why

After the change `landing-page-motion`, on 2026-10-17, the maintainer asked for the landing page at `tiehall.com` to be made more beautiful still, and chose every option offered: real screenshots of the web UI, a live request card, a before and after, the install commands with a polished hero, and more motion. The page has to stay what it is: plain HTML and CSS with no script, colors from the web UI's dark theme, every drawing hidden until its stylesheet loads, nothing hidden behind an animation, and everything still for people who ask for reduced motion. [design.md](design.md#decisions) restates each decision, (1) to (9).

## What Changes

- **Real screenshots** of the web UI: the live hall, the list of requests and a proposal's confirm page, from the repository's own browser test with its made-up people and teams, each in a browser window drawn in CSS that floats and tilts toward the pointer, and links to the full image.
- **A live request card**, `FE-142`: its typed packet (the need, the acceptance criteria, the code it concerns and the due date) goes from BE to FE, a question comes back, the answer follows, the linked pull request merges and the card turns green, on a loop drawn in CSS, beside the same story in five numbered lines of text.
- **A before and after**: on the left, a request pasted into a team chat and buried under replies, its question asked twice; on the right, Tiehall's one line, from the typed request to done when the pull request merges, in the README's words.
- **Run it**: the install commands of `docs/install.md`, word for word, in a terminal drawn in CSS, with the README's note that they wait for the first release.
- **The hero**: the name set apart, the tagline's last words in gold, a second link to the install commands, and the facts as pills.
- **Effects**: a shimmer on the call to action, a turning gradient border on the request card and the terminal, light running along the bands' cords, a slow glow behind the screenshots, the backdrop drifting as the page scrolls, and sections that rise into view where the browser ties animations to scrolling.
- The section order: the hero, the film, the before and after, the request card, the screenshots, the points, how it works, run it, the agents and open source.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None: the landing page is no capability of the specs.

## Impact

- **Site:** `site/index.html`, `site/style.css`, and three new images, `site/assets/screen-hall.jpg`, `site/assets/screen-requests.jpg` and `site/assets/screen-confirm.jpg`, which the allowlist's `site/assets/*.jpg` already holds.
- **Checks:** `tools/repo-checks/test/site.test.ts`.
