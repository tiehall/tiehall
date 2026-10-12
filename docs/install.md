# Installing and running Tiehall

Tiehall runs on one host with Docker and Docker Compose: Tiehall itself and a Postgres 17 database, started with one command once its `.env` is written. This page covers installing it, the setup screen, TLS, backups, upgrades and rollbacks, the commands an operator runs on the host, and the connections an install makes.

The commands below run in the install's folder on the host, which holds the release files and `.env`. The CI of this repository runs each of them, in its fresh-install, backup and upgrade jobs.

## What you need

- A host with Docker and the Docker Compose plugin. Nothing else runs beside them: no cache, no object store and no service of ours.
- A GitHub organization for the company, where you can create and install a GitHub App. People sign in to Tiehall with GitHub only.
- A host name for the install, such as `tiehall.example.com`, that resolves to the host, and a way to serve it over HTTPS: the `caddy` profile below, or your own reverse proxy. For a trial on one machine, `http://localhost` works without TLS.
- GitHub.com reachable from the host and from people's browsers. Air-gapped installs are not supported.

## Download the release files

Each release names its image, pinned by version and digest, and publishes these files: `compose.yaml`, the `Caddyfile`, `.env.example`, which the release page names `env.example` because GitHub keeps no leading period in a release file's name, `backup.sh` and `restore.sh`. The release notes also show how to check, with `gh attestation verify`, the signed build provenance and SBOM the image carries. In a new folder for the install, download the files from the release, where `<release>` is the address of the release's files that the release notes give:

```sh docs-test=install-download
for file in compose.yaml Caddyfile backup.sh restore.sh; do curl --fail --silent --show-error --location --remote-name "<release>/$file"; done
curl --fail --silent --show-error --location --output .env.example "<release>/env.example"
chmod +x backup.sh restore.sh
```

## Write `.env` with `init`

The image's `init` role prints a complete `.env` with fresh random secrets. Give it the install's URL and the image reference from the release notes, `<image>` below. The `umask` makes `.env`, which holds the install's secrets, readable by you only, from the moment it is written:

```sh docs-test=install-init
(umask 077 && docker run --rm <image> init --url https://tiehall.example.com --image <image> > .env)
```

Read the file before you start. It holds every install setting, each with a comment:

- `TIEHALL_URL` is the install's public base URL. It must use `https://`, except `http://localhost`, with or without a port, for a trial on one machine.
- `TIEHALL_IMAGE` is the image the install runs, pinned by version and digest.
- `TIEHALL_HTTP_BIND` is where the app's one port is published: `127.0.0.1:3000` by default, on the host only.
- The database passwords, `TIEHALL_SECRET_KEY`, which encrypts the integration secrets Tiehall stores, and `TIEHALL_AUTH_SECRET`, which signs sessions and tokens, are fresh random values. Every secret setting can instead come from a file, as its `_FILE` form, such as `TIEHALL_SECRET_KEY_FILE`.
- Email is optional. To send it, fill in the SMTP settings: `TIEHALL_SMTP_HOST`, `TIEHALL_SMTP_PORT`, `TIEHALL_SMTP_TLS`, `TIEHALL_SMTP_USER`, `TIEHALL_SMTP_PASSWORD` and `TIEHALL_SMTP_FROM`. Without them, Tiehall sends no email, and its notices stay in the web inbox and the admin banners.

Keep `.env` secret, and back it up apart from the database dumps: a dump alone cannot use the integration secrets Tiehall stores, because `TIEHALL_SECRET_KEY` is not in it.

## Start the install

Start Postgres, the one-shot `migrate` step and the app, which starts only once the migrations have run:

```sh docs-test=install-up
docker compose up -d
```

The app then answers on `127.0.0.1:3000` of the host, for a reverse proxy in front of it, or for your browser on a trial install at `http://localhost:3000`.

