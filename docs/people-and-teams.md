# People and teams

An install holds one company: its people, each signed in with their own GitHub account, and its teams, which requests are addressed to. This page is for admins. It covers the two roles, who may sign in and the sign-in policy, invites, removing people, and teams. Every page named here is in the web UI; a member who is not an admin gets 403 on an admin page, and no agent surface offers any of these actions.

## Roles

There are two roles, `admin` and `member`. Admins invite people, change roles, remove people, manage the teams and who belongs to them, set the sign-in policy, connect the integrations, register APIs, set the rules for personal access tokens and the daily budget of agent writes, and read and export the activity log. Members open, claim and work on requests, and declare which APIs their teams consume; every member sees every request. A person's role bounds everything done for them, through their web session or through any agent's token.

The members page, `/members`, lists every member with their role, their teams and the bot mark. An admin finds there, for each member, the review page that makes them an admin or a member, and the one that removes them, each with the confirmation step, and the form that sets or clears the bot mark. The admin pages link to one another from the admin page, `/admin`.

An install always keeps at least one admin: a role change or a removal that would leave none is refused with 409. Roles are set in Tiehall, never taken from GitHub, so an owner of the GitHub organization is not an admin until an admin makes them one. When nobody can sign in as an admin any more, the operator makes a member an admin on the host with `admin grant <github-login>`, as [the install docs](install.md#commands-on-the-host) show.

## Who may sign in, and the sign-in policy

People sign in with GitHub only, through the install's GitHub App: there are no passwords. A person may sign in when they are a member of a GitHub organization in which the App has a connected installation, when they hold a valid invite, or when they are a member of the install already. New members join with the role `member`, in no team. Anyone else is refused with 403 and told to ask an admin for an invite. When only the organization's membership could admit a person and GitHub fails to answer that look-up, with a server error or not within 10 seconds, the sign-in gets 502 instead, which says that GitHub could not be reached and to try again: nobody joins, and no refused sign-in is recorded.

The sign-in policy, on `/admin/sign-in-policy`, is "organization members and invited people" in a new install. An admin can change it to "invited people only", with the confirmation step: then membership of the GitHub organization no longer admits anyone new, and only an invite does.

Membership of the GitHub organization is followed both ways. A member who joined through the organization is removed when they leave it: when a connected installation that is working reports that the account left an organization Tiehall saw it in, and no other connected installation reports it a member of its organization. Tiehall checks at each sign-in, when GitHub reports that a member left, and every 15 minutes. A failed look-up, and an installation that is suspended, deleted or disconnected, never count as leaving. People who joined through an invite, or by completing setup, are not removed this way, and neither is the install's only admin until there is another.

## Invites

An admin invites a person on `/admin/invites`, by their GitHub username and with a role, `member` unless the invite names `admin`. Tiehall looks the username up on GitHub as the form is sent, and refuses a username that names no person's account, or a member's. The review page names the account by its login, its numeric id and when it was created; confirming it creates the invite, bound to that account, so a renamed login keeps it and someone who later takes the old login does not. An invite needs no email: the person accepts it by signing in with that GitHub account within 7 days, after which it expires. An account has at most one waiting invite, and a new one replaces it. An admin can revoke a waiting invite on the same page, with no confirmation step, since revoking only narrows who may sign in.

## Removing a member

An admin removes a member from `/members`, with the confirmation step. A removal ends the person's web sessions and revokes their agents' grants and their personal access tokens, so none of them works again, and takes them out of every team. Their requests, messages and the record of what they did stay. A removal by an admin also blocks the GitHub account from coming back through organization membership: only an invite that an admin creates after the removal admits it again, and the person then starts with the invite's role, in no team, with nothing from before.

## Teams

An admin manages the teams on `/admin/teams`: creates a team, renames it, changes its key, and adds members of the install to it or takes them out. A team's key is 2 to 10 characters, uppercase letters and digits, starting with a letter, such as `FE` or `PAY2`; it names the team's requests, such as `FE-142`, and its intake page, such as `TIEHALL_URL/FE`. When a key changes, the old key stays the team's, and the old request keys and URLs lead to the same requests. A person can belong to several teams, and a team can have no members. A team cannot be deleted in this version; one no longer used keeps its key and its requests.

On the same page, an admin sets each team's intake settings: the notes that say how the team wants requests filed, which its intake page shows to people and agents, and the required fields, the packet fields that every request a person or an agent opens to the team must carry, such as acceptance criteria or a due date. A request that lacks one is refused, naming each missing field. There too, an admin maps the team to the GitHub repository its requests are mirrored into, as [GitHub and Jira](github-and-jira.md#mirrors) describes.
