# The activity log

The activity log is the install's record of who did what: every change to a request, and every action that changes who may do what or how the install connects to other systems. This page is for admins. It covers what the log holds, reading it, exporting it, and what it does not prove.

## What the log holds

The log is the install's event log, in two classes:

- **Domain events** record every committed change to a request: opened, claimed, a message posted, a state changed, a proposal made, confirmed or ended, a packet revision, a pull request linked or merged, a change made on its tracker issue, and the rest. They also record every change to the consumer map of [contract changes](contract-changes.md): a team's declaration that it consumes an API, its removal and its re-confirmation, each naming the team, the API and who made the change. These concern no request, so they reach no reader of the requester loop.
- **Security events** record sign-ins, and refused sign-ins with the GitHub account that was refused; role changes, invites, revoked invites and removals, with whether an admin removed the person or they left the GitHub organization; people added to a team or removed from one, naming the admin, the person and the team; changes of the sign-in policy; agent clients approved and agents' grants revoked; personal access tokens created and revoked; integrations connected, changed and disconnected, and new private keys for the GitHub App; APIs registered and unregistered; confirmed contract-change fan-outs; changes to the rules for personal access tokens and to the daily budget of agent writes; the commands an operator runs on the host; exports of the log; and the completion of setup.

Each event carries its number, its time, its class, its type, the ids of what it concerns and who caused it: a person, with the actor kind that says how they acted (an agent's token, or the web UI as `web_session`), or the system, or an operator command. No event holds the text of a message or a packet; the request's page shows those. Other changes to teams, such as creating, renaming or setting one up, are not security events in this version.

Each night, Tiehall compares the members, their roles and the agents' grants with the security events, and adds a `reconciled` event for each difference, so that a change whose event was lost, for example when the app stopped between a sign-in and its event, still shows in the log.

## Reading the log

Admins read the log on `/admin/activity-log`, newest first, filtered by time, by who caused an event, by request and by event type. Only admins see security events; members see the domain events of requests on the request pages and through the readers of the [requester loop](requester-loop.md), and never a security event.

The page shows, next to each security event, the IP address and the user agent it was made from, which the install keeps apart from the event and deletes after 90 days; the event itself stays. A refused sign-in's event keeps naming the GitHub account that was refused, by its login and numeric id, for as long as the event is kept.

## Exporting the log

An admin exports the log as JSONL, one event per line, from the log's page, with the confirmation step. Each line carries the event's number, time, class, type, the ids of what it concerns and who caused it, and no message or packet text; the export leaves out IP addresses and user agents. Each export is itself recorded as a security event.

## What the activity log does not prove

The log is append-only for the app: the app's database role can only add and read events, the database refuses every change and deletion of an event, and only the one-shot `migrate` step receives the database owner's credentials. No operation in any surface, the web UI included, changes or deletes an event.

The activity log is not tamper-evident: whoever holds the database owner role or controls the host can change or delete events without the change being detectable. The append-only rules only stop the app itself from rewriting history. Keep `.env`, which holds the owner's password, and the host as closely held as the data, and keep the exports you may need later off the host.

A tamper-evident log, with a hash chain anchored outside the install, is planned as a later addition. [Security and trust](security-and-trust.md#what-the-activity-log-does-not-prove) says more.
