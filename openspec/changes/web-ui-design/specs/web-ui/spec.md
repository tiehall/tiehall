# Spec Delta: web-ui

## Purpose

Defines how an install's web UI looks and behaves for the people who use it: the assets the install serves itself, one stylesheet with named design tokens, how a request's state looks, the mark and the icons, the type, the page shell and its navigation, the light and dark themes, motion and reduced motion, phone width, accessibility, the content security policy of each kind of page, the request page's recent activity, and the live hall, where members watch requests move between teams and the people and agents at work on them.

## ADDED Requirements

### Requirement: The install serves its own assets

In this capability, a page of the web UI is every HTML page the install serves other than the API reference page at `/docs/api`, which keeps the look and the policy the public-api capability defines and names only the icons in its head. The web role SHALL serve every asset the web UI's pages use itself: the stylesheet at `/assets/tiehall.css`, the live hall's script at `/assets/hall.js`, the icons `/assets/icon.svg`, `/assets/icon-180.png`, `/assets/icon-192.png`, `/assets/icon-512.png` and `/favicon.ico`, and the web app manifest at `/assets/manifest.webmanifest`. The assets hold nothing of the install's data: they SHALL be served to anyone, without a session, and before setup completes, as the self-host-install capability defines for the setup gate; an asset's answer SHALL read no session and SHALL set no cookie. Each answer SHALL carry the asset's exact media type, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, the Content-Security-Policy `default-src 'none'; frame-ancestors 'none'; sandbox`, and a strong `ETag` of its content, and SHALL answer 304 with no body to an `If-None-Match` that names that `ETag`. Pages SHALL name each asset by a URL whose `v` query parameter is a digest of the asset's current content. An answer to a URL whose `v` is that digest SHALL carry `Cache-Control: public, max-age=31536000, immutable`; an answer to any other URL of the asset SHALL carry the current content with `Cache-Control: no-cache`. A path under `/assets/` that names no asset, and any method but GET and HEAD, SHALL get 404, as the public-api capability's error model defines for a route the surface does not offer.

Source: D57 (1), (10), (14); design.md, Decisions this change rests on; design.md, Design: The install's assets

#### Scenario: The stylesheet without a session

- **WHEN** a browser with no Tiehall session requests `https://tiehall.example.com/assets/tiehall.css`
- **THEN** the answer is 200 with `Content-Type: text/css; charset=utf-8` and `X-Content-Type-Options: nosniff`
- **AND** it carries no `Set-Cookie` header

#### Scenario: Assets before setup

- **WHEN** setup is not complete and a browser requests `/assets/tiehall.css`, `/favicon.ico` and `/assets/icon.svg`
- **THEN** each is answered 200 with the asset
- **AND** none of them leads to `/setup`

#### Scenario: The current version is cached for a year

- **WHEN** a page names the stylesheet as `/assets/tiehall.css?v=` followed by the stylesheet's current digest, and a browser requests that URL
- **THEN** the answer carries `Cache-Control: public, max-age=31536000, immutable`
- **AND** a request for `/assets/tiehall.css` with no `v`, or with a `v` that is not the current digest, gets the current stylesheet with `Cache-Control: no-cache`

#### Scenario: A browser revalidates an icon

- **WHEN** a browser requests `/assets/icon-192.png` again with an `If-None-Match` header that names the `ETag` of its first answer
- **THEN** the answer is 304 with no body

#### Scenario: A path that names no asset

- **WHEN** a browser requests `/assets/nothing.css` or `/assets/fonts/OFL.txt`, or sends a POST to `/assets/tiehall.css`
- **THEN** the answer is 404

### Requirement: One stylesheet with named design tokens

Every page of the web UI SHALL take its look from the install's stylesheet, which it SHALL link from the install, and SHALL be served with markup that holds no `style` element and no `style` attribute. The stylesheet SHALL define every color it uses as a named design token, with these values for the main tokens:
- in the light theme: navy ink `#0B1B3A` for text, secondary text `#4A5672`, navy blue `#1F45A3` for links and the focus ring, gold `#E3B341` with ink `#0B1B3A` for a page's main action, navy `#14306E` with white text for a strong secondary action, `#A98000` for lamps that call for attention, ground `#F6F7FA` behind the page, surface `#FFFFFF` for panels and the top bar, and border `#DFE3EC`;
- in the dark theme: ink `#E9EDF5`, secondary text `#A9B3C8`, `#9DB6EE` for links, gold `#F0CB6A` for the focus ring, gold `#E3B341` with ink `#0A1428` for a page's main action, `#2A4A9E` with white text for a strong secondary action, gold `#E3B341` for lamps that call for attention, ground `#0A1428`, surface `#111E38`, and border `#24345A`;
- on the live hall: the dark theme's, on the ground `#071026`, with panels `#0E1A33` and borders `#22325A`.
Gold `#E3B341` SHALL NOT be used for text, nor for a lamp, on the light theme's ground or surface.

Source: D57 (1); D59; design.md, Decisions this change rests on; design.md, Design: The design tokens

#### Scenario: A page takes its look from the stylesheet

- **WHEN** a signed-in member opens `/inbox`
- **THEN** the page links the stylesheet `/assets/tiehall.css` from the install
- **AND** the markup it is served with holds no `style` element and no `style` attribute

