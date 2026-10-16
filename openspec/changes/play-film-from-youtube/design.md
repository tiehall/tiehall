# Design: play the film on the landing page, from YouTube

## Context

The landing page is plain HTML and CSS in `site/`, published by GitHub Pages (the main change's task 30.15 and GP-22 of `docs/maintainers/going-public.md`). It runs no script, sets no cookie, has no tracker, and its Content-Security-Policy kept it from loading anything from another host. The film, "Every Team's Line", 53 seconds with English narration, plays in the README as a GitHub attachment, and the repository holds only its poster (the main change's D38 (2)).

On 2026-10-17 the maintainer asked that the film play on the page when clicked, with the option to fill the screen, in a larger area. The page linked the attachment's address, which answers 404 to visitors who are not signed in to GitHub.

## Decisions

(1) **The film plays from YouTube** (the maintainer's answer of 2026-10-17). It is public at `https://youtu.be/5Fk84aDl-r0`, on the channel of the maintainers' public brand, MamiBot, the film's drawn character, with captions in English and Turkish taken from the film's narration script, and embedding allowed. Alternatives the maintainer was offered: the MP4, 9.2 MB, in `site/` and played in a native `<video>` from `tiehall.com`, which adds about 9 MB to the history with each version of the film and undoes D38 (2); or the MP4 kept out of git, published as a release asset and fetched by the Pages workflow at deploy time with a pinned checksum, which needs a release before the first version and a step in the deploy.

(2) **Nothing comes from YouTube until the visitor starts the film** (the maintainer's answer of 2026-10-17, which chose it over a player that loads with the page and plays in one click). The page frames its own page, `site/film.html`, whose one link, the poster with its label, leads to `https://www.youtube-nocookie.com/embed/5Fk84aDl-r0?autoplay=1&rel=0`, YouTube's privacy-enhanced player. A visitor's click opens the player in the frame; browsers let a video with sound start by itself only after a click inside the player's own frame, so a second click starts the film where the browser asks for one. `rel=0` keeps the suggestions at the end to the same channel.
- The page still runs no script: the click is a link's, and the frame is the site's own page until then. A page made with a script, such as the common "lite" embeds, would load the player on the first click but would break the page's rule of no script.
- The frame allows `autoplay`, `encrypted-media`, `picture-in-picture` and `fullscreen`, and sends the referrer as `strict-origin-when-cross-origin`, since YouTube's embedded player refuses to play when it cannot tell where it is shown.
- The home page's policy adds `frame-src 'self' https://www.youtube-nocookie.com` and nothing else; `film.html` has the page's own policy, with no frame, and asks search engines not to index it.

(3) **The film has its own section, as wide as the page's content** (the maintainer's request of 2026-10-17). The hero keeps the name, the tagline, the sentence and the call to action, and the film follows it in a 16:9 frame, 1,056 pixels wide on a desktop and the screen's width less its gutters on a phone. The label sits in the poster's corner, clear of the mark, smaller in a narrow frame.

(4) **The footer says what the page loads.** It said the page loads nothing from another host; it now says that the page sets no cookies and runs no scripts, and that the film plays in YouTube's privacy-enhanced player, which loads from YouTube only once the visitor starts it.

(5) **The README keeps GitHub's player**, which plays the attachment for visitors who are signed out, through the signed address GitHub writes into the page.

## Risks / Trade-offs

- YouTube's player, once started, is YouTube's: its scripts and its privacy policy apply inside the frame. The page says so in its footer.
- A new film version, such as the end card that changes at the first release (GP-20), is a new YouTube video with a new id, which the page and its check take through a pull request.
