# Spec Delta: agent-safety

## Purpose

States that every name and title people and agents write, on the live hall too, is shown as text, and that review pages take the install's stylesheet and still run no script. The rest of the capability is unchanged.

## MODIFIED Requirements

### Requirement: The web UI renders no raw HTML and no remote images

The web UI SHALL NOT render raw HTML from request content, nor from any other text people or agents write that it shows, such as a team's name, a person's login or an agent client's name, and SHALL NOT load remote images referenced in request content. Every page that shows such text, the live hall included, SHALL show it as text; the live hall's script SHALL put it into the page only as text, never as markup, as the web-ui capability defines for the live hall.

Source: D57 (13); design.md, Decisions this change rests on; design.md, Design: The live hall; design.md, Rules carried from earlier changes

#### Scenario: HTML in a message is not rendered

- **WHEN** a message contains `<img src=x onerror=alert(1)>`
- **THEN** the request page does not render it as HTML
- **AND** no script runs

#### Scenario: A remote image is not loaded

- **WHEN** a message contains the markdown image `![x](https://tracker.example/pixel.png)`
- **THEN** a browser showing the request page makes no request to `tracker.example`

#### Scenario: Markup in a client's name on the live hall

- **WHEN** an agent client registered through Dynamic Client Registration with the name `<img src=x onerror=alert(1)>` posts a comment on FE-142, and a member's browser shows the live hall
- **THEN** the live hall shows the name as those characters, cut as the web-ui capability defines
- **AND** no image loads and no script runs

#### Scenario: Markup in a title on the live hall

- **WHEN** a request is opened with the title `<script>alert(2)</script>` while a member's browser shows the live hall
- **THEN** the live hall's feed shows the title as those characters
- **AND** no script runs

### Requirement: The review page of the confirmation step

Before an action that needs the confirmation step, Tiehall SHALL show the person a review page. A GET of the page SHALL render a review of exactly what will happen, in Tiehall's own words, with any text from other teams fenced as this capability defines, and SHALL NOT change any state; only the POST that the page sends SHALL apply the action. Every review page, including the confirm page of a proposal, SHALL send a Content-Security-Policy with `frame-ancestors 'none'`, and SHALL run no script: its policy SHALL allow no script, and SHALL let the page load only the install's stylesheet, fonts, images and manifest, from the install itself, as the web-ui capability defines for the content security policy of each kind of page. The requests capability defines what a proposal's confirm page shows and who may confirm or reject from it.

Source: D57 (9); design.md, Decisions this change rests on; design.md, Design: The content security policy of each kind of page; design.md, Rules carried from earlier changes

#### Scenario: Opening the page changes nothing

- **WHEN** the review page for removing Lee is fetched with GET several times
- **THEN** Lee is still a member

#### Scenario: The page cannot be framed

- **WHEN** any review page is served
- **THEN** its response carries a Content-Security-Policy with `frame-ancestors 'none'`

#### Scenario: The review states the exact action

- **WHEN** Alice opens the review page for creating a personal access token with the scope `requests:read` that expires on 2026-12-01
- **THEN** the page states, in Tiehall's own words, that a token with the scope `requests:read` expiring on 2026-12-01 will be created for Alice

#### Scenario: A review page runs no script

- **WHEN** any review page is served, the confirm page of a proposal included
- **THEN** its Content-Security-Policy allows no script, and allows styles, fonts, images and the manifest from the install only
- **AND** the page holds no script element
- **AND** it takes its look from the install's stylesheet