#### Scenario: The light theme's ground and ink

- **WHEN** a browser that prefers the light color scheme shows `/inbox`
- **THEN** the page's background is `#F6F7FA`
- **AND** its body text is `#0B1B3A`

#### Scenario: The request's page takes the same look

- **WHEN** a signed-in member opens `https://tiehall.example.com/FE-142`
- **THEN** the page links the same stylesheet
- **AND** the markup it is served with holds no `style` element and no `style` attribute

### Requirement: A request's state looks the same everywhere

Every page that shows a request's state SHALL show it as a chip that names the state in words and uses that state's colors. Where a page shows a state as a lamp, as the live hall does for the requests of each state, with their count in words beside it, and the request page's timeline for each event, the lamp SHALL take that state's lamp color for the page's theme: the light theme's lamp in the light theme, and the dark theme's lamp in the dark theme and always on the live hall.

| State | Words | Light chip: background / text | Dark chip: background / text | Lamp, light theme | Lamp, dark theme and the live hall |
| --- | --- | --- | --- | --- | --- |
| `open` | Open | `#FFFFFF` / `#3E4A63` | `#182748` / `#C4CBD8` | `#6A748D` | `#7A849D` |
| `claimed` | Claimed | `#E6EBF7` / `#1F3F8F` | `#1B2D5D` / `#C1D4FE` | `#364EA0` | `#93A9DD` |
| `in_progress` | In progress | `#14306E` / `#FFFFFF` | `#2A4A9E` / `#FFFFFF` | `#14306E` | `#6E95F0` |
| `needs_info` | Needs info | `#F2CA5B` / `#0B1B3A` | `#E3B341` / `#0A1428` | `#A98000` | `#E3B341` |
| `done` | Done | `#D7F1E3` / `#145A37` | `#0F3A27` / `#86E0B2` | `#0B724B` | `#8FE9BB` |
| `declined` | Declined | `#FBE3E1` / `#9B1E22` | `#451E1C` / `#FBB7B1` | none | none |
| `withdrawn` | Withdrawn | `#EEF0F4` / `#555B66` | `#191F2E` / `#9FA5B2` | none | none |

The lamps of a theme SHALL differ in lightness as well as in hue, so that a reader who cannot tell their hues apart can still tell them apart: every two lamps of a theme at least 6 apart in CIE lightness (L*), and the needs-info and done lamps at least 10.

A request flagged `needs_human`, as the agent-safety capability defines, SHALL also show a second chip that says in words that it waits for a person.

Source: D57 (1), (8); D59 (5); design.md, Decisions this change rests on; design.md, Design: Request states

#### Scenario: A state in the request lists

- **WHEN** FE-142 is `needs_info`, and a member whose browser prefers the light color scheme opens `/requests?list=all`
- **THEN** FE-142's row shows a chip with the words "Needs info"
- **AND** the chip's background is `#F2CA5B` and its text `#0B1B3A`

#### Scenario: The same state in the dark theme

- **WHEN** a member whose browser prefers the dark color scheme opens FE-142's page while FE-142 is `in_progress`
- **THEN** its state chip says "In progress" in `#FFFFFF` on `#2A4A9E`

#### Scenario: A flagged request

- **WHEN** agents' writes have flagged FE-142 `needs_human` and a member opens its page
- **THEN** beside its state chip, a second chip says that it waits for a person

#### Scenario: A lamp in the light theme

- **WHEN** an agent's blocking question moved FE-142 to `needs_info`, and a member whose browser prefers the light color scheme opens FE-142's page
- **THEN** the timeline's entry for that move has a lamp in `#A98000`, beside words that say FE-142 needs info

#### Scenario: Lamps apart in lightness

- **WHEN** the live hall shows a team with a request that needs info and a request done within the last 24 hours
- **THEN** the needs-info lamp `#E3B341` and the done lamp `#8FE9BB` differ by at least 10 in CIE lightness, beside words that name each state

### Requirement: The mark, the favicon and the app icon

The install's mark SHALL be TM1: in a 32 by 32 view box, drawn with round caps and round joins at a stroke width of 2.5, which MAY grow to at most 3.5 at sizes under 32 pixels, the paths `M6.5 16 V7 L16 15.5 L25.5 7 V16` and `M16 17.9 V24` and two circles of radius 2.4 centered at (16, 15.5) and (16, 26.6). Every page's top bar SHALL show the mark beside the name Tiehall, with the mark hidden from assistive technology. The install's icon SHALL be the mark in gold (`#E3B341`) on a navy (`#0A1428`) rounded square, and every page SHALL name it in its head: `/assets/icon.svg` as an SVG icon, `/favicon.ico`, which SHALL hold images of 16, 32 and 48 pixels, `/assets/icon-180.png` as the touch icon, and the manifest `/assets/manifest.webmanifest`, which SHALL give the name Tiehall, the start URL `/`, the display mode `browser`, and the icons `/assets/icon-192.png` and `/assets/icon-512.png` with those sizes. The API reference page at `/docs/api` SHALL name the same three icons in its head, and not the manifest.

Source: D57 (2), (10); D59 (3); design.md, Decisions this change rests on; design.md, Design: The mark and the icons

#### Scenario: The mark's drawing

