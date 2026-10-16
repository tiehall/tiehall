# Tasks

One group, after the change `play-film-from-youtube`. Tests come first.

## 1. Motion on the landing page

- [x] 1.1 Add to `tools/repo-checks/test/site.test.ts`, failing on the page without motion: the hero holds one SVG, `class="hall-art"`, `role="img"` with a label that names teams, with six team nodes, at least six cords and one each of the request, question and answer dots; the three steps each hold an SVG hidden from screen readers; no page uses SVG's animation elements or a `style` attribute; the stylesheet has keyframes; and the reduced-motion rule sets `animation: none` and `transition: none` as important. Verified by the four new tests failing first (4 failed) and the whole file passing after 1.2 (48 passed).
- [x] 1.2 Draw the hall and the steps' pictures in `site/index.html` and animate them in `site/style.css` with the live hall's lamp tokens; verified by `site.test.ts` passing, and in Chrome at 1,512 and 360 pixels wide: the story runs (the request, BE glowing gold while it waits, the answer, the line turning green), the other cords move, the steps line up, the page does not scroll sideways, and the hero's text shows without waiting for an animation.
- [x] 1.3 Add the backdrop, test first: `site.test.ts` finds in the hero an SVG `class="backdrop"` hidden from screen readers, with at least six shapes, and the stylesheet's `.backdrop` taking no pointer; then draw it and the glows in `site/index.html` and `site/style.css`. Verified by the new test failing first and all 49 passing after, and in Chrome at 1,512 pixels wide: the shapes and glows sit behind the content and move.
- [x] 1.4 Keep every drawing hidden until its stylesheet loads, test first: `site.test.ts` finds every SVG of the page with `display="none"` and the stylesheet showing `.backdrop`, `.hall-art` and `.step-art`; verified by the test failing first and passing after, and in Chrome: the new page with the previous stylesheet shows the text alone, and with its own the whole design.
