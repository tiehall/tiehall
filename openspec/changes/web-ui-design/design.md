# Design: Web UI design and the live hall

## Context

[proposal.md](proposal.md) says why the web UI gets a visual design and a live hall. This document restates the decision the specs rest on, D57, as public rules, each with its reason and the alternatives that lost; then says how each part looks and is built, what the live hall shows and where its data comes from, how it is tested, and what is left for the maintainer to approve. It cites nothing outside this repository.

**What exists.** The web role renders most pages itself, as HTML strings: `packages/commands/src/html.ts` (`htmlPage`, `PAGE_HEADERS`, the refusal renderer of `github-layer-hardening`'s D50 (7)) and the pages built on it, among them `home-route.ts`, `inbox-page.ts`, `request-lists.ts`, `new-request.ts`, `web-pages.ts` and `admin-pages.ts` (members and the admin pages), `admin-page.ts`, `github-admin-route.ts`, `activity-log-route.ts`, `apis-page.ts`, `email-settings-page.ts`, `sign-in.ts` (the sign-in page), `setup-route.ts`, `confirm-route.ts` with `reviews.ts` (the review pages and confirmations under `/confirm/…`), `consent.ts` and `device-approval.ts`. Their policy is `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, extended by `form-action` on the setup screen, the sign-in page and the consent screen, so no stylesheet, font or image loads, and no page links to another except the home page's list of links. The Next.js app renders a request's page and a team's intake page (`apps/web/app/[key]/page.tsx`, `lib/request-page.tsx`, `lib/intake-page.tsx`), which the proxy negotiates first (`apps/web/proxy.ts`, `request-urls.ts`) and which run the framework's scripts under a nonce made for each answer (`pageContentSecurityPolicy`), with styles `'self' 'unsafe-inline'` and images `'self' data:`. `/docs/api` renders Scalar's bundle under its own policy, and `/docs/api/changelog` is plain HTML with one style element allowed by its hash. Every page has the footer with the running version and its source link (`footerHtml`, `layout.tsx`). The browser tests run the installed Chrome through `playwright-core`; `packages/commands/test/web-ui-hosts-browser.test.ts` visits every route and fails on a request to another host, and names every route file under `apps/web/app`.

**The approved design.** The maintainer approved a design canvas of a brand board and five screens: the live hall, a request's page, the inbox, the setup screen and the form that opens a request. The canvas is kept outside this repository and is not needed: this document restates everything it fixes, the mark, the colors, the type and how each screen is laid out, as rules an implementer can build and test. Where the canvas shows something the domain does not record, such as an agent "pulling the packet", which is a read and leaves no event, this document says what is shown instead.

**How the specs cite this document.** Every `Source:` line of an ADDED requirement cites D57 by its items, such as `D57 (9)`, then `design.md, Decisions this change rests on`, then the sections of this document under "Design", such as `design.md, Design: The content security policy of each kind of page`. A MODIFIED requirement keeps the decision numbers its requirement cited before this change, adds the items of D57 it rests on, and names `design.md, Rules carried from earlier changes`, which says where its unchanged parts keep their sources.

**Constraints.**
- Nothing new loads from, calls or reports to another host (S13). The fonts, the icons, the stylesheet and the live hall's script are served by the install.
- The pages that guard a decision, the review pages and confirmations, the consent screen, the device approval page, the setup screen and the sign-in page, run no script, as they do today; so do refusal pages.
- Updates reach the live hall by pull. No server-sent event stream and no WebSocket (requester-loop: No push paths other than the hooks), and no agent surface offers the live hall: its reads are internal commands of the web UI, as `members.list` is.
- No public contract changes: `/api/v1`, its OpenAPI document, the MCP tools and the packet schema stay as they are. The live hall's reads are internal commands of the web UI.
- Every operation the pages run still goes through `execute()`, as the web session (T3).
- A MODIFIED requirement repeats its heading exactly and keeps every scenario it had.

## Goals / Non-Goals

**Goals:**
- A web UI that reads as one product: one stylesheet, the mark, one type family, one way of showing a request's state, and navigation between its pages.
- A live hall that shows, at a glance and as it happens, which teams ask which for what, where requests wait on a question, and which people and agents are at work, without showing anyone's text beyond a request's key and title.
- Pages that work on a phone, in a dark system theme, with a keyboard and a screen reader, and for people who ask for less motion.
- The same safety as today: no page runs more script than it does now, apart from the live hall's one script from the install, and nothing loads from another host.

**Non-Goals:**
- A theme or motion setting of the web UI's own; the system's preferences decide (D57 (5), (6)).
- A single-page client application, or client-side rendering of any page but the live hall's map.
- Translating the web UI; it stays in English, while text people write, Turkish included, renders in the type family.
- The look of the API reference page at `/docs/api`, which Scalar draws under the policy the public-api capability defines; only its icon links change.
- Push notifications in the browser, a sound, or a live hall for people who are not signed in.
- Showing reads. An agent that pulls a packet or reads a thread leaves no event (requests: The event log), so the live hall cannot show it, and this change adds no record of reads.
- Avatars from GitHub, which would load images from another host; people are shown by their login's initials.

## Decisions

### Decisions this change rests on

- **D57. The web UI gets a real visual design, with motion, and a live hall.** Taken by the maintainer on 2026-10-11, after opening an install in a browser and finding its pages bare, together with the approval of the design canvas and of the recommended defaults for the points the canvas left open. As public rules:
  - **(1) One look.** Every page takes its look from one stylesheet that the install serves, built on named design tokens. The light theme's colors are ink `#14161B`, secondary text `#4A5060`, line blue `#2B4ACB`, signal amber `#F2B33D`, ground `#F6F7F9`, surface `#FFFFFF` and border `#E3E6EB`; the dark theme and the live hall use dark counterparts, on the ground `#0E1117`. A request's state looks the same on every page.
  - **(2) The mark TM1.** In a 32 by 32 view box, with round caps and joins and a stroke of 2.5: the paths `M6.5 16 V7 L16 15.5 L25.5 7 V16` and `M16 17.9 V24`, and circles of radius 2.4 at (16, 15.5) and (16, 26.6). A sharp M sits on top; its middle vertex is a round junction ring, from which a T stem drops to a jack: a tie line between two switchboards. From afar it reads as a T, up close as an M.
  - **(3) Type.** IBM Plex Sans for text and IBM Plex Mono for keys, ids and code, both under the SIL Open Font License, served by the install itself.
  - **(4) A shell with navigation.** Every page shares a top bar with the mark; a signed-in member's pages link the live hall, the inbox with what waits for them, the requests, the members and, for admins, the admin pages. Pages where a person makes one decision or has no session show the mark alone.
  - **(5) Themes.** The web UI follows the system's light or dark preference; the live hall is dark in both.
  - **(6) Motion.** Motion shows something that happens: a request moving along a line, an agent at work, a new entry. It stops under the system's reduced-motion preference, and repeating motion can be stopped.
  - **(7) Phone width.** Every page works at a phone's width.
  - **(8) Accessibility.** Text contrasts at least 4.5:1 with its background; actions are real buttons, controls have labels and the focus is always visible.
  - **(9) A policy per kind of page.** Pages load styles, fonts and images from the install only. The live hall alone runs a script from the install (`script-src 'self'`); the pages the framework renders keep their nonce-bound scripts; review, confirm, consent, device, setup and sign-in pages stay script-free; no page can be framed.
  - **(10) The favicon and the app icon** are the mark, white on ink.
  - **(11) The live hall.** A page where people watch requests flow between teams and see people and agents at work, animated. Every member sees it, as every member sees every request.
  - **(12) Live updates by long-poll.** The live hall reads its state and then holds a long-poll read in the style of the wait endpoint, on the web role, for a web session; no event stream, which the specs forbid, and no agent surface.
  - **(13) Names are untrusted.** The names of agent clients are data their clients chose, shown as text, as every name and title people and agents write.
  - **(14) Nothing from another host.** The install serves every asset the pages use, before setup completes too, so the setup screen has its look.
  - **(15) The request page shows who works on it.** A request's page says who wrote on it last, with their client, and lists what happened to it.
  - **Why.** Tiehall is used by people as much as by agents: they confirm commitments, answer questions and decide who works on what in the web UI, and a UI that does not read as a product is one they will not open. The live hall makes the product's idea, lines between teams that agents work on, visible in one look, which is what a team lead or a newcomer needs to trust it. The defaults keep every safety rule of the existing pages and add no new kind of channel, host or surface.
  - **Alternatives that lost.**
    - *Plain HTML as it is:* what the maintainer rejected.
    - *A CSS framework or CSS-in-JS:* a build step, class names in every page, and for CSS-in-JS inline styles, which need `style-src 'unsafe-inline'`.
    - *A client-rendered application for every page:* scripts on every page, the review pages included, against the rule that keeps them script-free.
    - *Fonts from a font host:* a request to another host on every page, against S13.
    - *A server-sent event stream or a WebSocket for the live hall:* the specs forbid an event stream (requester-loop: No push paths other than the hooks), and a long-poll already serves the loop; a WebSocket is a second protocol through the operator's proxy.
    - *A live hall for admins only:* every member sees every request already (requests: Every member sees every request), so hiding the hall protects nothing.
    - *A theme switch:* a setting to store and a choice to make; the system preference is what people already chose.
    - *The canvas's "pulled the packet":* would need a record of reads, which the event log does not keep (Non-Goals).

### Rules carried from earlier changes

The MODIFIED requirements keep every sentence and scenario they had, except where an item of D57 changes them, and add their new sentences and scenarios. Their unchanged parts rest on the sources their earlier `Source:` lines cite, which stay restated where they were:
- agent-safety "The web UI renders no raw HTML and no remote images": the main change's design.md, Design rules: Agent safety;
- agent-safety "The review page of the confirmation step": the main change's design.md, Self-hosting decisions: S7;
- self-host-install "The setup code guards the setup screen": `github-layer-hardening`'s text, which rests on D45 (5) and (7) of `spec-catch-up`'s design.md, D50 (4) and (8) of `github-layer-hardening`'s design.md, and the main change's design.md, Self-hosting decisions: S3;
- requester-loop "No push paths other than the hooks": D8 and the main change's design.md, Design rules: Requester loop.

### Design

#### The install's assets

- **What.** The stylesheet `/assets/tiehall.css`; the live hall's script `/assets/hall.js`; the icons `/assets/icon.svg`, `/assets/icon-180.png`, `/assets/icon-192.png`, `/assets/icon-512.png` and `/favicon.ico`; the manifest `/assets/manifest.webmanifest`; the fonts under `/assets/fonts/`, by IBM's own file names, such as `/assets/fonts/IBMPlexSans-Regular-Latin1.woff2`; and the fonts' license at `/assets/fonts/OFL.txt`.
- **Served to anyone, before setup too.** They hold nothing of the install, so they need no session and pass the setup gate, which serves `/favicon.ico` and every path under `/assets/` before setup completes; the setup screen and the sign-in page need them while nobody is signed in. An asset answer reads no session and sets no cookie, so it never renews a session either.
- **Headers.** The exact media type (`text/css; charset=utf-8`, `text/javascript; charset=utf-8`, `image/svg+xml`, `image/png`, `image/x-icon`, `application/manifest+json`, `font/woff2`, `text/plain; charset=utf-8`), `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` (which makes the SVG inert should someone open it as a page), and a strong `ETag` from the content's digest, with 304 for a matching `If-None-Match`.
- **Versions.** When the process starts, the asset module reads every file, rewrites each `url()` of the stylesheet to carry its target's digest as `?v=<digest>`, and computes every file's digest, the stylesheet's after the rewrite. Pages name each asset with its `?v=`. An answer to a URL whose `v` is the current digest is `Cache-Control: public, max-age=31536000, immutable`; any other gets the current file with `Cache-Control: no-cache`, so a page from before an upgrade still gets a stylesheet and nothing stale is kept for a year.
- **Not found.** Any other path under `/assets/`, and any method but GET and HEAD, gets 404 `route-not-found`.
- **Where.** The files Tiehall writes live in `packages/commands/assets/`; the fonts come from the dependencies `@ibm/plex-sans` and `@ibm/plex-mono` of `@tiehall/commands`. `packages/commands/src/assets.ts` holds the table of assets, the digests and the answer; `apps/web/app/assets/[...path]/route.ts` and `apps/web/app/favicon.ico/route.ts` call it. `next.config.ts`'s `outputFileTracingIncludes` names the assets folder and the two fonts folders for both routes, so the standalone output, and the image, carry them; an image test reads them from the built image.

#### The design tokens

The stylesheet declares every value below as a custom property on `:root` and uses no color that is not a token. Contrast ratios are WCAG 2.2's, against the background the token is used on.

| Token | Light | Dark (and the live hall) | Used for |
| --- | --- | --- | --- |
| `--ink` | `#14161B` | `#E8EAF0` | text |
| `--ink-2` | `#4A5060` (7.5:1 on ground) | `#8A93A6` (6.1:1 on ground, 5.6:1 on surface) | secondary text |
| `--line` | `#2B4ACB` (7.1:1 on surface) | `#9DB2FF` (9.2:1 on ground) | links, the focus ring, selected navigation |
| `--line-hover` | `#1E3596` | `#C9D4FF` | links under the pointer |
| `--button` | `#2B4ACB`, text `#FFFFFF` (7.1:1) | `#4C69E6`, text `#FFFFFF` (4.7:1) | primary buttons |
| `--signal` | `#F2B33D` | `#F2B33D` | lamps that call for attention; never text on a light ground |
| `--ground` | `#F6F7F9` | `#0E1117` | behind the page |
| `--surface` | `#FFFFFF` | `#151A23` | panels, cards, the top bar |
| `--surface-2` | `#EEF0F4` | `#1C2230` | the current navigation item, table stripes, code |
| `--border` | `#E3E6EB` | `#2A3040` | dividers and panel edges |
| `--control-border` | `#7A8294` (3.9:1 on surface, 3.6:1 on ground) | `#6B7385` (3.7:1 on surface) | the edges of fields and secondary buttons |
| `--notice` | `#FCEFD2`, text `#7A4A00` (6.6:1) | `#3A2C10`, text `#F2C66D` (8.4:1) | refusals and banners |
| `--live` | none: the live hall is always dark | `#4ADE80` (10:1 on surface) | the live hall's "Live" lamp and done lamps |

- **Type.** `--font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif`; `--font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. Sizes 12, 14, 16 (body), 18 (second-level headings), 22 (first-level headings under 768 CSS pixels), 30 (first-level headings) and 40 (the name on the setup screen) pixels; line height 1.5 for text and 1.25 for headings; weights 400, 500, 600 and 700; first-level headings at 600 with −0.01em tracking; section labels at 12 pixels, 600, upper case, 0.08em tracking. No text is smaller than 12 pixels.
- **Space and shape.** A 4-pixel scale: 4, 8, 12, 16, 20, 24, 32, 48 and 64. Radii: 6 for key tags and code, 8 for buttons, fields and navigation items, 12 for cards, 14 for the live hall's team nodes, 16 for panels, and 999 for chips. Content is at most 1,200 pixels wide, with 24 pixels at each side, 16 under 768. Buttons are 40 pixels high, 44 under 768, with 14 pixels of padding at each side.
- **Motion.** `--duration-fast: 150ms`, `--duration: 250ms`, `--ease: cubic-bezier(0.2, 0, 0, 1)`; the loops are named under motion below.
- **Forced colors.** Under `forced-colors: active`, the stylesheet leaves the system's colors alone and keeps every border and the focus outline, so nothing is shown only by a fill.

#### Request states

| State | Words | Light chip: background / text | Dark chip: background / text | Live hall lamp |
| --- | --- | --- | --- | --- |
| `open` | Open | `#EEF0F4` / `#3B4252` | `#232938` / `#C9CFDB` | `#8A93A6` |
| `claimed` | Claimed | `#E6EBFB` / `#1E3596` | `#1A2340` / `#B7C6FF` | `#9DB2FF` |
| `in_progress` | In progress | `#2B4ACB` / `#FFFFFF` | `#4C69E6` / `#FFFFFF` | `#4C69E6` |
| `needs_info` | Needs info | `#FCEFD2` / `#7A4A00` | `#3A2C10` / `#F2C66D` | `#F2B33D`, blinking |
| `done` | Done | `#DDF1E6` / `#145A37` | `#12301F` / `#7EE2A3` | `#4ADE80` |
| `declined` | Declined | `#F1F2F4` / `#5B6170` | `#202530` / `#A3ABBD` | not shown |
| `withdrawn` | Withdrawn | `#F1F2F4` / `#5B6170` | `#202530` / `#A3ABBD` | not shown |

Every chip's text contrasts at least 4.5:1 with its background (the lowest is 4.7:1, in progress in the dark theme; every other is 5.5:1 or more), and every lamp at least 3.7:1 with the live hall's team node (`#151A23`). A chip is 12-pixel, 600-weight text with 4 and 10 pixels of padding and a radius of 999. A request flagged `needs_human` gets a second chip, "Waits for a person", in the `--notice` colors, beside its state.

#### The mark and the icons

- **Drawing.** The mark is drawn with `stroke="currentColor"`, so it takes the color of its context: white on the ink tile of the top bar in the light theme, white on the line-blue tile in the dark theme and the live hall. At 24 pixels and below the stroke grows to 2.75, and to 3.5 at 16, so the ring and the jack stay open; the geometry never changes. It is decoration next to the name Tiehall, so it carries `aria-hidden="true"`.
- **The icon.** The mark in white on an ink rounded square, corner radius 22 percent of its side, the mark at 64 percent of the side and centered. `/assets/icon.svg` is that drawing. `/favicon.ico` holds PNG images of 16, 32 and 48 pixels; `/assets/icon-180.png` is the touch icon, a full square that the phone rounds itself; `/assets/icon-192.png` and `/assets/icon-512.png` keep the mark inside the middle 80 percent, so a phone's mask never cuts it.
- **The manifest.** `name` and `short_name` Tiehall, `start_url` and `scope` `/`, `display` `browser`, `background_color` `#F6F7F9`, `theme_color` `#14161B`, and the two PNG icons. `browser`, not `standalone`, because sign-in leaves the install for GitHub, and a standalone window on some phones hands that round trip to another browser, which loses the session.
- **Every page's head** names `/assets/icon.svg` as `icon` with `type="image/svg+xml"`, `/favicon.ico` as `icon` with `sizes="16x16 32x32 48x48"`, `/assets/icon-180.png` as `apple-touch-icon`, the manifest, and `theme-color` `#F6F7F9` for light and `#0E1117` for dark through `media`; the live hall names `#0E1117` alone.
- **How the PNGs and the ICO are made.** `pnpm icons:generate` (`packages/commands/src/write-icons.ts`) renders `icon.svg` at each size in the installed Chrome, which `playwright-core` already drives for the browser tests, and packs the three favicon sizes into the ICO with a small writer of its own (an ICO file is a header and a directory of PNG images). The files are committed. A test checks each file's size in pixels, the ICO's three images, and that the SVG holds exactly the mark's paths and circles.

#### Type and the self-hosted fonts

- **Source.** `@ibm/plex-sans` 1.1.0 and `@ibm/plex-mono` 2.5.0, IBM's own packages, pinned exactly, both released more than 7 days before this change (2024-11-11 and 2026-06-11), licensed OFL-1.1. The install serves IBM's split WOFF2 files unmodified: for Plex Sans the Regular, Medium, SemiBold and Bold faces and for Plex Mono the Regular and Medium faces, each in IBM's six subsets (Latin1, Latin2, Latin3, Pi, Cyrillic and Greek), each subset declared with the `unicode-range` IBM gives it, so a browser loads only the subsets a page's characters need; Latin1 and Latin2 cover Turkish (`ı` is in Latin1, `ğ`, `ş` and `İ` in Latin2). The faces are about 43 KB (Sans) and 39 KB (Mono) per weight in Latin1 to Latin3.
- **Unmodified, on purpose.** The OFL lets anyone use and redistribute the fonts, and reserves the name "Plex" for IBM's versions: a subset or converted file Tiehall made would have to be renamed. Serving IBM's own files keeps the name and needs no font tool in the build.
- **The license.** `/assets/fonts/OFL.txt` serves the `license.txt` that IBM ships beside the WOFF2 files, which the image carries in the same folder as the fonts; the docs name the fonts and their license.
- **Faces.** `font-display: swap`, so text shows in the fallback font until Plex arrives. No italic faces: the web UI renders no markdown and sets nothing in italics. No `local()` source: a font installed on the person's machine can be another version.
- **The license map.** The fonts are third-party files inside a dependency, as every other dependency's files are; they are not a directory of this repository, so `tools/repo-checks/license-map.json` and `pnpm check:licenses` are unchanged. The README's license section gains a sentence that the image carries the IBM Plex fonts under the SIL Open Font License 1.1.
- **Alternatives.** *Fontsource's packages:* the same fonts repackaged by a third party; IBM's own are the source. *Vendoring the files into this repository:* the license map would need an OFL directory and its own license file, and updates would come by hand rather than through Renovate's reviewed, aged pull requests. *A variable font:* IBM's variable Plex is a separate, larger package and needs nothing more than four weights here. *System fonts only:* no single look across machines.

#### The page shell and navigation

- **The model.** `packages/commands/src/shell.ts` holds one description of the shell for a page: which form it takes, the navigation's links, which is current, whether the member is an admin, how many proposals wait for them, and the member's login. Two renderers draw it: the string renderer in `html.ts`, which every page of the web role uses through `htmlPage`, and `apps/web/lib/shell.tsx`, which the Next.js layout uses. A test renders both for the same member and path and compares their markup.
- **Every page** starts with a "Skip to content" link, the first thing Tab reaches, shown when focused; then the `header` with the top bar; one `main` with `id="content"` and one `h1`; and the `footer` with the running version, the source link and the docs link (self-host-install: The running version links to its source). `lang="en"`.
- **The app shell** is the top bar of a signed-in member's pages: the mark and the name Tiehall, linking to `/`; a `nav` labelled "Main" with Live hall (`/hall`), Inbox (`/inbox`), Requests (`/requests`), Members (`/members`) and, for admins, Admin (`/admin`), the current one with `aria-current="page"` and the `--surface-2` fill; beside Inbox, when proposals wait for the member's confirmation, their count in a line-blue badge whose accessible text is "N waiting", read through `inbox.standing_list` in the page's read-only transaction; a "New request" button-styled link to `/requests/new`; and the member's menu, a `details` element whose summary shows the login's initials and the login, holding Email settings (`/settings/email`), Connected agents and tokens (`/tokens`) and the sign-out form with its CSRF token. The pages it covers: the home page, the inbox, the request lists, the new request form, a request's page, a team's intake page, the live hall, members, team APIs (`/teams/apis`), email settings, connected agents and tokens, and every admin page.
- **The focused shell** is the top bar with the mark and the name alone, not a link: on the sign-in page, the setup screen, every review page and confirmation under `/confirm/…`, the consent screen, the device approval page, every refusal page, the page for a path no route serves, and the API changelog page. These are pages where a person makes one decision, has no session, or reads one message; the shell gives them nothing else to click.
- **Under 768 CSS pixels**, the navigation, New request and the member's menu fold into one `details` menu labelled "Menu" at the top bar's end. Both menus are `details` and `summary`, so they open and close without script, with the keyboard, and announce their state.
- **The home page** (`/`) shows the banners the member may act on (admin alerts and failed mirror jobs, as today), then four cards: what waits for the member, with the count and a link to the inbox; the requests addressed to the member's teams, with a link to `/requests`; the live hall; and New request. It reads nothing the shell and the banners do not already read.

#### Light and dark themes

The stylesheet sets `color-scheme: light dark` on `:root` and redefines the tokens inside `@media (prefers-color-scheme: dark)`; every page also carries `<meta name="color-scheme" content="light dark">`, so the browser draws fields, checkboxes and scroll bars in the same scheme before the stylesheet arrives. The live hall's `body` carries the class `hall`, under which the dark values apply whatever the preference, and its `meta` says `dark`. There is no toggle and no stored choice.

#### Motion and reduced motion

- **What moves.** Only what shows something that happens:
  - on the live hall: a line's dashes flow from the requesting team to the target team while one of its requests is `in_progress` (`cordflow`, 1.4 s, linear, repeating); a dot travels along a line when an event arrives on one of its requests (1.2 s, once), towards the team that did not act; a team node glows while one of its people or agents wrote within the last 60 seconds (`glow`, 2.4 s, repeating); the `needs_info` lamp, and a request's `needs_human` chip, blink (`lampblink`, 1.6 s period, repeating); the three dots of an agent at work pulse (`typing`, 1.2 s, repeating) while their last event is under a minute old; a new feed entry slides in (`slidein`, 0.6 s, once); the "Live" lamp pulses (`livepulse`, 1.8 s, repeating);
  - on a request's page: the line between its two teams flows and the dots of a working agent pulse; on the setup screen, the switchboard drawing's lines flow and its lamps blink; in the inbox, a waiting proposal's lamp blinks and new updates slide in;
  - everywhere: hover, focus and the opening of a menu, at `--duration-fast` or `--duration`.
- **Five seconds.** On every page but the live hall, a repeating animation runs a whole number of times that ends within 5 seconds, then rests on its last frame; the words beside it, such as "working", stay. This keeps WCAG 2.2.2 (pause, stop, hide) without a control on pages that run no script.
- **The live hall's control.** A "Pause motion" `button` with `aria-pressed` in the toolbar stops every animation (it sets `animation-play-state: paused` through a class on the page and no longer starts dots), and starts them again. State changes, counts and new feed entries keep coming while paused; they just do not move.
- **Reduced motion.** Under `prefers-reduced-motion: reduce`, the stylesheet sets every animation to none and every transition to none on every page, and the live hall's script starts with "Pause motion" pressed and never starts a dot, a slide or a glow; changes apply at once.
- **No flashing.** Nothing blinks faster than once in 1.2 seconds, far under three flashes in a second (WCAG 2.3.1), and nothing flashes in red.
- **The browser.** CSS animations stop by themselves in a hidden tab; the live hall's script also starts no dot while the page is hidden.

#### Phone width

Every page is laid out in one column under 768 CSS pixels and works at 320 (WCAG 1.4.10, reflow): no page scrolls sideways; tables, the activity log's rows and blocks of code scroll inside their own box with `overflow-x: auto`; long keys, logins and URLs break (`overflow-wrap: anywhere`); fields and buttons take the full width; and every control is at least 44 pixels high there, above WCAG's 24 by 24 minimum. The request page's side column (actions, commitments, timeline) moves below its main column; the request lists become cards; the setup screen's switchboard drawing moves above the form, at a smaller height; the live hall shows lists instead of its map, as below.

#### Accessibility

- **Contrast.** Every text token pair in both themes is at least 4.5:1 (the table above), and the screenshot tests compute it for every rendered text element (Testing).
- **Real controls.** An action is a `button` or a form's submit button; going to another page is an `a` with an `href`. No click handler on a `div`. The live hall's controls (the team filter, Agents only, Pause motion) are a `select` with a `label`, a checkbox with a `label` and a `button`.
- **Labels and errors.** Every field has a `label`; hints and the "required by FE" marks are tied to it with `aria-describedby`; a refused form shows the refusal in a `role="alert"` region at its top and names each refused field beside it, as the error model's per-field errors give them.
- **Focus.** `:focus-visible` draws a 2-pixel `--line` outline with a 2-pixel offset on every focusable element, at least 3:1 against both grounds; nothing removes the outline. The keyboard order is the reading order; no positive `tabindex`.
- **Never color alone.** A chip carries its state's words, a lamp its count and state in words beside it, the inbox badge its count, and the live hall's legend names each color.
- **Structure.** One `h1` per page; headings in order; `header`, `nav`, `main` and `footer` landmarks; tables with `th` and `scope`; the mark, the switchboard drawing and the live hall's map `aria-hidden`, with what the map shows also in the page as lists.
- **The live hall for screen readers.** The feed is a list; a separate `role="status"` region announces "N new events on the line" at most once every 10 seconds, so a busy install does not talk over the person.

#### The content security policy of each kind of page

| Kind of page | Policy |
| --- | --- |
| A page the web role renders, other than the live hall: the home page, the inbox, the request lists, the new request form, members, team APIs, email settings, connected agents and tokens, every admin page, the sign-in page, the setup screen, every review page and confirmation under `/confirm/…`, the consent screen, the device approval page, every refusal page | `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, with `form-action` extended as today: GitHub's web origin on the setup screen and the sign-in page, the client's redirect URI as its source (its origin, or its scheme for an app's own scheme) on the consent screen |
| The API changelog page | the same, with `form-action 'none'` |
| The live hall at `/hall` | the first row, plus `script-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'` |
| The pages Next.js renders: a request's page, a team's intake page, the page for a path no route serves | `default-src 'none'; script-src 'nonce-<made for this answer>' 'strict-dynamic'; style-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| A JSON answer of the live hall | `default-src 'none'; frame-ancestors 'none'` |
| The assets | `default-src 'none'; frame-ancestors 'none'; sandbox` |
| The API reference page at `/docs/api` | unchanged, as the public-api capability and the main change's T10 define |

- **Why these.** A page needs styles, fonts, images and its manifest, and only from the install. Without `'unsafe-inline'` for styles, text that reached a page as markup could not restyle it, and Next.js and the string pages must emit no `style` attribute or element, which the tests enforce through the browser's own violation reports.
- **The live hall's script.** `script-src 'self'` with no nonce: the page has one script, a file from the install, and no inline script at all. `require-trusted-types-for 'script'` with `trusted-types 'none'` makes every write of markup into the page, such as `innerHTML`, throw in browsers that support Trusted Types, so the script can only build elements and set their text; a test proves that the script never trips it.
- **The framework's pages.** They keep the nonce made for each answer and `'strict-dynamic'`, which every current browser honors, so the framework's own scripts run and nothing else; `'self'` is dropped from their `script-src`, where `'strict-dynamic'` already made browsers ignore it, so that `script-src 'self'` stands on the live hall alone. `default-src` becomes `'none'`, styles lose `'unsafe-inline'` and images lose `data:`; the framework's pages render with the shell's classes and the app's own `not-found.tsx`, and none of them needs more.
- **What stays script-free.** Every page in the first two rows. That is where every decision is made, confirmations, approvals of agent clients and of the CLI, setup and sign-in, and where an agent that drives a browser would want a script to help it.
- **One place.** `html.ts` exports the policies as functions of the page kind, and every route takes its policy from there; `request-urls.ts`'s `pageContentSecurityPolicy` is one of them.

#### The page families

Each family is built on the shell, the tokens and the state chips. What each shows comes from the reads its page makes today, except where a section below adds one.

- **Requests.** A request's page: a header with the key in a mono tag, the state chip, the `needs_human` chip when flagged, the due date when set, the title as the `h1`, the two teams as mono key tags joined by a line drawn in SVG, who opened it and when, and who holds the claim; the activity banner (below); then two columns: the main one with the packet (need, acceptance criteria as a list, code refs and links, the contract section when present, the revision with a link to what changed), the thread (each message with its author's initials, login, team, actor kind and client, the time, and its kind as a chip, other teams' text shown as written text) and the form to post; the side one with the actions the reader may take, the commitments as proposals with their confirm links, and the timeline. The request lists: a filter row (addressed to my teams, opened by me, all, and the state), then a table on wide screens and cards on narrow ones, with key, title, state chip, teams and when it last changed. The new request form: From and To as `select`s joined by the line, the target team's intake notes and required fields in a notice when the form names a team, the fields with "required by <team>" or "optional" in their labels, and the submit button. A team's intake page: the team's name and key, its intake notes as its text, its required fields, its APIs and declarations, and a link to the form for that team.
- **The inbox and the member's pages.** The inbox: "Waiting for you" first, a panel with the signal lamp and each waiting proposal as a card (key, what it proposes, who proposed it, when it expires, what it still needs, "Review and confirm" and "Reject"); then "Updates", with the count of new ones and the acknowledge button, each update a row with key, the update in Tiehall's words, the team and the time; then "Receipts", each with its undo link while the window is open; then the WARN digests and re-confirmation requests. Members, team APIs, email settings and connected agents and tokens: the same panels, tables and forms.
- **The admin pages.** An admin overview with a card per area (people and invites, teams, sign-in policy, GitHub, Jira when connected, personal access tokens and the write budget, APIs, the activity log, backups, the running version), and each area's page with its table and its forms, which link to their review pages as today; banners in the `--notice` colors.
- **The focused pages.** The sign-in page: the mark large, the name, one line on what Tiehall is, and the "Sign in with GitHub" button. The setup screen: two columns on wide screens, the switchboard drawing on the dark ground at the left (three team nodes, lines and lamps, in SVG, aria-hidden), and at the right the step list (Setup code, GitHub App, Sign in) with the current step marked, the step's heading, its explanation and its form; one column on narrow screens. Review pages and confirmations: the action in Tiehall's own words as the `h1`, what will happen as a list, other teams' text in the quoted, fenced style the review pages already use, now drawn as a panel with a left border and its origin as a label, and the confirm and cancel buttons. The consent screen and the device approval page: the same panel layout, with the client's name and host, the warnings in the `--notice` colors, and the IP address and time on the device page. Refusal pages: the status as a large mono number, the title, the detail, the field errors, the way on as a button-styled link and the problem type in mono.

#### The request page's activity

- **The read.** `requests.activity`, an internal read that the web UI runs and no agent surface offers, takes a request's key and returns, from that request's domain events: the latest event with an actor of kind `agent` or `web_session` (who, as the live hall names actors, and when); whether the request is `in_progress` and that event is an agent's within the last 10 minutes; and the 20 latest domain events, newest first, each as the live hall's feed says it. It carries no message or packet text, as events carry none.
- **The page.** A banner under the header says, when an agent is at work, "<login>'s agent is working on this", with the client's name and the working dots, and in any case "last write <time> ago"; the timeline lists the 20 events with a dot in the color of the state they left the request in, what happened, who and when, each time also as a `time` element with its ISO date.
- **Why a read of its own.** The page's other reads return the request, the thread and the proposals; the events are a separate record, and reading them per request keeps the request read unchanged for its other callers.
- **An index by request.** The event log has no index by the request an event names, so a request's latest events would mean a scan of the log. One migration adds `events_request_number`, on `(org_id, (data->>'requestId'), number DESC)` for domain events, built with `CREATE INDEX CONCURRENTLY` in its own non-transactional step, as T4 and the migrator already allow; it only adds, so the previous image still starts (S12). The live hall uses it too, for the time each live request last changed.

#### The live hall

##### What it shows

- **The toolbar.** The page's `h1`, "Live hall"; the live lamp with its words ("Live", "Reconnecting", "Not live: updates need JavaScript" before the script runs, "Signed out"); the filter form (a `select` "Team" with "All teams" and every team by key and name, a checkbox "Agents only", and a "Show" button, a GET form whose fields are `team` and `agents`); "Pause motion"; and "Open a request", a link to `/requests/new`.
- **The map** (wide screens, with scripts). Every team as a node on a ring: its name, its key in mono, a lamp per state with requests addressed to it that are not terminal, and beside the lamps the counts in words, such as "3 open · 1 needs info", plus "2 done in 24 h" when there are any; nodes of teams with nothing live are dimmed. One line per ordered pair of teams with requests between them that are not terminal, from the requesting team to the target team: a curve through the ring's middle, its width from 2 to 6 pixels by the number of requests, its color the lamp color of the most pressing state among them (needs info, then in progress, then claimed, then open), dashed and flowing while one is in progress. Two lines between the same teams, one each way, curve apart. Chips for the people and agents at work, at most 12, placed beside the target team's node of their request: the login's initials in a circle (signal amber for an agent waiting on a question, line blue otherwise), "<KEY> · <client>" with the key in mono, and what they did last. A legend names each lamp color.
- **The lists** (every screen, with or without scripts). "Lines between teams": a table of each pair with the counts by state and the 200 most recently changed live requests under them, each with key, title, state chip, claimant and the `needs_human` chip. "At work": every person and agent at work, as the map's chips say them. "Teams": every team with its lamps and counts. On wide screens with scripts these sit below the map; without scripts, or on a narrow screen, they are the page.
- **The feed**, "On the line": the 50 latest domain events about requests, newest first, each a row with the key in mono, how long ago, and a line in Tiehall's own words: the request's update as the web inbox says it (`updateDescription` of `@tiehall/packet`, without ids), who did it, and the request's title as text. A row about a request that waits on a question or a person has the `--notice` colors.
- **Filters.** `team=<KEY>` keeps the lines from or to that team, the requests between them, the people and agents at work on them, and the feed's events on them; every team still appears on the map and in the list. `agents=1` keeps only the people and agents at work, and the feed entries, whose actor kind is `agent`. Both are in the URL, so a narrowed hall is a link.
- **Never shown.** Security events, to anyone, admins included: they are not events about requests, and the activity log is their place. A message's text, the packet's text, a proposal's content beyond its kind, an email address, an IP address, a user agent, a token. The only text people and agents wrote that the hall shows is request titles, team names, logins and client names, each as text; the animation's labels name a request only by its key and title.

##### Who is at work

- **From events only.** A person or an agent is at work on a request while the latest domain event on that request that names them as its actor is under 10 minutes old. The actor is the event's accountable user with its actor kind and client: `agent` (an OAuth token or a personal access token), `web_session` (shown as "web"), `system` (shown as Tiehall, such as close on merge) or `integration` (shown as GitHub or Jira, by the event's surface).
- **The client's name.** For an OAuth client identified by a Client ID Metadata Document, the `client_name` its document gave when it was fetched, with the document's host, which Tiehall verified; for a client registered through Dynamic Client Registration, the name it registered with and the mark "unverified", as the consent screen shows it (agent-access: The consent screen shows who is asking); for the `tiehall` CLI, "tiehall CLI" and its version from the event's client; for a personal access token, "personal access token". A name is cut to 40 characters and is always text: a DCR client can call itself anything, "Claude Code" included, which is why the mark is there.
- **People.** A login, its initials for the chip, and "(bot)" for a user an admin flagged as a bot. Tiehall shows no GitHub avatar, because it would load an image from GitHub.

##### Where its data comes from

- **Two internal reads**, defined in `packages/catalog/src/hall.ts`, offered on no surface (no REST path, no MCP tool, no CLI command), so the web UI runs them through `execute()` as the web session and no token can: `hall.state` and `hall.wait`. Every member may run them; a removed member gets 403 as for every call (teams-and-roles: Membership is re-checked on every call).
- **The routes.** `/hall` renders the page from `hall.state` in a read-only transaction; `/hall/state` answers `hall.state` as JSON for the script; `/hall/wait?after=<cursor>` answers `hall.wait`. All three take `team` and `agents`. They accept only the session cookie: an `Authorization` header is not read, so an agent's token gets the same 401 as no credentials. The JSON answers carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. Their field names are Tiehall's own and are not part of the public API.
- **`hall.state`** returns `cursor` (the number of the newest domain event about a request), `teams` (key, name, counts by live state, done in the last 24 hours), `lines` (from, to, counts by state), `requests` (the 200 most recently changed live requests: key, title, state, from, to, claimant, `needsHuman`, `changedAt`), `atWork` (as above) and `feed` (the 50 latest events: `seq`, `at`, `type`, key, title, from, to, actor, `line`). It reads teams and live requests with their counts by grouping, the newest domain events by the event log's key in descending order, and the users and agent clients they name, in one read-only transaction.
- **`hall.wait`** takes `after`. It runs in the step `execute()` runs before the call's transaction, as `events.wait` does (`packages/commands/src/events-wait.ts`): it takes a wake-up from `event-wakeups.ts`, reads in a short read-only transaction whether a domain event about a request exists after `after`, and if none, holds until the wake-up, the 25-second hold or the shutdown signal; on a wake-up it waits 250 milliseconds more to gather a burst, then reads. It answers `events` (the new feed entries, oldest first), the current `requests` lines of the requests they name, with `terminal: true` for one that left the hall, the current counts of the teams and lines those requests involve, the current `atWork`, and `cursor`; with more than 50 events after `after` it answers `reload: true` and no events. Security events never wake it to an answer: they send no wake-up, and a wake-up that finds only events of no request holds on. While the app shuts down it answers 503 with `Retry-After: 0` at once.
- **Why 25 seconds.** Under the 30 to 60 seconds after which common proxies and load balancers end an idle response, which an operator's own proxy may set, so a held wait ends on Tiehall's terms with a 200, not as a proxy's 504. The requester loop's wait keeps its 60 seconds.
- **Alternatives.** *The public wait endpoint:* it serves one user's updates, while the hall shows every request, and it holds 60 seconds. *An event stream:* forbidden (Constraints). *Polling every few seconds:* slower, and more requests for the same result.

##### How fast it updates

- **The script's loop.** On start it reads `/hall/state`, draws, and waits on `/hall/wait` with the state's cursor; when a wait answers, it applies the answer and waits again at once from the new cursor. An event that commits while a wait holds reaches the page within the wake-up, the 250-millisecond gathering and a read, well inside 2 seconds.
- **When things go wrong.** A failed wait (a network error, a 5xx, a 503) is retried after 1 second, then 2, 4, 8, 16 and 30, each with up to 20 percent of random spread, and the live lamp says "Reconnecting"; a success resets the delay. A 401 stops the loop and the lamp says "Signed out", with a link to sign in again. A 403 stops it with the refusal's title. `reload: true` makes it read `/hall/state` again and redraw.
- **A hidden page.** On `visibilitychange` to hidden, the script aborts its wait and holds none; when the page is shown again, it waits from its cursor, which brings what it missed, or a reload when it missed more than 50.
- **Time.** Relative times ("now", "40 s", "3 min", "2 h") are recomputed every 15 seconds from each entry's time and the offset between the server's `now` and the browser's clock, with no read; each is also a `time` element with its ISO date.
- **Caps on the page.** The feed keeps 50 entries; the map starts at most 8 dots at once and drops the rest; the at-work list follows each answer.

##### Many teams

- **The ring.** Teams sit on a circle in the order of their keys, evenly spaced, the circle's size from the map's box. Up to 8 teams: large nodes, 220 by 72 pixels, with the name, the key, the lamps and the counts. 9 to 20 teams: compact nodes, 132 by 56, with the key, the lamps and the counts, the name in the node's accessible text and in the list. The positions are computed so that no two nodes overlap at 20 teams in the map's box at a viewport of 1,280 by 800 CSS pixels, and a test checks it for every count from 1 to 20.
- **More than 20.** The map shows the 19 teams with the most live requests, ties by key, and one node "+N teams" that counts the others' live requests; lines to the others end at that node. Every team stays in the "Teams" list, and choosing one in the Team filter shows its lines in full on the map.
- **Lines.** At most one per ordered pair; with many pairs, the widths stay at 2 pixels for pairs of one request, so a dense map stays readable, and the "Lines between teams" table holds the detail.
- **Why a ring.** It needs no layout engine, gives every team the same place every time, and draws every line through the middle, where the flow is easy to follow; a force layout moves nodes on every change.

##### On a phone

Under 768 CSS pixels the script draws no map. The page is one column: the toolbar, wrapped onto as many lines as it needs; "At work" as a horizontal list of chips; "On the line", the feed; and "Teams", each with its lamps and counts in words; then "Lines between teams". The same waits update them; new feed entries slide in unless motion is reduced or paused.

##### Its script

`packages/commands/assets/hall.js`, plain JavaScript in one ES module of its own, with no dependency and no build step, checked by TypeScript (`// @ts-check` with JSDoc types, through `allowJs` and `checkJs` in `packages/commands`'s `tsconfig.json`). It exports its pure parts, the ring layout, the curve of a line, the merge of a wait's answer into the state and the relative time, so Vitest tests them in Node; it runs them only when it is loaded by the page. It builds the map with `document.createElementNS` and sets every text with `textContent`, so under Trusted Types `'none'` nothing it writes can be markup. It is loaded with `<script type="module" src="/assets/hall.js?v=…">`.

#### How it is built

- **No CSS framework, no preprocessor.** One hand-written stylesheet, `packages/commands/assets/tiehall.css`, using custom properties, `:focus-visible`, `prefers-color-scheme`, `prefers-reduced-motion` and `forced-colors`, for the current versions of Chrome, Edge, Firefox and Safari. *Alternatives:* Tailwind, a build step and class names in every page's markup; Sass, a build step for features CSS now has.
- **Pages keep their renderers.** The string pages keep `htmlPage`, which gains the shell, the head links and the page kind's policy; each page's markup gains classes. The Next.js pages keep their server components and server actions; the layout gains the shell and the stylesheet link; `app/not-found.tsx` replaces the framework's default, which carries inline styles.
- **One description of an event.** The feed, the request page's timeline and the inbox say an event in the same words, through `updateDescription`, plus who acted (`packages/commands/src/event-lines.ts`).
- **Dependencies.** Only the two font packages. Both have no install scripts, so the install-script allowlist is unchanged.

#### Testing

- **Unit and route tests** (Vitest): the asset table, digests, headers, 304 and 404; the stylesheet's tokens equal the tables above, the contrast of every text pair computed from them, and the reduced-motion and forced-colors blocks; the icons; the shell model and its two renderers; each page kind's exact policy; `requests.activity`, `hall.state` and `hall.wait` against the Postgres test harness, with a marker string seeded in threads and packets that the tests search every answer for, so no message or packet text reaches them; `hall.js`'s pure functions.
- **Browser tests** (`playwright-core` with the installed Chrome, T17): the live hall end to end against a test install (an event reaches the page within 2 seconds, reduced motion, Pause motion, a hidden page, reconnecting after a restart, 20 and 25 teams, the phone layout, Trusted Types never tripped); the shell and its menus without scripts; and the screenshot tests: every page family at 1,280 by 800 and at 320 by 640 and 390 by 844, in the light and the dark scheme, and the live hall, each checked for no sideways scroll, the contrast of every visible text element against its computed background, a visible focus ring on every element Tab reaches, no violation of the page's policy reported by the browser, and no request to another host. Each screenshot is saved under the test's output folder, which CI uploads as an artifact for people to look at; no test compares pixels with a stored image, because fonts rasterize differently on each system. Browser suites set hook timeouts of 300 seconds and test timeouts of 120 seconds, so they hold on slow CI runners.
- **Inventories.** `web-ui-hosts-browser.test.ts` names the new route files and visits `/hall`, an asset and `/favicon.ico`; the image tests read the stylesheet, a font, the fonts' license and `/favicon.ico` from the built image before setup.

### Text corrections to earlier changes

Applied by this change's task 1.18, once the maintainer approves this change; each is a text edit, with no effect on any spec.

- **`github-layer-hardening`'s design.md, T5:** "The page carries the page headers (no script, nothing loaded, no framing)" becomes "The page carries the page headers (no script, nothing loaded from another host, no framing; the install's stylesheet, fonts and icons, `web-ui-design`, D57 (9))".
- **The main change's design.md, Where the specs leave room:** "The admin UI's layout." becomes "The admin UI's layout, within the shell and the design tokens of `web-ui-design` (D57 (1), (4))."

