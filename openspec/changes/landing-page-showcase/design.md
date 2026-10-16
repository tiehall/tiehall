# Design: a showcase on the landing page

## Context

The landing page (the main change's task 30.15, and the changes `play-film-from-youtube` and `landing-page-motion`) is plain HTML and CSS in `site/`, published by GitHub Pages. Its policy, `default-src 'none'; style-src 'self'; img-src 'self'; frame-src 'self' https://www.youtube-nocookie.com`, runs no script, takes no inline style and loads nothing from another host but the film's player once a visitor starts it. Its colors are tokens whose values are the web UI's dark theme or the live hall's (`packages/commands/assets/tiehall.css`), every SVG carries `display="none"` until the stylesheet shows it (`landing-page-motion`, decision (8)), no text waits for an animation (decision (4)), and the reduced-motion rule stops everything. `tools/repo-checks/test/site.test.ts` checks all of it. This change keeps every one of those rules.

## Decisions

(1) **Real screenshots, from the repository's own browser test** (the maintainer's answer of 2026-10-17). The screenshot test of the web UI, `packages/commands/test/screens-browser.test.ts`, opens every page of the web UI in Chrome on a test install whose people and teams are made up (Pia, Alice and Quinn; BE, FE and QA; the organization "acme") and saves each page under `test-results/screens/`, named by who, page, size and scheme. Three are on the page, as the admin, Pia, sees them at 1,280 by 800 in the dark scheme:
- `site/assets/screen-hall.jpg`, the live hall, from `admin--hall--1280x800--dark.png`, cropped to its top 1,280 by 776 pixels: the hall's map, its list of what happened on the lines, and QA glowing gold with a question waiting.
- `site/assets/screen-requests.jpg`, the list of all requests, from `admin--requests-list-all--1280x800--dark.png`, cropped to 1,280 by 560: one request needs info, one is in progress and one is open.
- `site/assets/screen-confirm.jpg`, a proposal's confirm page, from `admin--confirm-proposal--1280x800--dark.png`, cropped to 1,280 by 560: a person confirms or rejects a decline an agent proposed.

They were made on 2026-10-17 with these commands, from the repository's root, with Docker running for the test's Postgres and Google Chrome installed:

```sh
pnpm exec vitest run packages/commands/test/screens-browser.test.ts -t "at 1280 by 800 in the dark scheme"
ffmpeg -i test-results/screens/admin--hall--1280x800--dark.png -vf "crop=1280:776:0:0" -q:v 4 site/assets/screen-hall.jpg
ffmpeg -i test-results/screens/admin--requests-list-all--1280x800--dark.png -vf "crop=1280:560:0:0" -q:v 4 site/assets/screen-requests.jpg
ffmpeg -i test-results/screens/admin--confirm-proposal--1280x800--dark.png -vf "crop=1280:560:0:0" -q:v 4 site/assets/screen-confirm.jpg
```

- A request's own page, `admin--FE-1--1280x800--dark.png`, is not on the landing page: the test's request carries a need that is a Markdown image, which tests that no remote image loads and reads as a fault to a visitor, and its due-date field shows the test machine's locale. The request card of decision (2) shows a request's packet and thread instead.
- Each image is a JPEG of at most 250 KB, with its width and height, `loading="lazy"` and `decoding="async"`, and an alt text that says what it shows. Each is a link to the full image, so a visitor can read it at its size; that makes the windows interactive, and only interactive things lift on hover.
- A window drawn in CSS frames each: a bar with three lamps and the page's address on an example host, `tiehall.example.com`, as the README names one. The windows float on paces of their own, through `translate`, and tilt toward the pointer and glow on hover and focus, through `transform` and `box-shadow` on a transition.
- When the web UI changes, the commands above make new ones; the check holds each file to its size, its kind and the dimensions the page gives.

(2) **A live request card, drawn in HTML and CSS** (the maintainer's answer of 2026-10-17). The card shows `FE-142`, the README's own example key, opened by BE to FE, with its packet in the schema's own field names, `need`, `acceptance_criteria`, `code_refs` and `due_date`, its thread with a question from FE's agent and BE's answer, and its linked pull request. One story runs on a 14-second loop: the packet travels along a cord from BE to FE and FE claims it; a gold dot carries the question back and the question appears; a blue dot carries the answer; the pull request merges and the card turns green and done. Its state label changes with the story, open, claimed, needs info, in progress and done, in the chips' own colors, through generated content in the keyframes; a browser that does not animate generated content keeps "done".
- **It rests on done.** The first and last frame of every keyframes rule of the card is its resting state, which is also what the card shows with no animation: the whole request, packet, question, answer and merged pull request, done. So a renderer that takes the page at its first frame, a paused page or a visitor who asks for reduced motion sees the finished request, and no text of it waits for an animation.
- **One image to a screen reader.** The card is `role="img"` with a label that tells the story; beside it, an ordered list says the same five steps in text, each lit in turn as the card reaches it.
- **Colors** are the live hall's lamps and the web UI's chips: `--lamp-in-progress` for the request, `--lamp-needs-info` for the question, `--lamp-done` and `--chip-done` for done.
- **Its border turns.** A conic gradient of the lamps' colors turns behind the card, a square larger than its diagonal turned through `transform`, which the browser composites, with the card's surface 1.5 pixels inside it.

(3) **A before and after, in the README's words** (the maintainer's answer of 2026-10-17). On the left, how a request travels by hand, as "What Tiehall is" in the README tells it: pasted into the team chat, where replies bury it, its question coming back the same way and asked again, and the context lost. A drawing of a team chat, hidden from screen readers since the text beside it says the same, scrolls upward on a loop, so the pasted request sinks under the replies; its content is written twice so the loop has no seam, and the second copy carries HTML's `hidden` attribute, which the stylesheet's rule for it overrides, so a visitor whose browser still holds an older stylesheet reads the messages once. On the right, Tiehall's one line: the typed request, the question and the answer in its thread, and done when its pull request merges, as an ordered list on a cord along which a light runs. Both sides name teams by their keys, as the hall does, and no person.