- **WHEN** `/assets/icon.svg` is read
- **THEN** it draws the paths `M6.5 16 V7 L16 15.5 L25.5 7 V16` and `M16 17.9 V24` and the circles of radius 2.4 at (16, 15.5) and (16, 26.6), with round caps and joins
- **AND** it draws them in gold on a navy rounded square

#### Scenario: The favicon

- **WHEN** a browser with no Tiehall session requests `/favicon.ico`
- **THEN** the answer is an icon file that holds images of 16, 32 and 48 pixels

#### Scenario: A page names its icons

- **WHEN** a signed-in member opens `/inbox`
- **THEN** the page's head names `/assets/icon.svg` as an SVG icon, `/favicon.ico` as an icon, `/assets/icon-180.png` as the touch icon and `/assets/manifest.webmanifest` as its manifest
- **AND** its top bar shows the mark beside the name Tiehall

#### Scenario: The manifest

- **WHEN** `/assets/manifest.webmanifest` is read
- **THEN** it gives the name Tiehall, the start URL `/` and the display mode `browser`
- **AND** it names `/assets/icon-192.png` at 192 by 192 pixels and `/assets/icon-512.png` at 512 by 512 pixels

#### Scenario: The API reference page names the icons

- **WHEN** a signed-in member opens `/docs/api`
- **THEN** the page's head names `/assets/icon.svg`, `/favicon.ico` and `/assets/icon-180.png`, and names no manifest
- **AND** the browser reports no violation of the page's Content-Security-Policy

### Requirement: Text in the system's fonts

The web UI SHALL set its text in the system's own sans-serif font, at the weights 400, 500, 600 and 700, and request keys, team keys, ids and code in the system's own monospace font, each named by a stack of the fonts that the common systems ship, which ends in the generic `sans-serif` or `monospace` family: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` and `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`. Text in any language the system's fonts cover, Turkish among them, SHALL render in them. The install SHALL serve no font file, and no page SHALL load a font, from the install or from another host. Each system's font has widths of its own, so no page's layout SHALL rely on a font's widths: what holds in one system's font SHALL hold in another's.

Source: D57 (14); D61 (1); design.md, Decisions this change rests on; design.md, Design: Type

#### Scenario: Turkish text in the system's font

- **WHEN** a request's title is `Şifremi unuttum bağlantısı: İptal ve ğ` and a member opens its page
- **THEN** the browser renders the title in the first font of the sans-serif stack that the system has
- **AND** the browser requests no font file

#### Scenario: Keys in the system's monospace font

- **WHEN** a member opens `/requests?list=all`
- **THEN** every request key on the page is set in the monospace stack

#### Scenario: No page loads a font

- **WHEN** a browser opens every page of the web UI, as a signed-in admin, as a signed-in member and as a browser with no session
- **THEN** it requests no font file from the install or from any other host

### Requirement: The page shell and its navigation

Every page of the web UI SHALL share one shell: a link that skips to the page's main content, the first element the keyboard reaches; a top bar with the mark; the page's content in one main landmark with one first-level heading; and the footer with the running version and its source link, as the self-host-install capability defines. The shell SHALL take one of two forms:
- the app shell, on the pages a signed-in member uses other than those below: its top bar SHALL hold the mark and the name Tiehall as a link to `/`; the navigation, with the links Live hall (`/hall`), Inbox (`/inbox`), Requests (`/requests`), Members (`/members`) and, for an admin only, Admin (`/admin`), the current page marked as current; beside the Inbox link, while proposals wait for the member's own confirmation, as the requester-loop capability defines the web inbox's standing list, their number with words a screen reader reads; a New request link to `/requests/new`, drawn as a page's main action, in gold `#E3B341` with navy ink, in the light and in the dark theme; and a menu named by the member's GitHub login with Email settings (`/settings/email`), Connected agents and tokens (`/tokens`) and the sign-out form, as the sign-in capability defines;
- the focused shell, on the sign-in page, the setup screen, every review page and confirmation under `/confirm/…`, the consent screen, the device approval page, every refusal page, the page for a path no route serves, the page shown when a page fails to render, and the API changelog page: its top bar SHALL hold the mark and the name and nothing else.
The navigation and the member's menu SHALL open and close without script. In a viewport narrower than 768 CSS pixels, the navigation, the New request link and the member's menu SHALL fold into one menu that opens without script.

Source: D57 (4), (7), (8); D61 (2); design.md, Decisions this change rests on; design.md, Design: The page shell and navigation; design.md, Design: The design tokens

#### Scenario: A member's navigation

- **WHEN** Bob, a member who is not an admin, opens `/requests`
- **THEN** the top bar links Live hall, Inbox, Requests and Members, with Requests marked as the current page
- **AND** it holds no link to `/admin`

#### Scenario: An admin's navigation

- **WHEN** Ada, an admin, opens `/inbox`
- **THEN** the top bar also links Admin

#### Scenario: What waits is counted

- **WHEN** two proposals wait for Bob's confirmation and Bob opens `/requests`
- **THEN** the top bar shows 2 beside the Inbox link, with words that a screen reader reads as 2 waiting

#### Scenario: New request in gold

