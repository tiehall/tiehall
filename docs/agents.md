# Agents and Tiehall

A Tiehall install is where the agents of a company's teams meet. Each person connects their own coding agent to the install once; every call the agent makes then acts for that person, within that person's role and teams, and the install checks at every call that the person is still a member. This page covers the four ways an agent reaches Tiehall, how agents sign in, what they may do on their own, and the personal access tokens and bot users for tools that cannot sign in the usual way.

## The four ways in

Every way in runs the same operations with the same rules, so an agent may use whichever its client supports.

1. **The MCP server** at `TIEHALL_URL/mcp`, such as `https://tiehall.example.com/mcp`, for any MCP client: Claude Code, Cursor, Codex, Copilot and others. Add it to the client as a remote (HTTP) MCP server. It offers tools only, no MCP resources and no MCP prompts, serves the MCP protocol versions 2026-07-28 and 2025-11-25 from one endpoint, and keeps no session between calls. The first call sends the client to sign in, as [Signing in](#signing-in) describes.
2. **The `tiehall` CLI**, for people and for agents that run commands in a shell. It needs Node.js 22 or later. `tiehall login <url>`, such as `tiehall login https://tiehall.example.com`, signs it in to an install: the CLI prints a code, and you approve it on the install's page at `TIEHALL_URL/device`, which shows the address and time of the request; continue only if you just ran `tiehall login` yourself. The CLI keeps one login per install, in a file only you can read, in its configuration folder (`TIEHALL_CONFIG_DIR`, or `~/.config/tiehall`). Its commands run the same operations as the MCP tools, such as `tiehall inbox`, `tiehall get FE-142`, `tiehall open FE`, `tiehall ask`, `tiehall claim` and `tiehall updates`; `tiehall --help` lists them, every command takes `--json` for the install's JSON answer, and `--install <url>` picks the install when the CLI is signed in to several. Until the first release publishes the CLI on npm, build it from this repository with `pnpm install` and `pnpm --filter tiehall build`, and put `packages/cli/bin/tiehall.mjs` on your `PATH` as `tiehall`.
3. **The Claude Code plugin**, with the Tiehall skill, the MCP connection and the hooks that tell Claude of news on your requests, as [The Claude Code plugin](claude-code-plugin.md) describes.
4. **Request URLs**. Every request has one request URL on the install, its key after the install's URL, such as `https://tiehall.example.com/FE-142`, and every team an intake page, such as `https://tiehall.example.com/FE`, that says how the team wants requests filed and which packet fields it requires. A browser gets the page, after signing in. An agent gets markdown, in which every text people wrote is fenced as data, from the URL with `.md` added or with `Accept: text/markdown`, and JSON, exactly the body of the REST API's read of the request, from the URL with `.json` or with `Accept: application/json`. Every form needs credentials, an access token or a personal access token in the `Authorization` header: there are no secret links, and a call without credentials gets 401 with an answer that says to use `tiehall get` or `get_request` instead. `get_request` and `tiehall get` take a request URL of the install as well as a key.

Tools and services that build on Tiehall call the same operations over the REST API under `/api/v1`, which every install describes at `/api/v1/openapi.json` and renders at `/docs/api`.

The MCP tools are:

| Tool | What it does |
| --- | --- |
| `whoami` | Says who the connection acts for, their teams and the install, and warns when the Tiehall skill in use is older than the install supports. |
| `directory` | Lists the install's teams and the registered APIs with their consuming teams. |
| `open_request` | Opens a request to a team, with its packet. |
| `list_inbox` | Lists the requests addressed to your teams. |
| `whats_new` | Reads your updates, and acknowledges the ones you handled. |
| `get_request` | Reads a request, by key or URL, with its packet and thread, in pages. |
| `post_message` | Posts a comment, a question or an answer in a request's thread. |
| `claim` | Claims an open request of one of your teams. |
| `set_status` | Starts work, releases a claim, or proposes a decline or done. |
| `link_pr` | Links a pull request on GitHub.com to a request. |
| `propose` | Proposes a commitment, such as a due date, for people to confirm. |
| `attach_contract_changes` | Attaches a classified OpenAPI diff to a request as its contract section. |

## Signing in

An MCP client signs in through the install, which is its own OAuth authorization server. The client opens the install's consent screen in your browser, where you are signed in with GitHub; the consent screen shows the client's name, the host that vouches for it, and the host it will send you back to, and you approve the client there with the confirmation step. A client that identifies itself with a Client ID Metadata Document, a document on its own host, is shown with that host; a client that registers itself through Dynamic Client Registration is shown as unverified, because anyone can register any name. An operator can stop the install fetching metadata documents with `TIEHALL_CLIENT_METADATA_FETCH=off` in `.env`; clients then register through Dynamic Client Registration. Dynamic Client Registration accepts at most 10 registrations an hour from one address, and removes a client that was never used 7 days after it registered.

A token carries one or more of three scopes: `requests:read`, `requests:write` and `contracts:report`. There is no admin scope. A client that names no scope is granted `requests:read` and `requests:write`, which the consent screen shows; `offline_access`, which some clients ask for to get a refresh token, is ignored, since every approval brings one. A client that names no resource gets a token for the install's one resource, `TIEHALL_URL/mcp`, which `/api/v1` accepts too. Access tokens live 10 minutes, and refresh tokens are used once and replaced. The page `/tokens`, "Connected agents and tokens", lists every client you approved, the CLI included, and lets you revoke any of them.

## What agents may do on their own

An agent acting for you may open requests, read them, post comments, questions and answers, claim a request of your team, start work, release a claim and link pull requests. Commitments, which bind you or your team, it can only propose: a due date set or changed after the request was opened, a scope change after a claim, a decline, a reassignment, a withdrawal, and marking a request done without a merged pull request. People confirm them in the web UI, as [Commitments and the confirmation step](requester-loop.md#commitments-and-the-confirmation-step) describes. No agent surface offers an admin action or a change to who may do what.

Everything people or other systems wrote reaches agents fenced as data, with a line that says where it came from, so an agent can tell the install's own words from another team's text; [Security and trust](security-and-trust.md) says what that guards against and what it does not.

Agent writes are limited: 60 writes a minute for one token, 5,000 agent writes a UTC day for the whole install by default, which an admin can change on the admin page, `/admin`, under Agent writes, with the confirmation step, 20 requests that agents open for one person in any hour, and 50 requests that agents open from one team to another in a UTC day; requests people open in the web UI count toward neither. A write over a limit gets 429 with a `Retry-After` header. When agents make more than 6 writes on one request within 10 minutes, or 30 in total, since a person last acted on it, the request is flagged `needs_human`, and agents' writes to it are refused until a person posts a message on it from the web UI or confirms one of its proposals.

## Personal access tokens and bot users

A personal access token is for a host that can only send a header, such as a script, a service of your own, or an MCP client whose sign-in does not work with the install. Its value starts with `th_pat_`, it carries the scopes you pick, and it expires within 90 days, or sooner when an admin has set a shorter maximum. You create one on the page `/tokens`, with the confirmation step, and see its value once: the install keeps only a hash of it. Send it in the `Authorization` header, as `Authorization: Bearer th_pat_…`, to `/api/v1` or to `/mcp`; a token anywhere else in a request, such as its query string, is ignored. It acts for you, within your role and teams, like an agent you signed in. The same page revokes it, and a revoked token stops working at once. You are reminded 14 and 3 days before a token expires, in your web inbox, and by email when the install sends email.

An admin decides on the page `/admin/personal-access-tokens` whether personal access tokens may be used at all, and how long a new one may live, at most 90 days; both changes need the confirmation step. While tokens are switched off, every call with one is refused with 403, also for tokens created before.

A company's bot or internal service gets access through a personal access token held by a bot user: a GitHub account of its own, which signs in to the install like a person, through membership of the company's GitHub organization or an invite, and creates its tokens on `/tokens`. An admin marks it as a bot on `/members`; the mark only makes the web UI and `whoami` show the account as a bot. There are no service accounts, and the install refuses OAuth's client credentials grant.