On a trial URL, `http://localhost` with or without a port, the browser sends the install's cookies, the setup session's and the web session's, to every server on `localhost`, whatever its port, and lets any of them set or overwrite those cookies: a browser keeps cookies by host, not by port, and over plain HTTP nothing keeps them to the install. A dev server or any other local service you open in the same browser could act with your session, or replace it. So run a trial in a browser profile that visits no other local server. An install that anyone else uses runs on HTTPS, with the `caddy` profile or your own reverse proxy.

### TLS with the caddy profile

The `caddy` profile runs Caddy in front of the app. Caddy serves `TIEHALL_URL`, obtains its certificate and renews it. The host name must resolve to the host, and ports 80 and 443 must reach it from the internet, for the certificate authority's checks. Start the install with the profile instead:

```sh docs-test=install-up-caddy
docker compose --profile caddy up -d
```

`TIEHALL_TRUSTED_PROXIES=caddy`, which `init` writes, lets the app trust the client address and scheme that Caddy passes on.

### TLS through your own reverse proxy

Without the `caddy` profile, put your own reverse proxy in front of the app's port. The proxy terminates TLS for `TIEHALL_URL`, passes the `Host` header on, and sets `X-Forwarded-For` and `X-Forwarded-Proto`, for example with nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 70s;
}
```

Let the proxy wait at least 70 seconds for an answer before it gives up on it: the API's wait endpoint holds a call for up to 60 seconds while nothing happens, and the web UI's live hall holds its read for up to 25, and a proxy that ends a quiet answer sooner, as many do after 30 or 60 seconds by default, makes those calls fail. nginx's `proxy_read_timeout`, above, is 60 seconds unless set. The `caddy` profile's Caddy waits as long as the app takes.

The app trusts forwarded headers only from the proxies that `TIEHALL_TRUSTED_PROXIES` names: IP addresses, CIDR ranges or host names, separated by commas. Name the address the app sees your proxy's connections come from. For a proxy on the host that reaches the published port, that is usually the gateway of the install's Compose network, which `docker network inspect tiehall_default` shows. Headers from any other address are ignored.

### An external Postgres

To use your own Postgres 17 or later instead of the bundled one, set the connection URLs of the database owner and of the app role in `.env`, each with its own password:

```ini
TIEHALL_DATABASE_OWNER_URL=postgres://tiehall:owner-password@db.example.com:5432/tiehall?sslmode=verify-full
TIEHALL_DATABASE_APP_URL=postgres://tiehall_app:app-password@db.example.com:5432/tiehall?sslmode=verify-full
```

A database on another host is reached over the network, so connect to it over TLS. With `sslmode=verify-full`, as in the example, the app and the `migrate` step check that the server's certificate is valid and names the host name in the URL, and refuse to connect otherwise; the image trusts the certificate authorities Node.js ships with, so the server needs a certificate one of them issued for that host name. The bundled Postgres needs no TLS: it accepts connections only from the install's own Compose network.

The owner owns the database; the `migrate` step connects as the owner, applies the migrations and creates or updates the app role, which the app connects as and which owns nothing. Only the `migrate` step receives the owner's credentials. Back up an external Postgres with its own tooling: `backup.sh` and `restore.sh` work on the bundled one.

## The setup screen

Until setup is complete, every page leads to `/setup`, apart from the stylesheet and the icons the setup screen loads, which the install serves to anyone, and the app prints a one-time setup code to its log each time it starts. Read it on the host:

```sh docs-test=install-setup-code
docker compose logs app
```

Open `TIEHALL_URL/setup` in your browser, at the install's own URL, and enter the code. Only the browser that entered the current code continues; its setup session stays valid until setup completes, and a restart prints a new code without ending it. Then:

1. **Name the company.** It becomes the name of the install.
2. **Create the GitHub App.** Name the GitHub organization that owns the App (recommended), or leave it empty for your personal account, and check the App's name: by default "Tiehall" and the company's name. App names are unique on GitHub; if GitHub refuses the name as taken, change it on GitHub's own page, or come back to `TIEHALL_URL/setup` in the same browser and change it there. The button takes you to GitHub, which asks you to confirm the App and sends you back.
   - On a trial URL, `http://localhost` with or without a port, the App has no webhook, because GitHub cannot deliver webhooks to it, and GitHub runs in polling mode: Tiehall asks GitHub for changes, which reach it within 2 minutes.
   - On any other URL, the App gets a webhook at `TIEHALL_URL/webhooks/github`, and GitHub sends changes to Tiehall at once. GitHub may refuse the webhook URL if it cannot reach this address, and then leaves you on its own error page. The way back: open `TIEHALL_URL/setup` again in the same browser, where your setup session is still open, choose the option "GitHub cannot reach this address", and create the App again, without a webhook. GitHub then runs in polling mode, and an admin can move it to webhook mode later.
