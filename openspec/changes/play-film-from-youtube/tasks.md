# Tasks

One group, after the main change's task 30.15, which built the landing page. Tests come first.

## 1. The film on the landing page

- [x] 1.1 Change `tools/repo-checks/test/site.test.ts` first, so that it fails against the page that linked the attachment: the folder holds `site/film.html`; the home page frames `film.html` alone, with a title, `allow` naming `autoplay`, `encrypted-media`, `fullscreen` and `picture-in-picture`, `allowfullscreen` and `referrerpolicy="strict-origin-when-cross-origin"`, in its own section after the hero; its policy adds `frame-src 'self' https://www.youtube-nocookie.com` and the 404 page none; `film.html` runs no script, loads only the site's own files, has the page's policy and one link, to the player with `autoplay=1&rel=0`, around the poster with its alt text and the label; the home page links `https://youtu.be/5Fk84aDl-r0` and no attachment; the footer says the page sets no cookies and runs no scripts and names YouTube. Verified by the test failing on the old page (4 tests) and passing on the new one.
- [x] 1.2 Build it in `site/index.html`, `site/film.html` and `site/style.css`; verified by `site.test.ts` passing, and in Chrome at 360 and 1,280 pixels wide: the frame is 343 by 193 and 1,056 by 594 pixels, the page does not scroll sideways, the label sits clear of the mark, loading the page requests only the site's own files, and a click on the poster opens YouTube's player in the frame.
- [x] 1.3 Change GP-22 of `docs/maintainers/going-public.md` and its check in `tools/repo-checks/test/going-public.test.ts`, test first, `CONTRIBUTING.md`, and add a note under the main change's task 30.15; verified by `going-public.test.ts` passing and `openspec validate --all --strict`.
