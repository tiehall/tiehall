# Design: motion on the landing page

## Context

The landing page (the main change's task 30.15, and the change `play-film-from-youtube`) is plain HTML and CSS: no script, no font file, nothing loaded from another host but the film's player once a visitor starts it, and its policy, `default-src 'none'; style-src 'self'`, blocks inline styles. The web UI has a live hall (D57): teams' nodes on a ring, cords between them, dots that travel the cords, and lamps for a request's states.

## Decisions

(1) **Motion drawn in code, on the page** (the maintainer's answer of 2026-10-17, chosen over video loops rendered with Remotion or HyperFrames). A loop of video weighs megabytes and would be a video file in the repository, which D38 (2) keeps out, or a YouTube player on every visit. An SVG with CSS animations weighs a few kilobytes, stays sharp at every size, runs no script, and draws in the page's own colors.

(2) **The hall is the web UI's live hall, drawn for the page.** Six teams, FE, BE, PAY, iOS, DATA and OPS, on a ring; cords as quadratic curves; the dots that travel them and the lamps take the live hall's colors in the web UI's dark theme, `--lamp-open`, `--lamp-claimed`, `--lamp-in-progress`, `--lamp-needs-info` and `--lamp-done`, which the page's stylesheet now holds with the same values. One story runs on a 12-second loop, a request, its question, its answer and the line turning green, the request's life as the product tells it; five more dots and two flowing cords run on paces of their own, so the hall never stands still.

(3) **Only the stylesheet moves anything.** A dot is a path's dash, `stroke-dasharray: 0.01 200` on a path of `pathLength="100"`, moved by animating `stroke-dashoffset`; lamps and borders change color in keyframes, and glows are `drop-shadow` filters. SVG's own animation elements (`<animate>`, `<animateMotion>`) are not used: no media query stops them, and a person who asks for reduced motion gets none. The reduced-motion rule sets `animation: none` and `transition: none` on everything, which leaves the hall drawn and still, its dots hidden.

(4) **Content is never hidden behind an animation.** No text waits for an animation to appear: an entrance animation that starts from `opacity: 0` leaves the text unseen wherever animations do not run, such as a paused background page or a link preview's renderer.

(5) **Accessible.** The hall is one image to a screen reader, with a label that says what it shows; the steps' pictures are hidden from screen readers, since each step's heading and text say the same.

(6) **Phones.** Under 900 pixels the hall stands under the hero's text at the content's width, 328 pixels on a 360-pixel screen; from 900 it stands beside the text.

(7) **A backdrop that moves** (the maintainer's request of 2026-10-17, "shapes in the background"). Behind the hero, faint switchboards, rings, gold dots and a flowing cord float on paces of their own in one SVG hidden from screen readers and pointers; soft glows in the live hall's blue (`--glow`) and the page's gold (`--attention-glow`) drift behind the hero, the film and two bands. They are radial gradients of the page's tokens, so they load nothing, and the reduced-motion rule holds them still.

(8) **Drawings wait for their stylesheet.** Every SVG of the page carries SVG's own `display="none"`, which any rule of the stylesheet overrides, since a presentation attribute yields to every rule. A visitor whose browser still holds an older stylesheet, GitHub Pages keeping one for 10 minutes after a deploy, or loads none, sees the text alone rather than unstyled black shapes; HTML's `hidden` attribute does not serve, since the browser's own stylesheet applies it to HTML elements alone. Seen on 2026-10-17 right after the first deploy, and checked in Chrome with the new page and the previous stylesheet.