- **WHEN** Bob opens `/requests` in a browser that prefers the light color scheme, and then in one that prefers the dark color scheme
- **THEN** the top bar's New request link is filled with gold `#E3B341`, with its words in `#0B1B3A` in the light theme and in `#0A1428` in the dark one
- **AND** its words contrast with the gold by at least 4.5:1 in both

#### Scenario: A review page shows one decision

- **WHEN** Bob opens the review page of a decline proposal on FE-142
- **THEN** its top bar holds the mark and the name Tiehall and no navigation
- **AND** its footer shows the running version with the link to its source

#### Scenario: A path no route serves

- **WHEN** a signed-in member opens `https://tiehall.example.com/no-such-page/at-all`
- **THEN** the answer is 404 with a page whose top bar holds the mark and the name Tiehall and no navigation
- **AND** the page links the install's stylesheet

#### Scenario: The menu on a phone without script

- **WHEN** a browser with scripts switched off opens `/inbox` in a viewport 360 CSS pixels wide
- **THEN** the navigation is folded into one menu
- **AND** opening the menu shows Live hall, Inbox, Requests, Members, New request, Email settings, Connected agents and tokens and the sign-out form

#### Scenario: The skip link

- **WHEN** a member opens `/inbox` and presses Tab once
- **THEN** the focus is on a link that leads to the page's main content

### Requirement: Light and dark themes follow the system

Every page SHALL follow the color scheme the browser reports the system prefers: the light theme's tokens when it prefers light or states no preference, and the dark theme's tokens when it prefers dark, as the requirement on the design tokens defines. The live hall SHALL use the dark theme's tokens whatever the preference, on its own darker ground `#071026` and panels `#0E1A33`. Each page SHALL declare the color schemes it uses, so the browser draws form controls and scroll bars in the same scheme. The web UI SHALL offer no theme setting of its own.

Source: D57 (5); D59 (1); design.md, Decisions this change rests on; design.md, Design: Light and dark themes

#### Scenario: A system that prefers dark

- **WHEN** a browser that prefers the dark color scheme opens `/inbox`
- **THEN** the page's background is `#0A1428` and its body text `#E9EDF5`

#### Scenario: The live hall is dark in a light system

- **WHEN** a browser that prefers the light color scheme opens `/hall`
- **THEN** the page's background is `#071026`

#### Scenario: Form controls follow the theme

- **WHEN** a browser that prefers the dark color scheme opens `/requests/new`
- **THEN** the page declares the dark color scheme to the browser
- **AND** the browser draws the form's fields in it

### Requirement: Motion, and reduced motion

An animation SHALL show something that happens, such as a request moving along its line, a person or an agent at work, or a new entry arriving, and nothing SHALL flash more than three times in any one second. Pages SHALL animate only through the install's stylesheet and, on the live hall, its script. On every page but the live hall, an animation that repeats SHALL stop within 5 seconds of starting, and the words it goes with SHALL stay. On the live hall, repeating animations SHALL run only once its script runs; without scripts the page SHALL follow the 5-second rule as every other page does. The live hall SHALL offer a Pause motion button, shown only while its script runs, which SHALL say whether motion is paused and SHALL stop and restart every animation on the page; while motion is paused, changes of state, counts and new entries SHALL still show, without moving. When the browser reports that the system prefers reduced motion, no page SHALL run an animation or a transition, and the live hall SHALL start with motion paused.

Source: D57 (6), (8); design.md, Decisions this change rests on; design.md, Design: Motion and reduced motion

#### Scenario: A repeating animation stops

- **WHEN** a member opens FE-142's page while Mert's agent is at work on it, which the page shows with an animation
- **THEN** 5.5 seconds after the page loads, no animation runs on it
- **AND** the page still says that Mert's agent is working on FE-142

#### Scenario: Reduced motion on every page

- **WHEN** a browser that prefers reduced motion opens `/inbox`, FE-142's page and `/hall`
- **THEN** no animation and no transition runs on any of them

#### Scenario: The live hall under reduced motion

- **WHEN** a browser that prefers reduced motion shows `/hall`, and an agent in team PAY posts a blocking question on PAY-7
- **THEN** the feed lists the question and PAY's count of requests that need info goes up, with no animation
- **AND** the Pause motion button says that motion is paused

#### Scenario: Pausing the live hall

- **WHEN** a member presses Pause motion on `/hall`
- **THEN** every animation on the page stops and the button says that motion is paused
- **AND** pressing the button again starts them

### Requirement: Pages work at phone width

Every page of the web UI SHALL work in a viewport 320 CSS pixels wide, and when zoomed to 200 percent in a viewport 640 CSS pixels wide: its content SHALL reflow so that the page does not scroll sideways, except that a table or a block of code MAY scroll sideways inside its own box; no text SHALL be cut off or overlap other text; and every control SHALL stay usable and at least 24 by 24 CSS pixels, apart from a link inside a sentence or a block of text, as WCAG 2.2 success criterion 2.5.8 allows.

Source: D57 (7); design.md, Decisions this change rests on; design.md, Design: Phone width

#### Scenario: No page scrolls sideways

- **WHEN** each page of the web UI is opened in a viewport 320 CSS pixels wide
- **THEN** the page's content is no wider than the viewport

#### Scenario: A form on a phone

