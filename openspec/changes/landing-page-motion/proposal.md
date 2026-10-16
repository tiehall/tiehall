# Proposal: motion on the landing page

## Why

On 2026-10-17 the maintainer found the landing page at `tiehall.com` too plain and asked for motion graphics, drawn with the tools the maintainers use for motion illustration. Those tools (Remotion, HyperFrames, p5.js) render video; a video loop would put video files in the repository, which D38 (2) keeps out, or load YouTube with every visit. The maintainer chose, the same day, motion drawn in code on the page, as [design.md](design.md#decisions) restates.

## What Changes

- The hero shows Tiehall's hall beside its text: six teams' switchboards on a ring and the cords between them, drawn as one SVG in the page. On one cord a request travels from BE to FE, which claims it; FE's question comes back and BE's switchboard glows gold while it waits; the answer follows, and the line turns green when the request is done. The other cords carry traffic at paces of their own.
- Each of the three steps of "How it works" gets a small moving picture: a packet sent along a line, a question coming back, and a pull request merging with a check.
- Behind the hero, faint shapes of the hall float, and soft blue and gold glows drift behind the hero, the film and two bands.
- Everything moves through the stylesheet's animations, in the web UI's Navy & Gold and its live hall's lamp colors. The page still runs no script, and every animation and transition stops for people who ask for reduced motion.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None: the landing page is no capability of the specs.

## Impact

- **Site:** `site/index.html` and `site/style.css`.
- **Checks:** `tools/repo-checks/test/site.test.ts`.