3. **Install the App** on the organization, and choose the repositories it covers.
4. **Sign in with GitHub** from the setup screen. You become the install's first admin, the installations you made are connected, and setup is complete: the setup code stops working and `/setup` answers 404.

Then create teams on the admin pages, invite people or let the organization's members sign in, and schedule the daily backup.

## GitHub's modes: webhook or polling

GitHub runs in webhook mode, in which GitHub delivers each change to the install, or in polling mode, in which Tiehall asks GitHub for changes every 60 seconds. A reconciliation every 15 minutes finds what either mode missed. The admin page at `/admin/github` shows the mode. An App with a webhook starts in webhook mode, and falls back to polling mode when GitHub cannot deliver to the install, or holds no webhook for the App any more because someone removed it in the App's settings. To move back after removing the webhook, add it again with the same URL and the webhook secret stored in Tiehall, then switch GitHub to webhook mode on the admin page.

To move an App without a webhook to webhook mode, once GitHub can reach the install, follow the steps the admin page shows:

1. In the App's settings on GitHub, under Webhook, make the webhook active, set its URL to `TIEHALL_URL/webhooks/github`, and set a webhook secret.
2. Under Permissions and events, subscribe to the events Pull request, Issues and Organization. No permission changes.
3. In Tiehall, store the same webhook secret on the admin page, and confirm it on its review page.
4. Switch GitHub to webhook mode on the admin page, then check on the App's Advanced tab on GitHub that the next delivery succeeded.

On a trial URL, the admin page says that GitHub cannot deliver webhooks to it, and GitHub stays in polling mode.

## Moving the install to a new host

The install's links follow `TIEHALL_URL`. To move it, change `TIEHALL_URL` in `.env`, and change the App's URLs in its settings on GitHub to match: its homepage URL, the webhook URL `TIEHALL_URL/webhooks/github` if it has a webhook, and both callback URLs, the sign-in's `TIEHALL_URL/api/auth/callback/github` and the setup screen's `TIEHALL_URL/setup/sign-in/callback/github`. Then run `docker compose up -d`. Links to the old host stop working unless you redirect them.

## Backups

`backup.sh` dumps the bundled Postgres with `pg_dump` inside the Postgres container, so the dump always matches the server's version, into a timestamped file in the `backups` folder that only its owner can read. It then records the time the backup finished, which the admin page shows; the admin page warns when no backup has finished, or none in the last 7 days.

```sh docs-test=backup-run
./backup.sh
```

- Run it every day, for example from cron, with a line such as `15 3 * * * cd /srv/tiehall && ./backup.sh >> backup.log 2>&1`, which keeps its output in `backup.log` beside `.env`.
- Run it before every upgrade.
- Copy the dumps off the host, to storage that a failure of the host does not take with it.
- Back up `.env` separately, and keep it secret. A dump without `TIEHALL_SECRET_KEY` cannot use the integration secrets Tiehall stores.

For point-in-time recovery, use your own Postgres tooling, or a managed Postgres through the connection URLs.

## Restore

`restore.sh` checks that the file is a dump, stops the app, restores the dump into a new, empty database and starts the app again. Its `migrate` step brings a dump from an older release up to the running release. Everything written since the dump was taken is lost. Restore with the `.env` the dump was taken with.

The restored database replaces the install's only once the whole dump is in. A file that is not a whole dump, such as a copy that broke off, changes nothing: `restore.sh` says why, and an app that was running starts again on the database it had. One that was not running, such as after its database was lost, stays stopped. While it runs, the restore needs room on the disk for a second copy of the database.

