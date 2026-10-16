# Proposal: play the film on the landing page, from YouTube

## Why

The landing page at `tiehall.com` (the main change's task 30.15) showed the film's poster as a link to the README's attachment, `https://github.com/user-attachments/assets/<id>`. On 2026-10-17 the maintainer found that the link opens the film on a page of its own, and asked that it play on the landing page when clicked, with the option to fill the screen, in a larger area. Checking it the same day showed a worse fault: GitHub serves a Markdown attachment only through a short-lived signed address that it writes into the README's page, so the attachment's own address answers 404 to anyone not signed in to GitHub. The README's player works for them; the landing page's link did not.

The page plays no video of its own: the repository holds the film's poster alone (the main change's D38 (2)). The maintainer chose, on 2026-10-17, to publish the film on YouTube and play it from there, as [design.md](design.md#decisions) restates.

## What Changes

- The film is public on YouTube, `https://youtu.be/5Fk84aDl-r0`, on the channel of the maintainers' public brand, MamiBot, with captions in English and Turkish from the film's narration.
- The landing page shows the film in its own section under the hero, as wide as the page's content, in a 16:9 frame. The frame holds the site's own page, `site/film.html`: the poster and a "Watch the film" label, as one link to the film in YouTube's privacy-enhanced player. Nothing comes from YouTube until the visitor starts the film; the player then fills the frame and can fill the screen.
- Under the frame, a plain link to the film on YouTube.
- The page's Content-Security-Policy lets frames load the site's own pages and `https://www.youtube-nocookie.com` alone, and still runs no script; the footer says what the page loads, the film's player included.
- No link to the README's attachment is left on the page. The README keeps GitHub's player.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None: the landing page is no capability of the specs (the main change's task 30.15 carries no spec requirement).

## Impact

- **Site:** `site/index.html`, `site/style.css` and the new `site/film.html`, which the allowlist's `site/*.html` already holds.
- **Checks:** `tools/repo-checks/test/site.test.ts` and `tools/repo-checks/test/going-public.test.ts`.
- **Docs:** GP-22 of `docs/maintainers/going-public.md`, `CONTRIBUTING.md`, and a note under the main change's task 30.15.