### Where the specs leave room

- The words of each page's headings, buttons and help text, and the live hall's feed lines beyond what `updateDescription` says, as long as they are Tiehall's own and carry no one's text but titles, names and logins.
- The exact drawing of the setup screen's switchboard and of the lines' curves.
- The order of the admin overview's cards and of the home page's cards.
- The live hall's node sizes and the ring's spacing, as long as no node overlaps another at 20 teams in a viewport of 1,280 by 800.
- How the script spreads its retries, within the delays above.

## Risks / Trade-offs

- [The framework emits an inline style or script that the narrower policy blocks, and a page breaks quietly] → The browser tests fail on any violation the browser reports, on every page; the app's own `not-found.tsx` replaces the framework's styled default.
- [A long-poll per open live hall holds a connection, and a member with many tabs holds many] → A hidden tab holds none; a wait holds no database connection, as `events.wait` holds none; the hold is 25 seconds. The same holds today for agents on `/api/v1/events/wait`.
- [Every member sees who works on what, live] → Every member already sees every request, its thread and who posted each message with which client; the hall shows less than the request pages do, never anyone's text but titles.
- [A DCR client names itself after a known agent] → The "unverified" mark, as on the consent screen, and the verified host for metadata-document clients.
- [Motion distracts or makes people unwell] → Motion only where something happens; five seconds outside the live hall; Pause motion; nothing under reduced motion; no flashing.
- [Fonts add weight to the first visit] → Only the subsets a page's characters need load, about 21 KB per face for Latin1, cached for a year; text shows at once in the fallback.
- [No pixel comparison misses a visual regression] → The screenshots are kept for review on every run, and the structural checks catch overflow, contrast, focus and policy breaks.
- [An old page after an upgrade asks for an old asset version] → It gets the current file without long caching.
- [The live hall's script is code the browser runs on an install's origin] → One file from the install, no dependency, no inline script, Trusted Types `'none'`, and text only through `textContent`.