(4) **Run it, word for word** (the maintainer's answer of 2026-10-17). The section gives the first four commands of the README's quickstart, which `docs/install.md` holds in its blocks `install-download`, `install-init`, `install-up` and `install-setup-code`, and which the CI of this repository runs. The check reads those blocks from `docs/install.md` and compares them with the page, so the page cannot drift from the docs. The section says, as the README does, that there is no release yet and the commands wait for the first one, and links the install docs. There is no copy button, which takes a script; a `$` before each command comes from the stylesheet, so a visitor who selects a command copies the command alone. Long commands wrap inside the terminal rather than scroll, so a 360-pixel phone shows them whole, and the terminal stands under the section's text at the content's width, so most fit on one line; an option and its value, such as `--url https://tiehall.example.com`, sit in a span that no line break splits, which changes nothing a visitor copies and which the check strips before it compares.

(5) **The hero's type.** The name is larger, set in a gradient from the page's ink to the button's light gold, which shimmers slowly; the gradient is set inside `@supports (background-clip: text) or (-webkit-background-clip: text)`, so a browser without it shows the name in ink rather than in nothing. The tagline's last words, "in one hall.", are in the brand's gold, `--signal`. Beside the call to action, a quieter link leads to the install commands; the page keeps one call to action, View on GitHub. The facts become pills.

(6) **An effect show that stays light.** The effects move through `transform`, `translate`, `opacity` and colors, which the browser composites or repaints in small areas: no new animation changes a `filter`, a shadow or a size, and no blur covers a large area.
- The call to action has a shimmer: a band of the button's light gold crosses it every few seconds, behind its text.
- The request card and the terminal have the turning border of decision (2).
- The bands' top edges are cords along which a light runs, one at a time, as on the hall's cords.
- Behind the screenshots, glows in the hall's blue, gold and green drift slowly, radial gradients of the page's tokens.
- The hero's backdrop of shapes drifts down as the hero leaves the screen, so it seems to lie further back, through `animation-timeline: view()` under the rules of decision (7).
- The hero's glows reach down behind the film instead of ending in a hard edge at the hero's foot: the hero clips its overflow sideways, so the page never scrolls sideways, and at its top, so the glows stay off the top bar, through `overflow-x: clip` and `clip-path`, where the browser has both.
- Hover lifts only what a visitor can click: the screenshots' windows and the buttons.

(7) **Sections rise into view only where the browser ties animations to scrolling.** The cards, the steps, the panels, the request card, the screenshots and the terminal rise into place as they enter the screen, through `animation-timeline: view()`, inside `@supports (animation-timeline: view())` and `@media (prefers-reduced-motion: no-preference)`.
- **Their resting state is shown.** Outside those rules nothing moves them, so a browser without scroll-driven animations, or a visitor who asks for reduced motion, sees every part at once.
- **They are never unseen.** A part starts its rise at 40% opacity, 56 pixels lower and a little smaller, not at nothing: a tool that captures the whole page without scrolling it, where a part below the screen waits at its first frame, still shows every part, faint.
- **The page is what they measure.** A view timeline measures the nearest box that scrolls, and a box that hides its overflow is one, though no one can scroll it; so where the browser has view timelines, the bands clip their overflow, `overflow: clip`, which cuts the same overflow without making a box that scrolls.
- No rule outside a keyframes rule hides content: only the travelling dots, the hall's drawn in SVG and the request card's, start unseen.

(8) **The page's contract is unchanged.** No script, no inline style or event handler, nothing from another host, one stylesheet, colors as tokens whose values are the web UI's dark theme or the live hall's (this change adds the web UI's state chips, notice, danger, success and control border, and the hall's ask border, chip border and stronger glows, each with the web UI's own value), text and background at 4.5:1 or more, the focus ring, nothing wider than 328 pixels outside a media query for wider screens, every SVG with `display="none"` (this change adds none) and the reduced-motion rule that stops every animation and transition.

(9) **The order reads as a story.** The hero and the film say what Tiehall is; the before and after says why; the request card shows one request from open to done, and the screenshots show the web UI where people follow it; the points, how it works, run it, the agents and open source follow. The top bar's links name how it works, run it, the agents and the licenses.

## Risks / Trade-offs

- The screenshots age with the web UI. They are dated by this design, and the commands of decision (1) make new ones.
- Generated content that changes in keyframes is newer than the rest of CSS animations; a browser that does not animate it shows "done" throughout, while the card's colors still tell the story.
- Scroll-driven animations are not in every browser yet; where they are not, the sections are simply there.