```sh docs-test=backup-restore
./restore.sh backups/tiehall-20261001T031500Z.dump
```

## Upgrade

Releases use semantic versions. Skipping releases works, because the migrations run in order; the release notes name any release that must not be skipped. To upgrade:

1. Back up:

   ```sh docs-test=upgrade-backup
   ./backup.sh
   ```

2. Set `TIEHALL_IMAGE` in `.env` to the new release's image reference from its release notes.
3. Pull the new image and start it. The `migrate` step runs every pending migration before the app starts on the new image; if a migration fails, the app does not start on the new image, and the `migrate` step's log says why:

   ```sh docs-test=upgrade-pull-up
   docker compose pull && docker compose up -d
   ```

4. Check that the app is up, and that the admin page shows the new version:

   ```sh docs-test=upgrade-check
   docker compose ps
   curl --fail --silent --show-error http://127.0.0.1:3000/healthz
   docker compose logs migrate
   ```

An upgrade restarts the app. Agents waiting on it retry.

## Rollback

A release's migrations only add to the schema, and a contract step, which removes or rewrites what an earlier release replaced, ships at least one release later and is flagged in its release notes. So, until a contract step has run, going back only takes setting the previous release's image in `TIEHALL_IMAGE` and starting it:

```sh docs-test=rollback-up
docker compose up -d
```

The previous image's `migrate` step sets the app's database rights only on the tables its own release knows, so a table that the newer release added keeps the rights that release gave it.

After a contract step has run, the previous image refuses to start: its `migrate` step says that the image is older than the database's schema. The way back is then the backup taken before the upgrade, restored with the previous image: set the previous release's image in `TIEHALL_IMAGE`, and restore the dump you took before the upgrade:

```sh docs-test=rollback-restore
./restore.sh backups/tiehall-20261001T031500Z.dump
```

## Commands on the host

The image's `admin` role runs two commands on the host, without the web UI, connected as the app role. Each run is recorded in the activity log, naming the command.

Each command runs with `--no-deps`, so Compose starts nothing else first: without it, `docker compose run` would run the migrate step before the command, and a migrate step that fails, as after an upgrade that went wrong, would stop the command too. The command needs the install's database running; if it is not, start it alone with `docker compose up -d postgres`.

To make a member an admin, for example when nobody can sign in as an admin any more, name their GitHub login:

```sh docs-test=operator-grant
docker compose run --rm --no-deps app admin grant <github-login>
```

To create the GitHub App again, for example after its credentials leaked or it was deleted, reopen the setup screen's App step. The command prints a new setup code; enter it at `TIEHALL_URL/setup`, create and install the new App, and sign in with GitHub as an admin, which closes the step. Until a new App is created there, the install keeps serving its members with the App in use. The new App replaces the old one, whose installations are no longer connected; delete the old App in its settings on GitHub.

```sh docs-test=operator-reopen
docker compose run --rm --no-deps app admin setup reopen
```

## What an install connects to

An install sends nothing to the Tiehall project: no usage statistics, no update check, no error reports and no license check. It calls no language model, and sends no data to a model vendor. Its only outbound connections are:

- GitHub: `github.com` and `api.github.com`, for sign-in, the GitHub App, pull requests and the GitHub Issues mirror, and `token.actions.githubusercontent.com`, for the published keys that check the tokens of the contract Action's runs when they report.
- The Jira Cloud site an admin connects, `<name>.atlassian.net`, when one is connected.
- The SMTP server in `.env`, when one is set.
- The Client ID Metadata Documents of the agent clients that connect, on the hosts their client ids name, fetched through a fetcher that refuses internal addresses. Set `TIEHALL_CLIENT_METADATA_FETCH=off` in `.env` to stop these fetches; agent clients then register with Dynamic Client Registration.

The host itself pulls the images from their registries (`ghcr.io` for Tiehall, Docker Hub for Postgres and Caddy), and, with the `caddy` profile, Caddy reaches the certificate authorities it uses by default, Let's Encrypt and ZeroSSL, to obtain and renew the certificate.