## Migration Plan

No data migrates and no table is added: the live hall and the request page's activity read the event log, the requests, the teams, the users and the agent clients as they are. One migration adds the index `events_request_number` (The request page's activity), built concurrently and only adding, so a rollback to the previous image needs nothing; the other reads use the event log's primary key in descending order and the existing indexes. On upgrade, browsers fetch the new stylesheet by its new digest. The change adds two dependencies, the route files under `apps/web/app/assets/` and `apps/web/app/hall/`, `apps/web/app/favicon.ico/route.ts` and `apps/web/app/not-found.tsx`, and three internal commands to the catalog; `openapi/v1.json`, `mcp/tools.json` and the packet schema are unchanged.

This change is archived after `add-tiehall-oss-v1`, whose requirements it modifies, and after `spec-catch-up`, `request-body-limit`, `github-app-reachability`, `github-layer-hardening`, `image-os-security-updates`, `init-image-flag` and `decisions-from-groups-15-28`; it starts from `github-layer-hardening`'s text of "The setup code guards the setup screen", which no later change modifies, and its other three MODIFIED requirements are modified by no other change.

## Open Questions

- **A remembered motion choice.** Whether Pause motion should be remembered in the browser for the next visit, such as for a hall shown on a wall screen; today it lasts for the page.
- **A wall-screen mode.** Whether the live hall needs a mode without the shell, for a shared screen, which would need a session that only reads.
- **Older events in the request page's timeline.** Whether the timeline should page back past its 20 events.

