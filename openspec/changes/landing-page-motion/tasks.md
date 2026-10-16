# Tasks

One group, after the change `play-film-from-youtube`. Tests come first.

## 1. Motion on the landing page

- [x] 1.1 Add to `tools/repo-checks/test/site.test.ts`, failing on the page without motion: the hero holds one SVG, `class="hall-art"`, `role="img"` with a label that names teams, with six team nodes, at least six cords and one each of the request, question and answer dots; the three steps each hold an SVG hidden from screen readers; no page uses SVG's animation elements or a `style` attribute; the stylesheet has keyframes; and the reduced-motion rule sets `animation: none` and `transition: none` as important. Verified by the four new tests failing first (4 failed) and the whole file passing after 1.2 (48 passed).
- [x] 1.2 Draw the hall and the steps' pictures in `site/index.html` and animate them in `site/style.css` with the live hall's lamp tokens; verified by `site.test.ts` passing, and in Chrome at 1,512 and 360 pixels wide: the story runs (the request, BE glowing gold while it waits, the answer, the line turning green), the other cords move, the steps line up, the page does not scroll sideways, and the hero's text shows without waiting for an animation.