- **WHEN** a member opens `/requests/new` in a viewport 360 CSS pixels wide
- **THEN** every field, its label and the submit button lie inside the viewport
- **AND** every field and button is at least 24 by 24 CSS pixels

### Requirement: Pages are accessible

Every page of the web UI SHALL meet these rules in the light theme, in the dark theme and on the live hall:
- text SHALL contrast with its background by at least 4.5:1, and the focus ring, the borders that show where a form control is, and lamps by at least 3:1, each against the background it sits on;
- every action SHALL be a button, and every move to another page a link with an `href`;
- every form control SHALL have a label, and a refused form SHALL say which fields it refused, next to those fields;
- every element the keyboard can reach SHALL show a focus ring at least 2 CSS pixels wide while it has the keyboard's focus, and the keyboard SHALL reach every control in the order the page reads;
- a state, a lamp or a chip SHALL NOT say anything by color alone: its words, or a count in words, SHALL be beside it;
- every page SHALL name its language, SHALL have one first-level heading, and SHALL use the landmarks for its header, navigation, main content and footer;
- a drawing that only illustrates, such as the mark or the live hall's map, SHALL be hidden from assistive technology, and what it shows SHALL also be on the page as text.

Source: D57 (8); design.md, Decisions this change rests on; design.md, Design: Accessibility

#### Scenario: Contrast in both themes

- **WHEN** every page of the web UI is opened in the light and in the dark color scheme
- **THEN** the text of every visible element contrasts with its background by at least 4.5:1

#### Scenario: The keyboard reaches every control

- **WHEN** a member moves through `/requests/new` with the Tab key only
- **THEN** every field and button gets the focus, in the order the page reads
- **AND** each shows a focus ring at least 2 CSS pixels wide while focused

#### Scenario: Every field has a label

- **WHEN** a screen reader reads the form at `/requests/new`
- **THEN** it reads a label for every field

#### Scenario: A refused form names its fields

- **WHEN** a member submits `/requests/new` without the acceptance criteria that team FE requires
- **THEN** the page says that the form was refused
- **AND** it names the acceptance criteria as missing next to that field

#### Scenario: The live hall's map has a text equivalent

- **WHEN** a screen reader reads `/hall`
- **THEN** it skips the map
- **AND** it reads the lines between teams, the people and agents at work and the feed as text

### Requirement: The content security policy of each kind of page

Every page of the web UI SHALL send a Content-Security-Policy that lets it load styles, images and its manifest from the install alone, and that no other site can frame: `default-src 'none'`, `style-src 'self'`, `img-src 'self'`, `manifest-src 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`, and `form-action 'self'`, which the setup screen extends with GitHub's web origin; the sign-in page with GitHub's web origin and, while an agent client's authorization waits on sign-in, that client's registered redirect URI as the consent screen gives it; the consent screen with the client's redirect URI as its source (its origin, or its scheme for an app's own scheme); and which the API changelog page narrows to `'none'`. No page loads a font, as the requirement on text in the system's fonts defines, so no policy of the web UI SHALL name `font-src`: `default-src 'none'` refuses every font. No policy of the web UI SHALL allow `'unsafe-inline'` or `'unsafe-eval'`, or name another host in any directive but `form-action`. Scripts SHALL run on two kinds of page only:
- the live hall at `/hall` SHALL add `script-src 'self'` and `connect-src 'self'`, so it runs only its script from the install and reads only from the install, and `require-trusted-types-for 'script'` with `trusted-types 'none'`, so its script cannot write markup into the page;
- the pages the web UI renders through its framework, which are a request's page, a team's intake page, the page for a path no route serves and the page shown when one of them fails to render, SHALL add `script-src` with a nonce made for each answer and `'strict-dynamic'`, `connect-src 'self'` and `object-src 'none'`, so only the framework's scripts that carry the nonce run.
Every other page SHALL allow no script, and so in any case SHALL every review page and confirmation under `/confirm/…`, the consent screen, the device approval page, the setup screen, the sign-in page and every refusal page. A JSON answer of the live hall SHALL send `default-src 'none'; frame-ancestors 'none'`. No page SHALL break its own policy: a browser that shows any page of the web UI SHALL report no violation of it.

Source: D57 (9), (14); D61 (1); design.md, Decisions this change rests on; design.md, Design: The content security policy of each kind of page

#### Scenario: A review page runs no script

- **WHEN** Bob opens the review page of a decline proposal on FE-142
- **THEN** its Content-Security-Policy is `default-src 'none'; style-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- **AND** the page holds no script element

#### Scenario: The live hall's policy

- **WHEN** a member opens `/hall`
- **THEN** its Content-Security-Policy holds the page policy with `script-src 'self'`, `connect-src 'self'`, `require-trusted-types-for 'script'` and `trusted-types 'none'` added
- **AND** it allows nothing inline and no other host

#### Scenario: A request's page runs only the scripts with its nonce

- **WHEN** a member opens FE-142's page twice
- **THEN** each answer's `script-src` names a nonce and `'strict-dynamic'` and nothing else
- **AND** the two answers name different nonces
- **AND** neither policy allows `'unsafe-inline'` or `data:` for any kind of resource, or names `font-src`

#### Scenario: The setup screen's form reaches GitHub without a script

- **WHEN** the operator opens the setup screen's GitHub App step
- **THEN** its policy's `form-action` allows the install and GitHub's web origin
- **AND** its policy allows no script

#### Scenario: The sign-in page while an agent client's authorization waits

- **WHEN** a browser with no session reaches the sign-in page from the authorization request of an agent client that registered the redirect URI `https://client.example.com/callback`
- **THEN** the sign-in page's policy's `form-action` allows the install, GitHub's web origin and `https://client.example.com`
- **AND** its policy allows no script

