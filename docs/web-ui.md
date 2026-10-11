# The web UI

Tiehall's web UI is where people confirm commitments, answer questions, open requests and watch the requests between teams move. This page says how its pages are laid out, how they follow the system's theme and motion settings, how they work on a phone, what the live hall shows and how it updates, how text is set, and what each kind of page may load and run.

## Pages and navigation

Every page starts with a "Skip to content" link, the first thing the Tab key reaches, then a top bar, the page's content and a footer with the running version, a link to its source and a link to these docs.

A signed-in member's pages share the app shell. Its top bar holds the mark and the name Tiehall, which lead home; the navigation, with Live hall, Inbox, Requests, Members and, for admins, Admin, the current page marked; beside Inbox, the number of proposals that wait for your confirmation, read out as "N waiting"; New request, in gold, the style of a page's main action; and your menu, named by your GitHub login, with Email settings, Connected agents and tokens, and Sign out.

The pages where you make one decision, or have no session, show the mark and the name alone, with nothing else to click: the sign-in page, the setup screen, every review page and confirmation under `/confirm/…`, the consent screen, the device approval page, every refusal page, the page for an address no page serves, the page shown when a page fails to render, and the API changelog page.

The menus are HTML `details` elements: they open and close without JavaScript, with the keyboard, and say whether they are open. The home page shows the banners you may act on, then four cards: what waits for you, the requests addressed to your teams, the live hall and New request.

## Themes and motion

The pages follow your system's light or dark preference; there is no theme setting of Tiehall's own. The live hall is dark whatever the preference.

Motion only shows something that happens: a request moving along a line, a person or an agent at work, a new entry arriving. On every page but the live hall, an animation that repeats stops within 5 seconds and the words beside it stay. When your system asks for reduced motion, no page runs an animation or a transition, and changes show at once. On the live hall, Pause motion stops every animation and starts them again; it shows only once the hall's script runs, and under reduced motion it starts pressed. Nothing flashes more than once in 1.2 seconds.

## Phone width

Every page works in a viewport 320 CSS pixels wide, and zoomed to 200 percent at 640: it does not scroll sideways, apart from a table or a block of code inside its own box, and every control is at least 24 by 24 CSS pixels, apart from a link inside a sentence; under 768 CSS pixels every button, field and navigation item is at least 44 high. Under 768 CSS pixels, the navigation, New request and your menu fold into one menu; the request lists become cards; a request's actions, commitments and timeline move below its thread; and the live hall shows lists instead of its map.

## The live hall

The live hall, at `/hall`, is where every member watches requests move between the install's teams and the people and agents at work on them.

- **What it shows.** Every team, with its requests by state that are not finished and those done in the last 24 hours; a line from each requesting team to each target team with requests between them, with their counts, the line flowing while one of them is in progress; the 200 most recently changed of those requests, each with its key, title, state, claimant and whether it waits for a person; the people and agents at work, those named by a domain event on a request in the last 10 minutes, each with the request, what they did last and, for an agent, its client's name; and "On the line", a feed of the 50 latest events about requests in Tiehall's own words. A team with a question waiting has a gold border and a soft gold glow. On a wide screen the teams sit on a ring as a map, which shows at most 12 people and agents and keeps 20 teams apart; above 20, it shows the 19 most active and one node for the others. Every team is still in the list below.
- **What it never shows.** Security events, to anyone, admins included; a message's text, the packet's text, a proposal's content beyond its kind, an email address, an IP address, a user agent or a token. The only text people and agents wrote that it shows is request titles, team names, logins and client names, always as text. A client registered through Dynamic Client Registration is marked "unverified", since it can name itself anything. It shows only what events record: an agent that reads a request leaves no event, so the hall cannot show it.
- **Its filters.** `team=<KEY>` keeps the lines from and to that team and the people, agents and events on them; `agents=1` keeps only what agents did. Both are in the address, so a narrowed hall is a link you can share.
- **How it updates.** Its script reads the hall's state from `/hall/state`, then holds a long-poll read of `/hall/wait`, which answers as soon as an event about a request commits, so a change reaches the page within 2 seconds. A wait holds at most 25 seconds and then answers with nothing new, and the page waits again at once. After a failed wait it says "Reconnecting" and tries again after 1 second, doubling the delay up to 30. A page in a hidden tab holds no wait and catches up when it is shown again. There is no event stream and no WebSocket, and no agent can read the hall: its reads take only a web session. Without JavaScript the page shows its lists as they stood when it was served, and says so.
- **Sessions.** Opening `/hall` extends your web session as opening any page does; its own reads do not. A hall left open on a wall screen does not keep its session alive: the session ends 7 days after you last opened a page, or 30 days after you signed in, and the hall then says "Signed out", with a link to sign in again.

## Type

The pages set their text in your system's own fonts: San Francisco on Apple's systems, Segoe UI on Windows, Roboto on Android and ChromeOS, and the system's sans-serif font elsewhere, with keys, ids and code in the system's monospace font. No page loads a font, from the install or from anywhere else, and the repository carries no font files. Text in any language your system's fonts cover, Turkish among them, shows in them.

## What each kind of page may load and run

Every page loads its stylesheet, its icons and its manifest from the install alone, and no other site can frame it. The install serves those files itself, to anyone and before setup too, so the setup screen has its look before anyone has signed in; they hold nothing of the install's data.

| Kind of page | What it may run |
| --- | --- |
| The pages the web role renders: the home page, the inbox, the request lists, the new request form, members, email settings, connected agents and tokens, every admin page, the sign-in page, the setup screen, every review page and confirmation, the consent screen, the device approval page and every refusal page | no script at all |
| The API changelog page | no script, and no form |
| The live hall | its one script, `/assets/hall.js`, from the install, under Trusted Types with no policy, so the script cannot write markup into the page |
| A request's page, a team's page, the page for an address no page serves and the page shown when one of them fails to render | only the framework's scripts, which carry a nonce made for that answer |
| The API reference page at `/docs/api`, which [the API docs](api.md) describe | the reference's own scripts, under a policy of its own; it is no page of the web UI and keeps its own look |

No policy of the web UI allows inline styles or scripts, and none names another host apart from where a form leads on: GitHub on the setup screen and the sign-in page, and an agent client's own redirect address on the consent screen and on the sign-in page while that client's authorization waits for you to sign in. No page allows a font. Every page is served with no `style` element and no `style` attribute, and no page can be framed by another site.