## Decisions to approve

Answer "all as recommended", or name a number to change.

1. The web UI gets a new capability, `web-ui`, listed in `openspec/config.yaml`, rather than requirements spread over agent-surfaces and public-api, whose purposes are agents and the API.
2. One hand-written stylesheet with the design tokens above, no CSS framework, no inline styles anywhere.
3. The dark theme's tokens and the state chips' and lamps' colors as the tables above give them, which the canvas did not fix.
4. The fonts come from IBM's own `@ibm/plex-sans` 1.1.0 and `@ibm/plex-mono` 2.5.0, served unmodified, with the OFL text at `/assets/fonts/OFL.txt`; no italics, no `local()`.
5. Assets are served to anyone, before setup too, with `?v=` digests and year-long caching for the current version.
6. The icons are made by a committed script with the installed Chrome and committed as files; the manifest uses `display: browser`.
7. The focused shell, without navigation, on the sign-in page, the setup screen, review pages, the consent screen, the device approval page, refusal pages, the not-found page and the API changelog page.
8. The navigation is Live hall, Inbox with the waiting count, Requests, Members and Admin; email settings, tokens and sign-out sit in the member's menu; both menus use `details` without script.
9. The home page shows the banners and four cards.
10. Outside the live hall, repeating animations stop within 5 seconds; the live hall has Pause motion; reduced motion stops everything.
11. Pages work at 320 CSS pixels, with 44-pixel controls under 768.
12. The policies of the table above: the framework's pages drop `'self'` from `script-src`, `'unsafe-inline'` from styles and `data:` from images, and take `default-src 'none'`; the live hall adds Trusted Types `'none'`.
13. The request page gets `requests.activity`, its banner and its 20-event timeline, on a new index of the event log by request.
14. The live hall at `/hall`, for every member, with the content, the filters and the never-shown list above, and security events hidden from admins too.
15. At work means an event in the last 10 minutes; at most 12 chips on the map; client names cut to 40 characters, DCR clients marked unverified.
16. `hall.state` and `hall.wait` are internal reads, session only; the wait holds 25 seconds, gathers 250 milliseconds, and asks for a reload past 50 events.
17. The script's retries run from 1 to 30 seconds, a hidden page holds no wait, and relative times refresh every 15 seconds.
18. Up to 20 teams each get a node on a ring; above 20, the 19 most active and one node for the rest.
19. Under 768 CSS pixels the live hall shows lists, no map.
20. Screenshots are kept as CI artifacts with structural checks, and no test compares pixels.
21. The two text corrections to `github-layer-hardening`'s T5 and to the main change's "Where the specs leave room".