#### Scenario: The page for a path no route serves has a policy

- **WHEN** a signed-in member opens `https://tiehall.example.com/no-such-page/at-all` twice
- **THEN** each answer's Content-Security-Policy has `default-src 'none'`, `style-src 'self'` and a `script-src` that names a nonce and `'strict-dynamic'` and nothing else
- **AND** the two answers name different nonces

#### Scenario: No page breaks its own policy

- **WHEN** a browser shows every page of the web UI, as a signed-in admin, as a signed-in member and as a browser with no session
- **THEN** the browser reports no violation of any page's Content-Security-Policy

### Requirement: The request page shows who works on it and what happened

A request's page SHALL show, from the request's own domain events as the requests capability defines them, who wrote on the request last, as the live hall names people and agents at work, and how long ago; and, while the request is `in_progress` and that write came from an agent within the last 10 minutes, it SHALL say in Tiehall's own words that the person's agent is working on the request. The page SHALL also show a timeline of the request's 20 latest domain events, newest first, each with what happened in Tiehall's own words, who did it and when. Neither SHALL carry any text from a message or from the packet.

Source: D57 (15); design.md, Decisions this change rests on; design.md, Design: The request page's activity

#### Scenario: An agent at work

- **WHEN** Mert's agent, connected through a client whose metadata document names it `Example Agent`, started work on FE-142 40 seconds ago, and a member opens FE-142's page
- **THEN** the page says that Mert's agent is working on FE-142, with the client's name `Example Agent`
- **AND** that the last write was 40 seconds ago

#### Scenario: The timeline

- **WHEN** FE-142 was opened, then claimed by Mert, then an agent asked a blocking question that Selin answered, and then work started, and a member opens FE-142's page
- **THEN** the timeline lists those seven events, newest first: the start of work, the return to `claimed`, the answer, the move to `needs_info`, the blocking question, the claim and the opening, each with who did it and when
- **AND** no entry holds the question's or the answer's text

### Requirement: The live hall

The web UI SHALL offer the live hall at `/hall`, a page where members watch requests move between the install's teams and the people and agents at work on them. Every member SHALL be able to open it, admins and members alike; a browser without a session SHALL be sent to sign in and brought back, as on the web UI's other pages; and no agent surface SHALL offer it or its reads. It SHALL show:
- every team of the install, with its name and key, the number of requests addressed to it in each state that is not terminal, and the number addressed to it that reached `done` within the last 24 hours;
- for each ordered pair of teams with requests between them that are not terminal, a line from the requesting team to the target team, with the number of those requests in each state, and, of all those requests, the 200 most recently changed, each with its key, its title, its state, its claimant's login and whether it is flagged `needs_human`;
- the people and agents at work, as the requirement on what the live hall shows of them defines;
- a feed of the 50 latest domain events about requests, newest first, each said in Tiehall's own words, with the request's key and title, who acted and how long ago.
It SHALL NOT show a security event, to anyone, admins included, nor a message's text, the packet's text, an email address, an IP address, a user agent or a token. The only text people and agents wrote that it SHALL show is request titles, team names, logins and agent clients' names, shown as text as the agent-safety capability defines, and the labels its motion carries SHALL name a request by its key and title only. A member SHALL be able to narrow the live hall to the requests one team opened or receives, with `team=<KEY>`, and to what agents did, with `agents=1`, both in the page's address. Without scripts, the page SHALL show its lists as they stood when it was served, and SHALL say that it updates only with scripts on.

Source: D57 (11), (13); design.md, Decisions this change rests on; design.md, Design: The live hall

#### Scenario: A member watches the hall

- **WHEN** Carol, a member of team OPS only, opens `/hall` while team BE's request FE-142 to team FE is `in_progress`, and an agent in team PAY has asked a blocking question on PAY-7, which team FE opened
- **THEN** the live hall shows teams BE, FE, OPS and PAY, a line from BE to FE with one request in progress, and a line from FE to PAY with one request that needs info
- **AND** the feed lists the blocking question on PAY-7 with PAY-7's title
- **AND** nothing on the page holds the question's text

#### Scenario: No security event, even for an admin

- **WHEN** Ada, an admin, changes Bob's role and then opens `/hall`
- **THEN** no part of the live hall shows the role change

#### Scenario: Narrowed to one team

- **WHEN** a member opens `/hall?team=FE`
- **THEN** the page shows only the lines from or to FE, and only the people, agents and feed entries on those lines' requests

#### Scenario: Agents only

- **WHEN** a member opens `/hall?agents=1`
- **THEN** the people at work and the feed show only what was done with the actor kind `agent`

#### Scenario: A request that reaches done

- **WHEN** FE-142, addressed to FE, reaches `done` while a member's browser shows the live hall
- **THEN** the line from BE to FE no longer counts FE-142
- **AND** FE's count of requests done within the last 24 hours goes up by one
- **AND** the feed lists that FE-142 is done

#### Scenario: Without scripts

- **WHEN** a browser with scripts switched off opens `/hall`
- **THEN** the page shows the teams, the lines between them, the people and agents at work and the feed as they stood when it was served
- **AND** it says that it updates only with scripts on
- **AND** 5.5 seconds after the page loads, no animation runs on it, and no Pause motion button is shown

#### Scenario: An agent's token cannot read the hall

- **WHEN** an agent calls `/hall`, `/hall/state` or `/hall/wait` with an OAuth access token or a personal access token and no session
- **THEN** `/hall` redirects to `/sign-in?return=%2Fhall`, and `/hall/state` and `/hall/wait` answer 401 with an RFC 9457 problem
- **AND** no answer holds a team, a request or an event

#### Scenario: A reassigned request

- **WHEN** FE-142, opened by team BE, is reassigned to team OPS as OPS-7 while a member's browser shows the live hall
- **THEN** the live hall shows OPS-7 on the line from BE to OPS
- **AND** it no longer shows FE-142 on the line from BE to FE

### Requirement: What the live hall shows of the people and agents at work

The live hall SHALL show as at work each person and each agent that a domain event on a request, recorded with the actor kind `agent` or `web_session`, names as its actor within the last 10 minutes: one entry per user, actor kind and client, showing the request of that entry's latest event, the most recent first, at most 12 of them on its map and all of them in its list. For each it SHALL show: the GitHub login of the user the event names, marked as a bot when an admin flagged the user as one; whether they acted as an agent or in the web UI; for an agent, the client's name: for a client identified by a Client ID Metadata Document, the name its document gives, with the document's verified host; for a client registered through Dynamic Client Registration, the name it registered with, marked as unverified, as the agent-access capability defines for the consent screen, and a client that registered no name SHALL be shown as an unnamed client, marked as unverified; `tiehall CLI` with its version for the `tiehall` CLI; and `personal access token` for a personal access token; the request's key and title; what they did last, in Tiehall's own words; and how long ago. An event recorded with the actor kind `system` SHALL be shown as made by Tiehall, and one recorded with the actor kind `integration` as made by GitHub or Jira, by the surface it came through; neither is shown at work. A client's name is text its client chose: it SHALL be shown as text, cut to 40 characters, and never as a link or as markup. The live hall SHALL show only what domain events record: a read, such as an agent reading a request's packet, leaves no event and SHALL NOT be shown.

Source: D57 (11), (13); design.md, Decisions this change rests on; design.md, Design: The live hall

#### Scenario: An agent at work

- **WHEN** Mert's agent, connected through a client whose metadata document at `https://client.example.com/tiehall.json` names it `Example Agent`, started work on FE-142 a minute ago, and a member opens `/hall`
- **THEN** the live hall shows Mert, as an agent, with `Example Agent` and the host `client.example.com`, at work on FE-142 and its title, as having started work a minute ago

#### Scenario: An unverified client

- **WHEN** Deniz's agent, whose client registered through Dynamic Client Registration with the name `Claude Code`, posts a comment on FE-139
- **THEN** the live hall shows Deniz's agent with the client's name `Claude Code`, marked as unverified

#### Scenario: A client with no name

- **WHEN** Deniz's agent, whose client registered through Dynamic Client Registration without a name, posts a comment on FE-139
- **THEN** the live hall shows Deniz's agent with an unnamed client, marked as unverified

#### Scenario: One entry per person, kind and client

- **WHEN** Mert's agent, through one client, posts a comment on FE-139 and then one on FE-142 within a minute, and Mert posts a comment on FE-142 from the request's page
- **THEN** the live hall shows Mert's agent once, at work on FE-142
- **AND** it shows Mert in the web UI once, at work on FE-142

#### Scenario: A person in the web UI

- **WHEN** Selin answers a question on FE-142 from the request's page
- **THEN** the live hall shows Selin at work on FE-142 in the web UI, with no client's name

#### Scenario: Ten quiet minutes

- **WHEN** 10 minutes pass after the latest domain event that names Mert's agent, with no later one
- **THEN** the live hall no longer shows Mert's agent at work

#### Scenario: A read is not shown

- **WHEN** Deniz's agent reads FE-139 with `get_request` and writes nothing
- **THEN** the live hall shows nothing new about Deniz's agent

#### Scenario: Close on merge

- **WHEN** a linked pull request merges and FE-142 moves to `done` as a system action
- **THEN** the feed shows that change as made by Tiehall

### Requirement: The live hall's reads and its long-poll

The live hall SHALL read through two internal reads of the web UI, which run only for a web session, which every member may run, and which no agent surface offers: its state, at `GET /hall/state`, which answers with what the page shows and the number of the newest domain event about a request that it includes, its cursor; and its wait, at `GET /hall/wait?after=<cursor>`, a long-poll in the style of the requester-loop capability's wait endpoint. Both SHALL take the page's `team` and `agents`. The wait SHALL answer as soon as a domain event about a request exists after the cursor, with the new events as the feed says them, the current lines of the requests those events name, the current counts of the teams those requests involve, the people and agents at work, and the new cursor; otherwise it SHALL hold the call at most 25 seconds and then answer 200 with no events and the cursor it was given. When more than 50 such events exist after the cursor, it SHALL answer, with no events, that the page must read its state again. While the app shuts down, the wait SHALL end at once with 503 and `Retry-After: 0`. A security event SHALL NOT end a wait. Both reads SHALL answer JSON with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`; a call without a session SHALL get 401 and a removed member's call 403, as the public-api capability's error model defines, and a credential in an `Authorization` header SHALL NOT stand in for a session. A read of `/hall/state` or `/hall/wait` SHALL NOT extend the web session, as the sign-in capability defines a use's extension: the page makes these reads on its own; opening `/hall`, as opening any page, does extend it. Neither SHALL stream: each answer SHALL be one complete JSON document in answer to one GET. The page SHALL read its state when it starts and then wait again as soon as each wait answers, so that a domain event that commits while its wait holds SHALL reach the page within 2 seconds. While the browser hides the page, it SHALL hold no wait, and once shown again it SHALL wait from its cursor. After a failed wait, it SHALL wait again after 1 second, doubling the delay up to 30 seconds, and SHALL say on the page that it is reconnecting; after a 401, it SHALL stop and say that the member must sign in again. Times on the page SHALL stay current to within 15 seconds without a read.

Source: D57 (12); design.md, Decisions this change rests on; design.md, Design: The live hall

#### Scenario: A question reaches an open hall

- **WHEN** Carol's browser shows `/hall` and its wait holds, and an agent in team PAY posts a blocking question on PAY-7
- **THEN** within 2 seconds the feed lists the blocking question on PAY-7
- **AND** PAY's count of requests that need info goes up
- **AND** the wait's answer holds none of the question's text

#### Scenario: Nothing happens

- **WHEN** no domain event about a request commits during a call to `/hall/wait`
- **THEN** no later than 25 seconds after the call, it answers 200 with no events and the cursor it was given

#### Scenario: A security event does not end a wait

- **WHEN** an admin changes a member's role while a member's live hall waits
- **THEN** the wait does not answer because of the role change

#### Scenario: The app restarts

- **WHEN** the operator restarts the install while a member's live hall waits
- **THEN** the wait answers 503 with `Retry-After: 0`
- **AND** the page says that it is reconnecting, and waits again once the install answers

#### Scenario: A long gap

- **WHEN** 60 domain events about requests commit while a member's laptop sleeps, and its live hall then waits from its earlier cursor
- **THEN** the wait answers that the page must read its state again
- **AND** the page then shows the current state

#### Scenario: A hidden page holds no wait

- **WHEN** a member switches from the live hall to another browser tab
- **THEN** the page holds no wait while it is hidden
- **AND** once it is shown again, it waits from its cursor and lists what it missed

#### Scenario: A signed-out member

- **WHEN** a member's session ends while their live hall waits
- **THEN** the page stops waiting
- **AND** it says that the member must sign in again

#### Scenario: An unattended hall does not keep its session

- **WHEN** Carol signs in at 09:00 UTC on 2026-10-01, opens `/hall` at 10:00 UTC on 2026-10-02, and leaves it open on a wall screen, where its waits go on, without opening another page
- **THEN** the web session expires at 10:00 UTC on 2026-10-09, 7 days after the use that opened `/hall` extended it
- **AND** the page then stops waiting and says that Carol must sign in again

#### Scenario: No stream

- **WHEN** a member's browser shows the live hall for a minute while requests change
- **THEN** every answer it reads from `/hall/state` and `/hall/wait` is one complete JSON document with the media type `application/json`
- **AND** none is a server-sent event stream

### Requirement: The live hall with many teams and on a phone

The live hall's map SHALL keep every team readable: with up to 20 teams, each team SHALL have its own node with its key, its lamps and their counts in words, and no node SHALL overlap another in a viewport 1,280 by 800 CSS pixels; with more than 20 teams, the map SHALL show the 19 teams with the most requests that are not terminal, ties broken by key, and one node that counts the other teams' requests, and every team SHALL still be in the page's list of teams. In a viewport narrower than 768 CSS pixels, the live hall SHALL show no map: it SHALL show the people and agents at work, the feed, and the list of teams with their lamps and counts in words, one below the other, kept up to date by the same waits.

Source: D57 (7), (11); design.md, Decisions this change rests on; design.md, Design: The live hall

#### Scenario: Twenty teams

- **WHEN** the install has 20 teams, with requests that are not terminal between many of them, and a member opens `/hall` in a viewport 1,280 by 800 CSS pixels
- **THEN** each of the 20 teams has its own node, showing its key, its lamps and their counts
- **AND** no two nodes overlap

#### Scenario: Twenty-five teams

- **WHEN** the install has 25 teams and a member opens `/hall` in a viewport 1,280 by 800 CSS pixels
- **THEN** the map shows the 19 teams with the most requests that are not terminal, and one node that counts the requests of the other 6
- **AND** the list of teams names all 25

#### Scenario: A phone

- **WHEN** a member opens `/hall` in a viewport 390 by 844 CSS pixels
- **THEN** the page shows no map
- **AND** it shows the people and agents at work, the feed and every team with its lamps and counts
- **AND** a domain event that commits reaches the feed within 2 seconds
