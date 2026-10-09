# Run the Moshpit bridge (protocol 2)

The bridge speaks protocol 2: configured identity factors and a paired device
credential protect API reads and writes. Auth and VAPID discovery are public
within the browser boundary; login/logout have their own identity handling,
and redeeming a pairing grant requires identity. Only the local admin socket
issues grants, and only an approved device or the admin socket approves a
browser's access request, so identity alone never approves a device. The bridge
binds loopback only and belongs behind Tailscale Serve, not a public proxy.

Reviewed against source on 2026-09-18 at `dc7fc45`. This is the implementation
contract, not evidence that deployment or physical-device checks have passed.

## Startup requirements

Build and run:

```sh
npm ci
npm run build

MOSHPIT_AUTH_MODE=tailscale \
MOSHPIT_TRUSTED_USER=you@example.com \
MOSHPIT_HERDR_BIN=/path/to/herdr \
MOSHPIT_PUBLIC_ORIGIN=https://workstation.example.ts.net \
MOSHPIT_ALLOWED_AUTHORITIES="$BRIDGE_INBOUND_AUTHORITY" \
npm run bridge
```

- `MOSHPIT_AUTH_MODE` is required and must be exactly `tailscale`,
  `password`, or `tailscale+password`. The bridge refuses startup without
  it. `MOSHPIT_PASSWORD` is no longer read: if it is set, startup is
  refused. Remove it and use `MOSHPIT_PASSWORD_FILE` for a password mode.
- `MOSHPIT_PUBLIC_ORIGIN` is required: the exact origin browsers open. It
  must use HTTPS, except a loopback development origin under
  `MOSHPIT_DEV_INSECURE=1`. It cannot carry a path, credentials, query,
  fragment, or wildcard host.
- `MOSHPIT_ALLOWED_AUTHORITIES` is required: a comma-separated list of the
  inbound `Host` authority values this bridge answers (a host with an
  optional port, not URLs). Set `BRIDGE_INBOUND_AUTHORITY` to the exact
  authority your Serve proxy forwards, including its port if present, and
  verify it in an isolated proxy setup before trusting it. A rejected
  authority or origin is reported once in the bridge console; check the
  proxy configuration before changing the allowlist.
- `MOSHPIT_ALLOWED_ORIGINS` optionally adds more exact HTTPS origins for
  separate UIs, configured on every bridge they connect to.
- `MOSHPIT_CONNECT_ORIGINS` optionally lists the other bridges, as exact
  HTTPS origins, that the app served by this bridge may connect to. The
  app's CSP allows this bridge and these origins, each with its WSS twin,
  and nothing else. Without it the served app reaches only this bridge. The
  list is public in `/api/auth-info`, so Hosts explains a refused address
  instead of failing silently. It is a different list from
  `MOSHPIT_ALLOWED_ORIGINS`: that one names pages allowed to call this
  bridge, this one names bridges this bridge's app may call.
- `MOSHPIT_PASSWORD_FILE` (password modes) must be a regular file owned by
  and readable by the bridge user, with no group or other permissions
  (0600 recommended), holding one line of
  valid UTF-8 of at most 1 KB; the password itself is at most 256 bytes.
  Symlinks, FIFOs, files owned by another user, and files readable beyond
  the owner are refused.
- `MOSHPIT_STATE_DIR` defaults to `./.moshpit-state` and is created
  0700. `devices` and `admin` resolve it the same way (see Devices below).
- `MOSHPIT_DEVICE_LIFETIME_DAYS` (default 90) is how long a newly paired
  device stays approved, from 1 to 3650 days. Set it to `never` to pair
  devices that keep working until they are revoked. It applies to devices
  paired after it changes; existing ones keep the expiry they were given.
  Anything else refuses startup rather than falling back to the default.
- `MOSHPIT_BIND` defaults to `127.0.0.1` and `MOSHPIT_PORT` to `8787`.
  The bridge exits at startup for any non-loopback bind.
- `MOSHPIT_POLL_MS` (default 2000) is the snapshot polling interval that
  derives block and turn events; `MOSHPIT_PTY_POLL_MS` (default 100) is
  the terminal frame poll.
- `MOSHPIT_SESSION_REGISTRY` (set by the herdr integration) is a JSON
  file whose `opencode` key maps OpenCode session IDs to `{ url, ... }`
  server records, used to enable Conversation for OpenCode agents.
- `MOSHPIT_DEV_INSECURE=1` is for isolated local development only and
  permits HTTP origins on `localhost`, `127.0.0.1`, or `[::1]`, for
  example `MOSHPIT_PUBLIC_ORIGIN=http://127.0.0.1:8787` with
  `MOSHPIT_ALLOWED_AUTHORITIES=127.0.0.1:8787`. It never permits
  non-loopback HTTP.

Any failed configuration validation is printed to the console and the
bridge exits with status 1. Correct the configuration rather than
restoring permissive origin or authority handling.

### Host config file

A host can keep its settings in one private JSON file instead of an
environment file. Set `MOSHPIT_CONFIG` to its absolute path:

```json
{
  "schemaVersion": 1,
  "authMode": "tailscale",
  "trustedOwner": "you@example.com",
  "publicOrigin": "https://workstation.example.ts.net:8803",
  "allowedAuthorities": ["workstation.example.ts.net:8803"],
  "port": 8801,
  "herdrBin": "/usr/bin/herdr",
  "stateDir": "/home/you/.local/state/moshpit"
}
```

The other keys are `passwordFile`, `allowedOrigins`, `connectOrigins`,
`bind`, `deviceLifetimeDays`, and `sessionRegistry`. Each key stands for
the variable of the same meaning above. Lists are JSON arrays, `port` is
a number, `deviceLifetimeDays` is a number or `"never"`, and every path
must be absolute. The bridge refuses startup when:

- the file is a symbolic link, is not a regular file, belongs to another
  user, or is larger than 64 KiB (a loose mode is tightened to 0600);
- `schemaVersion` is not 1, or a key is unknown or has the wrong type;
- a value fails the same checks as its environment variable;
- any of the variables the file covers is also set in the environment.

`MOSHPIT_DEV_INSECURE`, `MOSHPIT_POLL_MS`, `MOSHPIT_PTY_POLL_MS`,
`MOSHPIT_PUSH_ENDPOINT`, and `MOSHPIT_PI_BIN` are development and test
settings and stay in the environment. Without `MOSHPIT_CONFIG` the bridge
reads the environment as before.

To move an existing `deploy/bridge.env` to a config file:

```sh
node bridge/host-config.mjs migrate deploy/bridge.env ~/.config/moshpit/config.json
node bridge/host-config.mjs check ~/.config/moshpit/config.json
```

`migrate` never sources the file. It accepts only plain
`MOSHPIT_NAME=value` lines, comments, and blank lines. It refuses `export`,
quotes, `$`, backticks, backslashes, whitespace anywhere in a value, repeated
names, unknown names, `MOSHPIT_PASSWORD`, the development settings above,
and relative paths. These refusals name the line and the variable,
never the value. It creates the parent directory 0700 if needed, writes the file
0600, and refuses to replace an existing config. `check` prints
`ok <path>` for a valid file. Both exit 1 on a refusal and 2 on a usage
error.

## Build a release executable

A release executable holds the bridge, the Node runtime and the built PWA in
one file, so the host needs no checkout, npm or Node. Build it on Linux with
Node 25.5 or later:

```sh
npm ci
npm run build:release
```

This writes `dist/release/moshpit-linux-<arch>` for the build machine's
architecture (`x64` or `arm64`), and a manifest beside it,
`moshpit-linux-<arch>.json`, with the version (`git describe --always
--dirty`), the release serial, the Node version, the config schema version,
the device state versions it writes and reads (`stateVersions`), the
SHA-256 and the size. The release serial is a fixed base of 340 plus the number of commits
reachable from the built commit (`git rev-list --count HEAD`). Each release
descends from the previous one, so a later release always has a larger
serial. The build refuses a shallow clone, because it would count only the
fetched commits. Two builds from the same clean commit, the same `npm ci` and
the same Node binary give byte-identical executables.

```sh
./dist/release/moshpit-linux-x64 bridge            # same as node bridge/index.mjs
./dist/release/moshpit-linux-x64 admin devices     # same as node bridge/admin.mjs devices
./dist/release/moshpit-linux-x64 config check /path/to/config.json
./dist/release/moshpit-linux-x64 version
```

The same commands work from a checkout as `node bridge/cli.mjs <command>`.
`admin`, `config` and `version` never start a bridge. `version` prints the
release line; `version --json` prints the release info with the state
versions, in the JSON envelope below. The executable reads the same environment variables and
`MOSHPIT_CONFIG` as the checkout, and serves the PWA it was built with; it
ignores any `dist/spa` on disk.

Releases are not signed. The manifest detects a damaged copy, but anyone
who can replace the executable on the release can replace the manifest too.
Node labels single executable applications Experimental. `npm run
test:release` builds the executable and runs the whole bridge suite against
it.

## Publish a release

`.github/workflows/release.yml` runs when a `v*` tag is pushed. The tag must
be annotated (`git tag -a`), because the build takes its version from
`git describe`. On native x64 and arm64 runners (see [CI](#ci))
it runs `npm run test:release`. It then checks each executable against its
manifest with `sha256sum`, and uploads the executables, their manifests and
a `SHA256SUMS` file to the GitHub Release for the tag. Nothing is signed, and
the workflow needs no secret beyond the job's own `GITHUB_TOKEN`.

### CI

Every workflow runs on GitHub-hosted runners, which are free for a public
repository. A newer push to the same ref cancels the older run.

| Workflow | Jobs | Trigger |
| --- | --- | --- |
| `test.yml` | `checks` (typecheck, lint, `test:bridge`); `release` (`test:release` on x64 and arm64); `e2e` (Playwright in four shards: Chromium phone and desktop, Firefox, WebKit) | pull request, push to `master` |
| `release.yml` | `build` (x64 and arm64), `publish` | `v*` tag |
| `container.yml` | `publish` | `v*` tag |

Browser runs in CI retry a failed test twice. A test that needed a retry is
listed as flaky. Treat that as a bug to fix, not a pass.

### Checks before merge

`npm run ci` runs the same gate locally: typecheck, lint, `test:bridge`, `test:release`, and the Playwright suite on Chromium
(phone and desktop), Firefox and WebKit. Playwright's WebKit is built for
Ubuntu 24.04 and does not start on Arch Linux, so `npm run test:e2e:webkit`
(`scripts/e2e-webkit.sh`) runs the WebKit projects in the
`mcr.microsoft.com/playwright` image, pinned by digest to the locked
Playwright version. It uses rootless podman when installed and falls back
to Docker. Prefer podman, because the `docker` group is equivalent to
root. The container runs with no capabilities, `no-new-privileges`, no
host network, and a read-only root. When `package-lock.json` moves to
another Playwright version, the script refuses to run until its version and
digest are updated.

## Verify a release

Check a downloaded executable before you run it. The check uses `sha256sum`
from GNU coreutils, which every supported glibc Linux distribution ships.

This check protects against a corrupted or truncated download. It does not
protect against a compromised GitHub account or repository: whoever can
publish a release can publish a matching `SHA256SUMS` and manifest too.
Releases are not signed, so the trust is in HTTPS from GitHub and in the
repository's access control.

1. Download from the GitHub Release for the version: the executable for your
   architecture (`uname -m` gives `x86_64` for x64 and `aarch64` for arm64)
   and `SHA256SUMS`. While the repository is private, download them signed
   in to GitHub, or with `gh release download <tag> --repo lichuu/moshpit`.

2. Check the checksum:

   ```sh
   sha256sum -c --ignore-missing SHA256SUMS
   ```

   It prints `moshpit-linux-x64: OK`. Any other output means the file is not
   the one that was published. Delete it and do not run it.

3. Install:

   ```sh
   chmod +x moshpit-linux-x64
   ./moshpit-linux-x64 setup
   ```

The manifest `moshpit-linux-<arch>.json` carries the same SHA-256 in its
`sha256` field, with the size in `bytes`; `moshpit update` checks both.

## Install on a server

`moshpit setup` installs the release executable as a user service behind
Tailscale Serve. Run it as an ordinary user, logged in over ssh or at a
console, on a glibc Linux host with Tailscale signed in and herdr on `PATH`:

```sh
./moshpit-linux-x64 setup
```

Tailscale lets only root and its operator change Serve, so setup needs this
user to be the operator. On a fresh server the operator is empty. Set it
once, naming the user that runs setup (setup prints the exact command):

```sh
sudo tailscale set --operator=<user>
```

The `tailscale-operator` preflight row reads only `OperatorUser` from
`tailscale debug prefs`. That is a debug command whose output may change, so
when setup cannot run it or parse it, the row does not fail: the preflight
detail says `tailscale-operator unknown` and setup continues. The row is
skipped when the configured origin's Serve route already points at this
bridge, because setup then changes nothing in Serve, so a rerun or
`--recover` on an installed host never needs the operator. The container
image skips the row, because setup never changes Serve there.

Setup checks the host first and changes nothing if a check fails. It then
prints the detected machine and Tailscale account and asks you to confirm.
After that it:

1. copies the executable to `~/.local/share/moshpit/releases/<version>/moshpit`
   and points `~/.local/share/moshpit/current` at it;
2. writes `~/.config/moshpit/config.json` (Tailscale identity mode, owned by
   the node's user, bridge on a loopback port from 8801), or keeps an
   existing one whose owner and machine match;
3. writes `~/.config/systemd/user/moshpit.service`, then reloads and starts it
   (a `moshpit.service` that setup did not write is left alone and refused);
4. enables lingering, so the service survives logout and reboot, only if you
   agree at the prompt or pass `--allow-linger`;
5. publishes HTTPS port 443 through Tailscale Serve, or 8803 when 443 is
   taken by another route (it never replaces a route or enables Funnel);
6. checks that `https://<machine>/api/auth-info` answers through Tailscale.

The XDG variables move these paths; setup refuses a path holding a quote,
backslash, `$` or control character, which a systemd unit cannot hold. Setup
records each finished step in
`~/.local/state/moshpit/setup.json`. A rerun checks every step on the host
again, finishes what is missing, and changes nothing on a finished host.
Once the journal records an install, a missing config is refused rather than
treated as a fresh host, so a rerun never moves the origin; restore the
config instead. The journal holds step times and the values setup replaced,
with a replaced unit file recorded only as its SHA-256.
Only one setup runs at a time; a lock left by a process that has exited is
taken over.

| Flag | Effect |
| --- | --- |
| `--yes` | Accept the detected machine and account without a prompt. It does not allow lingering |
| `--allow-linger` | Run `loginctl enable-linger` without a prompt |
| `--port 443\|8803` | Request that HTTPS port on a first install. A rerun keeps the configured origin and refuses a different port |
| `--emit-link` | Print the setup link even without a terminal (as `setupLink` with `--json`), with no QR and no waiting |
| `--recover` | Issue a setup link even when devices are already approved |
| `--json` | Print one result object on stdout instead of prose |

Without a terminal, a question that no flag answers stops setup with its own
exit code. For automation, run `setup --yes --allow-linger --json`.

`moshpit status [--json]` reports the same steps from the journal and the
host. It never changes anything. It exits 0 when the host is installed and
3 when it is not.

With `--json`, setup and status print exactly one envelope, on success and on
failure (see JSON output below):

```json
{"schemaVersion": 1, "command": "setup", "ok": true, "exitCode": 0, "result": {"state": "installed, awaiting first device", "steps": [{"id": "staged", "status": "done", "detail": "..."}], "next": "..."}}
```

`status` is one of `done`, `skipped` (already in place), `blocked`, `failed`
or `pending`. `state` is `not installed`, the last finished step,
`installed, awaiting persistence`, `installed, awaiting first device`, or
`complete` once the bridge reports an approved device.

### Approve the first device with the setup link

When setup finishes with no approved device, it prints a setup link and a
terminal QR code of the same link:

```text
https://<machine>/#moshpit-setup=<secret>
```

On a desktop session, setup also opens the link in your browser. It does
this only when `DISPLAY` or `WAYLAND_DISPLAY` is set, none of
`SSH_CONNECTION`, `SSH_CLIENT` and `SSH_TTY` is, stdout is a terminal, and
`--emit-link` was not given. It runs `xdg-open` on a private page (mode
0600, in `XDG_RUNTIME_DIR` or the state directory) that redirects to the
link, because a command line is readable by every local user. It removes
that page when the wait ends. If `xdg-open` is missing or fails, setup says
so in one line and keeps waiting; the printed link and QR code still work.

Setup does not launch a snap-confined browser. A confined browser cannot
read the private page, and moving the page somewhere every process can read
would weaken the 0600 guarantee, so setup detects the confinement, prints the
link and one line saying so, and keeps waiting. It looks at `SNAP` and
`SNAP_NAME`, a `BROWSER` under `/snap/` or `/var/lib/snapd/`, an `xdg-open`
that resolves there, and a default browser whose desktop entry is a snap's
(`xdg-settings get default-web-browser`). Open the printed link by hand.

Open the link, or scan the QR code, on a phone or computer signed in to
Tailscale as the host's owner. The app removes the secret from the address
bar before it does anything else and keeps it only in the page's memory. It
skips the introductory slides and asks "Approve this browser?", naming the
machine (the address's host) and the Tailscale account this browser reaches
the host as. The account comes from `GET /api/auth-info`, whose
`requesterLogin` is the caller's own Serve login, or null; it never names
the owner or anyone else. Approve approves the browser and opens its herd.
Cancel discards the link without using it and opens Hosts. A reload before
you choose loses the secret and lands on the normal screen, so open the link
again to continue. The
secret sits after `#`, so the browser never sends it to a server, and setup
writes it only to the short-lived private page above, never to the journal.

The link works once and expires after five minutes. Setup waits for it with
a countdown. It ends `complete` when the browser is approved, and stays
`installed, awaiting first device` when the link expires. Ctrl-C stops the
wait (exit 130) and changes nothing else. To get a fresh link, run
`moshpit setup` again. A browser that already holds an approval for the host
opens its herd and ignores the link.

When the browser cannot use the link, the confirm screen says why, and setup
adds the reason to the closing row when the wait ends without a device (one sentence per distinct reason, and one more if the bridge stopped answering). The reasons are
that the link expired, was already used, belongs to another account (the
wrong owner), or that the host has hit its request budget; the app also says
when it could not reach the host, and the link stays valid until it expires.
In every case run setup again for a fresh link. Neither the app nor setup
shows the secret or the owner. Reasons are given only for links this host
issued: a mistyped or unknown secret always reads as not valid, so a refusal
cannot be used to test which secrets exist. The host keeps the reasons in
memory, capped at 20 codes with times, and forgets them on restart (a
used link then reads as not valid).

Neither a setup link nor an access request asks for notification permission
or subscribes to push. The app asks only when you turn on "Notify when an
agent blocks" on the Hosts tab. When a connected host has no agents, the herd
says so and explains how to start one in herdr on the host.

Setup prints a link only when its output is a terminal, because automation
logs are not a safe place for it. `--emit-link` prints the link anyway,
without a QR code and without waiting.

A host that already has an approved device gets no link. If a link was used
but the browser lost the response before it saved its approval, run
`moshpit setup --recover` for a fresh one. It runs every check and step as
usual first.

A first device can also enroll without the link: open the app on it, choose
Request access, and approve it on the host with
`moshpit devices approve REQUEST_ID --state-dir ~/.local/state/moshpit`.
`moshpit admin pair --name "My phone" --state-dir ~/.local/state/moshpit`
still works, and so does the pairing form on the Hosts tab.

### Open the app on another device

`moshpit address` prints the host's HTTPS address from the config and what a
phone needs before the address works: Tailscale installed and signed in as
the host's owner. On a terminal it adds a QR code of the address. The address
is not a secret and the QR code holds nothing else, so opening it grants no
access; the new device asks for approval (see Access requests below).
`--json` prints an envelope whose `result` is `{"origin": "https://<machine>"}`. Without a
config it exits 3 and says to run `moshpit setup`; an unreadable config exits
1 and usage errors exit 2.

In the app, the Hosts tab offers Share address for the host the browser is
attached to. It shows the same address, a QR code of only the address, a
Copy address button and the same Tailscale steps for the phone. Host QR is
different: it prefills Add host on another moshpit device.

The table lists the exit codes of `setup`, `status`, `update`, `rollback`
and `uninstall`.

| Exit | Meaning |
| --- | --- |
| 0 | Installed. The setup link, if any, was used, expired or printed. `update`: updated, or already up to date. `rollback`: rolled back. `uninstall`: done, or nothing left to remove |
| 1 | A step failed unexpectedly |
| 2 | Usage error |
| 3 | `status` only: not fully installed |
| 10 | Not a release executable (a source checkout), or an unusable version |
| 11 | Architecture is not x64 or arm64 |
| 12 | No glibc (for example Alpine); use the container image |
| 13 | Running as root; the message shows how to create a user |
| 14 | The systemd user manager is not reachable, or `MOSHPIT_SUPERVISOR` is set to something other than `container` |
| 15 | The checkout helper's `moshpit-bridge.service` is installed, or setup could not query it |
| 16 | Tailscale is missing, stopped, signed out, or has no DNS name |
| 17 | The node is tagged or has no owning user |
| 18 | The existing config is invalid, has another owner, or names another machine; the journal records an install but the config is missing; or the journal is unreadable |
| 19 | herdr is missing or fails `--version` |
| 20 | No HTTPS port is free, the requested one is taken, or `--port` would move the origin. In a container: the sidecar's Serve config does not proxy the HTTPS port to the bridge |
| 21 | No loopback port from 8801 to 8810 is free |
| 22 | A data or config path holds a character the systemd unit cannot hold |
| 23 | This user is not the Tailscale operator, so it cannot change Serve. Run `sudo tailscale set --operator=<user>` as setup prints it, then rerun setup. Skipped when the Serve route already points at this bridge |
| 30 | Confirmation declined, or needed without a terminal. `uninstall --purge` without `--yes` and without a terminal |
| 31 | Another setup, update, rollback or uninstall holds the lock |
| 32 | Lingering is off: rerun with `--allow-linger`. `uninstall`: `loginctl disable-linger` was refused |
| 33 | A resource setup would change belongs to something else, such as a Serve route or a hand-written `moshpit.service`. `update` and `rollback`: `current` is not a link setup made, or the other command has an unfinished attempt |
| 34 | The HTTPS check did not get a 200 with a protocol |
| 40 | `update` and `rollback`: moshpit is not installed here, or its config is unusable |
| 41 | No longer used. It meant an unsigned executable, before releases stopped being signed |
| 42 | `update`: the release could not be downloaded (for a private repository without a token, a 404), is missing a file, is too large, or is served or redirected over another scheme |
| 43 | `update`: the executable's SHA-256 or size differs from its manifest, or the installed file reports another version |
| 44 | `update`: the release is not newer than the running one |
| 45 | `update` and `rollback`: the release reads another config schema, cannot read this host's device state, or cannot say what it reads |
| 46 | `rollback`: no previous release is kept |
| 47 | `update`, `rollback` and `uninstall`: running in the container image |
| 48 | The new release did not pass its health check, so the previous one runs again |
| 49 | Neither release passed the health check after switching back; rerun the same command to retry |
| 130 | Ctrl-C while waiting for the setup link; setup is otherwise finished |

To move from the checkout helper, migrate its settings first, then stop and
remove `moshpit-bridge.service`, then run setup. Setup keeps the migrated
config and its origin.

## Run in a container

The image `ghcr.io/lichuu/moshpit` is a complete agent host: the release
executable, herdr and the `tailscale` command line tool on a glibc base
(Debian bookworm), for `linux/amd64` and `linux/arm64`. It runs as the
unprivileged user `moshpit` (uid 10001). It holds no agent CLIs; add yours in
a derived image (see below).

`deploy/container/compose.yaml` runs three services in one network
namespace and publishes no ports:

- `tailscale`, the official Tailscale image, owns the namespace. It serves
  HTTPS 443 of the node's name through `deploy/container/serve.json`, which
  proxies to the bridge on `http://127.0.0.1:8801`. It never enables Funnel.
- `moshpit` runs `moshpit bridge`. Before setup has written a config, the
  bridge waits for it instead of exiting, so the container keeps running and
  `docker compose exec` can reach it.
- `herdr` runs herdr's headless server from the same image. The bridge
  reaches it through the socket on the `herdr` volume.

Docker's restart policy (`restart: unless-stopped`) replaces the systemd user
service and lingering.

### Start it

1. Create a Tailscale auth key without tags, or plan to sign in
   interactively. A tagged node has no owning user, and setup refuses it with
   exit 17, because moshpit trusts exactly the user who owns the node. The
   tailnet needs MagicDNS and HTTPS certificates.

2. In `deploy/container`, write the key and pin the image by tag and digest:

   ```sh
   cp tailscale.env.example tailscale.env   # set TS_AUTHKEY, or remove it
   echo 'MOSHPIT_IMAGE=ghcr.io/lichuu/moshpit:<tag>@sha256:<digest>' > .env
   ```

3. Start the services, then run setup inside the `moshpit` container:

   ```sh
   docker compose up -d
   docker compose exec moshpit moshpit setup --yes
   ```

   Without an auth key, `docker compose logs tailscale` prints the login
   URL. Setup prints the same rows, exit codes and `--json` object as on a
   host. It ends `installed, awaiting first device`.

4. `docker compose exec` gives setup a terminal, so it prints the setup link
   and its QR code. Open the link on a device signed in to Tailscale as the
   owner, as in [Approve the first device with the setup
   link](#approve-the-first-device-with-the-setup-link).

5. Run the other commands the same way, for example:

   ```sh
   docker compose exec moshpit moshpit status
   docker compose exec moshpit moshpit admin devices --state-dir /state/moshpit
   ```

   Device request approval (`moshpit devices pending`, `approve` and
   `reject`) and `moshpit address` run the same way.

In the container, setup reads `MOSHPIT_SUPERVISOR=container`, which the image
sets, and changes neither systemd nor Serve:

| Row or step | In the container |
| --- | --- |
| `systemd`, `legacy-service`, `tailscale-operator` preflight rows | `skipped: container-supervised` in the preflight detail |
| `https-port` preflight row | Adopts the port that the sidecar's Serve config proxies to a loopback bridge port; refuses (exit 20) when there is none, or when a configured origin's route no longer reaches the bridge |
| `staged` | `skipped`, `container-supervised`: the image is the release |
| `configured` | Writes `MOSHPIT_CONFIG` (`/config/config.json`) |
| `service-started` | Records the supervisor as `container-supervised` and waits for the bridge to answer on its loopback port |
| `persistence`, `serve-configured` | `skipped`, `container-supervised` |
| `verified` | The same HTTPS check through Serve |

The sidecar runs Tailscale with kernel networking (`TS_USERSPACE=false`, the
`NET_ADMIN` capability and `/dev/net/tun`) and accepts MagicDNS, so the
check can reach the node's own HTTPS name from the shared namespace.
`tailscale status` and `tailscale serve status` inside the `moshpit`
container reach the sidecar through the socket on the `tailscale-socket`
volume.

### Volumes

| Volume | Mounted at | Holds |
| --- | --- | --- |
| `config` | `/config` | `config.json` |
| `state` | `/state` | Bridge state and the setup journal, under `/state/moshpit` |
| `herdr` | `/herdr` | herdr's config, state and socket |
| `workspaces` | `/workspaces` | Your projects |
| `agent-home` | `/agent-home` | The home directory of `moshpit`, with agent credentials |
| `tailscale-state` | sidecar `/var/lib/tailscale` | The node's identity |

`agent-home` holds secrets: the agents' login tokens and API keys. Only the
stack's `moshpit` and `herdr` services mount it, because herdr runs the agents
and the bridge reads their sessions. Never mount it into any other container or
share it, and back it up only encrypted.

### Add agent CLIs

`deploy/container/Dockerfile.agents` shows the pattern: start `FROM` the
moshpit image, install the CLIs you use as root, then switch back to
`USER moshpit`. Point both `moshpit` and `herdr` at the derived image, so the
bridge and herdr see the same programs.

### Update

An update is a new image tag. Change `MOSHPIT_IMAGE` in `.env`, then run
`docker compose up -d`. `moshpit update` does not apply in a container. The
bridge refuses to start on a state file whose version it cannot read, such
as a device store written by a newer release. Rolling back to an older tag
never restores an older device database; the volumes keep the current one.

### Verify the image

A `v*` tag builds the image in CI, pushes it to `ghcr.io/lichuu/moshpit`, and
signs the pushed digest keyless with cosign. The workflow run's summary shows
the digest. Verify by digest, not by tag:

```sh
cosign verify ghcr.io/lichuu/moshpit@sha256:<digest> \
  --certificate-identity https://github.com/lichuu/moshpit/.github/workflows/container.yml@refs/tags/<tag> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

To build it yourself from a full clone (the build runs `git describe`):

```sh
docker buildx build -f deploy/container/Dockerfile \
  --platform linux/amd64,linux/arm64 -t moshpit .
```

## Provision with cloud-init

`deploy/cloud-init.yaml` provisions an Ubuntu 24.04 server (x64 or arm64) to
`installed, awaiting first device`. Before you use it, replace the four
values marked `REPLACE`: the release tag, a GitHub token that can read the
repository while it is private (or an empty file once it is public), your
SSH public key, and an untagged Tailscale auth key.

It runs these steps as root and stops at the first failure:

1. Creates the unprivileged user `moshpit`.
2. Downloads the release executable and its manifest over HTTPS from the
   GitHub API, sending the token to `api.github.com` only, and deletes the
   token file. It checks the executable with `sha256sum -c` against the
   manifest's SHA-256 before anything downloaded runs. As in [Verify a
   release](#verify-a-release), this catches a damaged download, not a
   compromised repository.
3. Installs herdr from its GitHub release, checked by SHA-256, and a user
   service that runs `herdr server` for `moshpit`.
4. Installs Tailscale from its apt repository and runs `tailscale up` with
   the key and `--operator moshpit`, so `moshpit` can add its Serve route.
5. Runs `loginctl enable-linger moshpit` and starts that user's manager.
   Lingering needs root, so cloud-init does it here instead of setup.
6. Runs `sudo -iu moshpit ./moshpit setup --yes --allow-linger --json` and
   checks that it ended `installed, awaiting first device`. The result is in
   `/var/log/moshpit-setup.json`. It holds no setup link, because the output
   is not a terminal.

Then print the setup link from your own machine. `-t` gives setup a terminal,
which it needs before it prints a link:

```sh
ssh -t moshpit@<host> ./moshpit setup
```

## JSON output

Every command that takes `--json` prints exactly one line, an envelope, and
nothing else on stdout:

```json
{"schemaVersion": 1, "command": "status", "ok": false, "exitCode": 3, "result": {"state": "not installed", "steps": []}, "error": {"code": "incomplete", "message": "Stopped at: not installed."}}
```

| Key | Meaning |
| --- | --- |
| `schemaVersion` | `1`. Changes only when a key is removed or its meaning changes; new keys may appear without a bump. |
| `command` | The command name: `setup`, `status`, `update`, `rollback`, `uninstall`, `address`, `devices`, `admin` or `version`. |
| `ok` | `true` exactly when `exitCode` is 0. |
| `exitCode` | The process exit code (setup exit codes table). |
| `result` | Present when there is something to report; the shape depends on the command. |
| `error` | `{code, message}`, present exactly when `ok` is false. For setup, status, update, rollback and uninstall it is the first failed or blocked step (`code` is the step id), else `incomplete` with the `next` hint. |

`result` is `{state, steps, next?, setupLink?}` for setup, status, update,
rollback and uninstall; `{origin}` for `address`; the bridge's answer for
`devices` and `admin`; and the release info for `version`. An older
release's bare `version --json` is still read during update and rollback.

## Update, roll back and uninstall

Run these as the user that ran setup. The installed executable is
`~/.local/share/moshpit/current/moshpit`. All three take `--json`, print
one envelope like setup, and hold the same lock as setup. The exit
codes are in the table above.

### Update

```sh
~/.local/share/moshpit/current/moshpit update
~/.local/share/moshpit/current/moshpit update --version v1.4.0
```

`update` downloads the latest GitHub Release, or the release tagged by
`--version`: the executable for this architecture and its manifest, over
HTTPS, with a size limit on each file. It trusts HTTPS from GitHub and the
manifest: the executable's SHA-256 and size must match the manifest, which
catches a damaged download but not a release replaced by someone who can
publish to the repository. Before it writes or runs anything it downloaded,
it refuses a release when:

- the executable's SHA-256 or size differs from the manifest (exit 43);
- the release is not newer than both the running executable and the
  installed release (its release serial must be larger; exit 44);
- the release reads another config schema, or cannot read this host's
  `devices.json` version (exit 45).

A private repository's release assets need a token. Set
`MOSHPIT_GITHUB_TOKEN`, or `GH_TOKEN`, to a fine-grained token with read
access to the repository's contents:

```sh
MOSHPIT_GITHUB_TOKEN="$(cat ~/.config/moshpit/github-token)" \
  ~/.local/share/moshpit/current/moshpit update
```

`update` follows redirects itself and sends the token only to
`api.github.com` and `github.com` over HTTPS, never to the storage host a
download redirects to, and never prints it. Without a token, a 404 says the
repository may be private and names the variable.

It then copies the release to `~/.local/share/moshpit/releases/<version>/`,
checks that the copy reports that version, points `current` at it, restarts
`moshpit.service`, checks that the service runs the new file, and checks
`https://<machine>/api/auth-info` as setup does. If the restart or the
HTTPS check fails, it points `current` back, restarts and checks again, and
exits 48. Each step is recorded in `~/.local/state/moshpit/update.json`, so
after an interruption, running `update` again finishes or reverts the same
attempt. `update` never changes the config, the device state or setup's
journal. It keeps the current release and one previous release, and deletes
older ones.

### Roll back

```sh
~/.local/share/moshpit/current/moshpit rollback
```

`rollback` switches `current` to the kept previous release, restarts the
service and checks HTTPS. It first runs the previous release's `version
--json` and refuses if that release cannot read this host's config or
device state, because rollback never restores an older device database.
Running `rollback` again returns to the release you left. `moshpit status`
shows the current release, its release serial and the kept previous release.

### Uninstall

```sh
~/.local/share/moshpit/current/moshpit uninstall
moshpit-linux-x64 uninstall --purge --yes
```

`uninstall` stops and disables `moshpit.service`, removes its unit file and
reloads systemd. It removes the Tailscale Serve route only if setup's
journal records that setup created it and it still points at this bridge,
and it disables lingering only if setup enabled it. Otherwise it leaves
them and says so. It leaves a `moshpit.service` that setup did not write.
It deletes the releases and `current`. The config, the device state and
setup's journal stay, so a release's `setup` reinstalls with the same
origin and approved devices. Running `uninstall` again changes nothing.

`--purge` also deletes the config and the state directory, including every
approved device. It asks on a terminal and needs `--yes` otherwise.

In the container image, `update`, `rollback` and `uninstall` refuse (exit
47): update by pulling a new image tag, and uninstall by removing the
container.

## Authentication modes

`GET /api/auth-info` answers discovery with the protocol number (2) and
the factors the bridge requires, so the app learns what to prove. In
tailscale modes the owner is the Serve login; in password mode the owner
is the single user `password`, because the host operator has no
per-user login.

- `tailscale`: the identity factor is the `Tailscale-User-Login` header.
  Serve supplies it and strips any value the caller sent; it is not in
  the CORS-allowed header list, so a page cannot forge it. The bridge
  accepts one value that is exactly `MOSHPIT_TRUSTED_USER`.
  `MOSHPIT_TRUSTED_USER` is the Serve-login configuration for this mode
  — the exact login this bridge answers (one printable login of at most
  256 characters) — not a legacy trust list.
- `password`: the identity factor is a password login. `POST /api/login`
  verifies the password (scrypt) and returns a bearer token for a 12-hour
  session in the response body. Protected HTTP requests then carry one
  `Authorization: Bearer <token>` header — never a cookie or a URL token.
  Terminal WebSockets use a separately issued, short-lived ticket.
  Login is throttled to 10 attempts per 60 seconds and quota-capped at
  100 live sessions; a full quota denies the new login and leaves every
  issued session valid. Failed logins are audited.
- `tailscale+password`: both factors, in that order — the Serve header
  first, then the bearer session.

`MOSHPIT_TRUSTED_USER` has no meaning in password mode and
`MOSHPIT_PASSWORD_FILE` has no meaning in tailscale mode; declaring the
wrong variable refuses startup.

## Device lifecycle

Every approved device expires after `MOSHPIT_DEVICE_LIFETIME_DAYS` (90 by
default), counted from when it was paired. A device can also be given no
expiry at all, in which case only revocation ends its access. Device state
is version 4 in `devices.json`, capped at 1 MiB. Version 2 and 3 files are read
and rewritten as version 4 on the next change, keeping their expiries.
Version 4 adds access requests.

Change one device's term after the fact, the way a tailnet disables key
expiry on a single machine:

```sh
node bridge/admin.mjs expiry DEVICE_ID never
node bridge/admin.mjs expiry DEVICE_ID 30
```

The new term runs from when the command is issued, so extending a device
that already lapsed brings it back for the full term. A revoked device is
refused: pair it again instead. `node bridge/admin.mjs devices` shows each
device's expiry, or `never`.

The app offers the same thing without a shell. A paired browser reads
`GET /api/devices` and writes `POST /api/devices/expiry` with the same
`never` or number-of-days term, behind the identity and device factors
every other write uses — the same authority it already has to revoke. The
term crosses as text and the bridge parses it; milliseconds are never
accepted from a caller.

Enrollment authority is the host and the devices it already approved. Only
the private admin socket issues pairing grants; `POST /api/devices/pair` is
refused with `403 enrollment_authorization_required` and mints nothing, for a
new browser, a revoked one and an approved one alike. A browser can ask for
access (see Access requests below), but only an approved device or the admin
socket can say yes. Revocation therefore sticks: a browser that keeps its
identity cannot approve itself back. A host with no approved device still
needs its shell for the first approval.

Access requests:

1. A browser with identity and no device calls `POST /api/enrollment/request`
   with `{name}`. It gets `{id, secret, phrase, expiresAt}` once. The request
   lives five minutes; the bridge stores only the secret's SHA-256.
2. It polls `POST /api/enrollment/status` with `{id, secret}` every two
   seconds. The answer is `pending`, `approved`, `rejected`, `consumed` or
   `expired`. Expired is computed from `expiresAt`, never stored.
3. An approved device reads `GET /api/enrollment/requests` (id, name, phrase,
   age and expiry; never a secret or hash) and decides with
   `POST /api/enrollment/decision` `{id, decision: "approve"|"reject"}`. The
   host operator can do the same with `moshpit devices pending`, `approve`
   and `reject`. The bridge rechecks the approving device inside the same
   serialized mutation.
4. The browser redeems with `POST /api/enrollment/redeem` `{id, secret}` and
   gets the same `{deviceId, deviceSecret, expiresAt}` that
   `/api/devices/pairing` returns. The request is consumed and the device
   created in one commit. A second redeem answers `409 enrollment_consumed`.

The phrase is three words derived from the request id. It is not a secret;
it lets a person check that the request on the approving screen is the one
the new browser shows. If the approving device is revoked or expires before
redemption, its approval no longer counts and the request reads as pending
again. Errors: `enrollment_unknown` (404, also for a wrong secret),
`enrollment_expired` (410), `enrollment_rejected` (403),
`enrollment_not_approved` and `enrollment_consumed` (409),
`enrollment_rate_limited` (429). Audit lines carry request and device ids only.

In the app, Hosts leads with Request access for a host that needs pairing.
It shows the phrase, keeps the request id and secret in `sessionStorage` for
that host's origin so a same-tab reload resumes, and purges them when the
request is redeemed, rejected, expired or cancelled. A lost redemption
response cannot be replayed; the app says so and offers a new request. An
installed PWA has its own storage, so it asks for its own approval. An
approved browser sees waiting requests on Hosts, polled every five seconds
while Hosts is visible, and confirms an approval against the phrase.

Pairing with a secret, still available under "Have a pairing secret?":

1. The operator issues a grant (a device name of 1 to 64 characters) with
   `node bridge/admin.mjs pair --name "…"`. The bridge returns a single-use
   secret that is valid for five minutes and bound to the bridge's owner.
2. The browser consumes that secret at `POST /api/devices/pairing` — a
   different endpoint from the one that issued it. The grant is
   consumed and the device created in one serialized atomic replacement,
   so a lost response can never replay the grant. The device UUID and
   device secret are returned once.

The Hosts panel shows the command to run on the host, with the device name
typed there, and a field for the secret it prints. A name sent with the
secret replaces the grant's name; otherwise the host's name is kept. Recovery
works the same way with every device revoked, and it does not reinstate any
revoked device.

Grants issued over HTTP by an older bridge are not cleared on upgrade; they
lapse within their five minutes.

Pairing is bounded: at most 8 pending grants and open access requests
together, 100 active devices, and 10 attempts per 60 seconds shared by grant
redemption, request creation and request redemption. Status reads allow 40
per request and 120 per owner each minute. A full device set or a full state file
makes the bridge refuse new writes and tells the operator to prune.

Protected HTTP API requests carry the `X-Moshpit-Device` header, exactly
`<device-uuid>.<43-character device secret>` (80 characters), plus the
configured identity proof. The bridge checks the secret against its stored
hash, the owner, the revocation time, and the expiry.

For Terminal, the client first obtains a target-bound ticket through
`POST /api/terminal-ticket`, then opens `/pty?ticket=…`. The upgrade consumes
the ticket and rechecks its identity session and device; browser WebSockets
do not send the device or bearer headers. The errors `device_revoked` and `device_expired`
(both 403) both mean "pair again to reconnect"; `device_required` means
the device was never approved. The client matches these on the code
alone, never the status.

Revocation: a device can be revoked from the app (`POST
/api/devices/revoke`, which requires an authenticated identity and an
approved device) or by the operator through the admin CLI. Revoking
drops the device's terminal tickets and open sockets and is audited.
Expired devices remain in state until the hourly prune drops rows past their
expiry. Revoked devices with no expiry remain as useful denial tombstones for
90 days, then the same prune drops them.

## Admin CLI

The operator's re-pairing path:

```sh
node bridge/admin.mjs pair --name "Dana's phone"
node bridge/admin.mjs devices
node bridge/admin.mjs revoke DEVICE_ID
node bridge/admin.mjs requests
node bridge/admin.mjs approve|reject REQUEST_ID
# --state-dir PATH  (default $MOSHPIT_STATE_DIR or ./.moshpit-state)
```

With the release executable, run the same commands as `moshpit admin ...`,
and `node bridge/host-config.mjs` as `moshpit config ...`. The executable's
usage, hints and errors name those forms; a checkout names the `node` forms.

`moshpit devices` is the operator front end for the same socket:

```sh
moshpit devices            # or devices list: the approved devices
moshpit devices pending    # waiting access requests: id, name, phrase, age
moshpit devices approve REQUEST_ID [--yes]
moshpit devices reject REQUEST_ID [--yes]
```

`approve` and `reject` read the request's name and phrase from the bridge
and ask for confirmation on a terminal. `--yes` skips the question. Without
`--yes` and without a terminal they change nothing and exit 30. Other
failures exit 1 and usage errors exit 2. `--json` prints one envelope
(see JSON output below); `result` is the bridge's answer.
Decisions made here are recorded as approved by `local-admin`.

`devices` and `admin` find the state directory the way the bridge does:
`--state-dir`, else the `stateDir` of the config named by `MOSHPIT_CONFIG`,
else `MOSHPIT_STATE_DIR`, else `./.moshpit-state`. Setting both
`MOSHPIT_CONFIG` and a variable the config also sets is refused, as in the
bridge (`config_invalid`). Without `MOSHPIT_CONFIG` they do not read the
default config path.

The CLI talks to the running bridge over the private Unix socket
`admin.sock` in the state directory (created 0600); it never writes
`devices.json` itself. One newline-terminated JSON line travels each way,
with a 4 KB request cap, a 64 KB response cap, and a 5 second timeout.
The CLI requires a directory owned by the invoking user with mode 0700 and
a socket owned by that user with mode 0600. Wrong ownership, type, or
permissions are refused. It times out when no bridge is listening. The
pairing secret is printed once, never as a URL, and the owner comes from
the bridge, never from argv.

## State directory

`MOSHPIT_STATE_DIR` (default `./.moshpit-state`, created 0700, owned by
the bridge user) holds:

- `devices.json` holds version 4 device, grant and access request state, 0600, at most 1 MiB.
- `push.json` — push subscriptions keyed by device id, 0600, replaced
  atomically on every change. It is created with the first subscription.
- `vapid.json` — the VAPID key pair, generated once and kept, 0600.
- `audit.jsonl` — appended records for authentication, device changes,
  terminal ticket issuance, agent actions, and submissions. It records
  action targets and checkout paths; terminal socket open/close coverage
  is incomplete. It rotates before passing 10 MiB and keeps three older
  files, `audit.jsonl.1` to `.3`.
- `client.log` — the phone's black-box log: app errors and the actions
  just before them, appended through `POST /api/log` with the device and
  user agent. Only the black box's own bounded fields are kept, and it
  rotates like the audit log.
- `uploads/` — image uploads, a 0700 directory of 0600 files, capped at
  1 GiB in total, counting files already there. Over the cap, uploads are
  refused with `507 upload_quota_exceeded` and nothing is deleted. The
  bridge includes the absolute file path in the agent's prompt; the
  agent's own file permissions still apply. Remove files when they are no
  longer needed.

`push.json`, `vapid.json`, `audit.jsonl` and `client.log` must be regular
files owned by the bridge user. A symbolic link, a FIFO, another user's
file, or one larger than the bridge writes refuses startup with the path
named; the bridge never repairs such a file. Move it aside and restart.
- `admin.sock` — the 0600 administrative socket.

Legacy state is refused at startup: a protocol 1 `devices.json` (a JSON
array of devices) fails with `device_state_legacy` — "back it up and
migrate it before starting protocol 2" — and the bridge will not start
over it. A `devices.json` that is valid but leaves no room to stamp a
revocation time also refuses startup as `device_state_full`.

## Request limits and response headers

Bodies are capped while they stream, not after, so an oversized request is
refused on the chunk that crosses the line and never buffered whole. Most
routes — login, logout, pairing, revoke, terminal tickets, push
subscriptions, client logs — take 64 KiB. Only `POST /api/action` and
`POST /api/submit` take the larger prompt body (about 13.4 MiB, sized for
one base64 image plus headroom), and both sit behind an approved device,
so an unauthenticated caller is always held to 64 KiB. Over the cap is
`413`. Images are capped separately at 10 MB, checked once on the base64
length before decoding and again on the decoded bytes.

`POST /api/log` takes at most 16 KiB per entry and 60 entries per device
per rolling minute (`413 diagnostic_too_large`, `429
diagnostic_rate_limited`); an entry outside the black box's schema is
`400 diagnostic_invalid`.

Responses handled by the HTTP request router — including a 403 origin
refusal — carry `x-content-type-options: nosniff` and `referrer-policy:
no-referrer`. Every `/api` response, errors included, is
`cache-control: no-store`, so nothing carrying credentials or
conversation content lands in the browser's disk cache and outlives a
logout or a revocation; the static app shell keeps its own caching.
Refused WebSocket upgrades carry `no-store` and `no-referrer` too.
Non-API responses also carry `content-security-policy: default-src
'self'; connect-src 'self' wss://<this bridge> <MOSHPIT_CONNECT_ORIGINS
and their wss twins>; img-src 'self' data: blob:; style-src 'self'
'unsafe-inline'; frame-ancestors 'none'`. There is no `script-src`, so
`default-src` applies and `eval` is blocked; `src/zod-config.ts` sets
`z.config({ jitless: true })` before any other module loads so Zod does
not probe for it. If you add a dependency that needs `eval`, fix the
dependency rather than loosening the policy.

Terminal sockets only show the pane; keys go over `POST /api/action`. A
device may hold 4 terminal sockets and the bridge 32 (`429
terminal_device_limit`, `503 terminal_limit`). A socket message over
64 KiB closes with 1009, binary input with 1003, and a viewer that falls
more than 256 KiB behind closes with 1013.

With a hardware keyboard, a focused terminal pane sends Home, End, Delete,
PageUp, PageDown, Insert, F1 to F12, Shift+Tab, Alt+Enter and the arrows with
any mix of Ctrl, Alt and Shift. Copy, cut, paste, select-all and the Insert and
Delete clipboard chords stay with the browser. Any other modifier combination
(Ctrl+Enter, Meta+Arrow, Shift+F5 and the like) is not sent: a toast says
`<keys> is not sent to the pane` rather than sending a different key. Keys
`herdr pane send-keys` refuses, and the function and modified-arrow keys, go
out as xterm escape sequences through `pane send-text`, from one table in
`bridge/herdr.mjs`. A bridge older than this table answers an unknown key name
with `400 key_unsupported`, and the pane shows `Keys not sent`.

## Push

Notifications flow through the bridge, which sends them itself with the
VAPID keys. `GET /api/vapid` exposes the public key, and `GET
/api/auth-info` reports `push: {available, reason?}`.

A subscription must name a bare `https` endpoint, with no credentials,
fragment or port, at one of `fcm.googleapis.com`,
`updates.push.services.mozilla.com` or `web.push.apple.com`. Anything else
is refused as `400 push_endpoint_invalid`, and the message names the host,
so a new browser push service is a one-line addition to `PUSH_HOSTS` in
`bridge/push-delivery.mjs`. That list is only a string check. Every send
goes through a filtering agent that checks each address DNS returns at
connect time and refuses private, loopback, link-local and other
non-public ranges. An allowed name that resolves inward gets no connection.
Redirects are not followed. Each send has a ten-second deadline and a 64
KiB response bound, and sends go out one at a time.

`MOSHPIT_PUSH_ENDPOINT` no longer relays push. It would bypass those
address checks, so a bridge started with it set turns push off. It logs
`push unavailable`, reports `available: false` with the reason, and answers
a new subscription with `503 push_unavailable`. Hosts shows the reason
instead of a working switch. Unset it to turn push on.

Before each send the bridge rechecks, synchronously, that the device is
still active and that the subscription is still its current one. A device
revoked or expired while earlier sends were in flight gets no request. A
request already sent cannot be recalled. Revocation removes the device's
subscription from `push.json`. Startup also drops any left behind for
revoked, expired or unknown devices. A torn `push.json` is logged and
treated as empty, and browsers resubscribe when they next connect.

VAPID subject caveat: the subject is `mailto:<owner>` only when the owner
looks like an email with a dotted domain. A Tailscale login usually is,
but SSO ones (`you@github`) are not; otherwise the bridge falls back to
the hard-coded `https://github.com/lichuu/moshpit`. Apple returns
`403 BadJwtToken` for an unroutable subject, and the bridge logs that
provider code, as in `push send failed 403 sender rejected (BadJwtToken) to
web.push.apple.com`. A 403 without a code is not necessarily the subject.
FCM also refuses a subscription made under a different VAPID key. Logs name
the status, a category and the provider host, never the endpoint path or
the response body. Each is reported once per host rather than on every
agent poll.

A 404 or 410 from push means the endpoint is dead. The bridge removes that
subscription from `push.json`, unless the browser has replaced it in the
meantime, and does not retry it.

Web push requires browser support, notification permission, a ready service
worker, and a paired reachable bridge. On iPhone/iPad, use a supported OS
and the installed Home Screen web app. Installation alone does not establish
notification delivery; physical-device checks remain required.

## Cutover from protocol 1

What changes for a deployment upgrading from the protocol 1 bridge:

1. Set the new required configuration: `MOSHPIT_AUTH_MODE` (now
   mandatory), `MOSHPIT_PUBLIC_ORIGIN`, and `MOSHPIT_ALLOWED_AUTHORITIES`.
   For a password mode, point `MOSHPIT_PASSWORD_FILE` at a 0600 file and
   remove `MOSHPIT_PASSWORD` if it was set — it is no longer read and its
   presence refuses startup.
2. Back up the old state. The bridge refuses to start over a protocol 1
   `devices.json` (a JSON array) with `device_state_legacy`. Back the
   file up, move it out of the state directory, and start; the new
   bridge begins with an empty device set.
3. Browsers re-pair once. The old public device IDs, password cookies,
   and terminal token URLs are no longer the approval mechanism. Pair
   each phone again — through the admin CLI on the host, or by issuing a
   grant and typing the secret on the device.
4. Push subscriptions follow the re-pairing. The old `push.json` entries
   are keyed by the old device ids and attach to nothing until a device
   re-pairs and the app resubscribes under the new device id.
5. Update the app. After all required assets download, **Refresh to update**
   activates the waiting worker and reloads the open app. It can also activate
   normally once the old worker has no open clients. Finish any draft before
   refreshing. Failed installation leaves the previous worker available.
   Development mode does not register a service worker.
6. Keep the bridge bound to loopback behind Tailscale Serve, and verify
   the Serve proxy's forwarded authority before changing the allowlist.

# Using the moshpit PWA
## Install the app

Open **Hosts** for installation help. Supported browsers show **Install moshpit** when their installation prompt is available.

- On iPhone or iPad, use the Share menu and choose **Add to Home Screen**.
- In Safari on macOS, use **File**, then **Add to Dock**.
- In Chrome or Edge, use the install option in the address bar or browser menu.

Installation options depend on the browser and OS. See [MDN's installation guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing).

## Check offline access and updates

Load the production app online once before testing offline access. The service worker caches the app, fonts, manifest, and icons. An offline reload opens the app from that cache and shows it disconnected; `tests/demo/pwa.spec.ts` checks this in Chromium. Confirm it on physical devices before release. Live agent operations require a reachable bridge; the app does not cache API responses or queue commands.

The worker installs only after every required asset downloads. **Refresh to update** activates a waiting worker and reloads the open app; the worker can also activate normally after the old worker has no open clients. Finish any draft before refreshing. Failed installation leaves the previous worker available. Development mode does not register a service worker.

## Chat, questions, and replies

Chat reads the exact native session reported by the pane; it does not infer a conversation from terminal repaint text. Supported readers cover Claude, Codex, Pi, Grok, and registered OpenCode sessions. If the source is missing, ambiguous, or unsupported, use Terminal. Search covers loaded history; **Load older history** fetches earlier entries.

Recognized live Codex choose cards can be answered in Chat. Only the current question's matching printed keys are enabled. The bridge rechecks the dialog and consumes a one-shot token before sending the key, without an extra Enter. Multi-select and unsupported dialog shapes fall back to **Answer in Terminal**. The demo includes a three-question wizard; that is not evidence of a successful real-device probe.

While a recognized choose dialog owns the keyboard, ordinary composer sends and quick replies are refused. For an unread blocked dialog, sending text only types it into the pane. **Typed without submitting** exposes Enter and Esc for an explicit next action; inspect the pane before using either. Inbox's **Type y** and **Type n** controls follow the same insert-only rule, rather than claiming to approve or deny.

A command can open a menu or a prompt in the agent's pane. **Pane**, beside the search field, shows that live pane inside Chat, and a delivered message offers **Show pane** next to its receipt. The key row under it sends arrows, Enter, Esc, Tab and Backspace to the pane; the composer keeps sending messages. Closing the pane only hides it and sends nothing, so whatever runs there keeps running. If the pane starts a different session, the panel lets go and asks you to reattach before it sends anything. On a short screen the pane takes the transcript's place until you close it.

For Codex, Claude and Pi sessions, a quiet line under the composer shows how much of the context the latest model call used: a bar and "62% of context" when the window size is known (Codex), "84k tokens in context" when it is not (Claude, Pi). It turns amber at 75% and red at 90%, and a Codex session also shows its tightest plan window and when it resets, in your own clock. The line reserves its own height, so the input never moves when a figure arrives, and nothing shows until the session file has a usage row. The same figure sits beside the agent's status in the detail header, and on its list card only past amber. A compaction clears it until the next model call.

Expand **Quick replies** above the composer for fixed phrases. These send through the existing submission path without consuming your saved draft or attachment. They are not snippets: saved snippets insert into the draft without sending. Voice input uses browser speech recognition when supported and enabled in Hosts; it is not a native or guaranteed-offline dictation service.

## Commands and snippets

The command picker reads fixed skill/command directories on the connected host for the agent kind. Current catalogs cover Claude, Codex, Pi, Grok, and OpenCode, with different invocation prefixes. They do not enumerate every built-in, project command, configured extension, or live session command. At most eight matching suggestions are shown; an unlisted command can still be typed manually.

Tap a suggestion, or select it with Up/Down and insert with Tab/Enter. Insertion does not send; a later Enter submits. Escape dismisses suggestions, and Shift+Enter adds a newline. Snippets are saved in this browser profile and likewise insert without sending; there is no cross-device snippet sync.

## Send an image

Use the paperclip in an agent conversation, paste an image from the clipboard, or drop an image onto the composer. Review the thumbnail, add a message if needed, and choose **Send**. PNG, JPEG, WebP, and GIF files up to 10 MB are supported.

The bridge saves the original bytes under `uploads/` in `MOSHPIT_STATE_DIR`, with private file permissions. It includes the absolute file path in the agent's prompt so the agent can open the image on the host. Unsent drafts, including image files, persist in browser IndexedDB for recovery. An attached image belongs to the session, so Chat and Terminal show the same one, while each view keeps its own text; the service worker does not cache uploads. Failed or uncertain sends retain the image and draft. Successful sends clear the submitted draft unless it has been edited in the meantime.

Uploaded files remain on the host so an agent can read them later. Remove files from that upload directory when they are no longer needed. An agent's own file access permissions still apply.

## Verify a build

Run the repository tests against isolated bridges and fake herdr executables:

```sh
npx playwright install chromium firefox webkit
npm run typecheck
npm run test:bridge
npm run test:release
npm run build
npm run test:e2e
```

`tests/bridge/security.spec.ts` checks real allowed and hostile page origins in Chromium, Firefox, and WebKit. `tests/bridge/commands.spec.ts` uses password login and browser fetches, not forged Tailscale headers. The tests do not verify your Serve proxy configuration.

The `verify:pwa` and upload helper commands run `.agents/skills/verify-moshpit/helpers`, which the repository now ships. Install their own dependencies once with `npm ci --prefix .agents/skills/verify-moshpit/helpers`; the helpers drive Playwright's own browsers, so `npx playwright install` above covers them. `verify:pwa` also drives WebKit, which needs host libraries Playwright does not ship: where the system ICU is newer than the one WebKit was built against, point `MOSHPIT_WEBKIT_LIBS` at locally extracted WebKit dependency libraries rather than changing system packages. A few helpers are still written against an older UI and say so in the skill's `SKILL.md` — a helper flagged there is unavailable, not passed. The committed Playwright suite does not replace physical-device or Serve integration checks.

Before release, verify Home Screen installation, software keyboard behavior, and notification delivery on a physical iPhone or iPad and an Android device. Desktop browser engines cannot prove OS installation, push delivery, microphone access, or real touch gestures.

## Chat formatting

Chat renders Markdown headings, lists, links, tables, inline code, and fenced code through `react-markdown` and `remark-gfm`. Long code and table cells wrap within the conversation. Unknown languages remain plain text.

Raw HTML is disabled. HTTP(S) links open in a new tab; relative paths, filesystem paths, and file URIs render as inert text/code rather than requests to the app origin. Authenticated uploaded images render inline; external HTTP(S) images appear as links instead of loading automatically. Chat removes the Codex input placeholder and recognized Pi token/status footers outside code fences. User-quoted footer text remains visible. Terminal retains the original terminal text.

Run `node .agents/skills/verify-moshpit/helpers/check-chat-placeholder.mjs` for filtering and code-preservation checks. The terminal browser check covers rendered Markdown and phone/desktop wrapping.

## Colors and code

Terminal preserves the ANSI styles herdr emits. The standard 16 ANSI colors follow the selected Moshpit theme, which publishes them as `--ansi-0` through `--ansi-15`. Extended indexed colors and explicit RGB colors retain their original values. Terminal keeps its live cell grid rather than wrapping.

Chat highlights a fenced code block when the fence names a language the app registers: JavaScript, TypeScript, Python, Bash, JSON, CSS, HTML, Rust, Go, SQL, and diff. Any other language, or an unlabelled fence, stays plain text. Copying preserves the original whitespace and fence markers.

Syntax highlighting uses [Lowlight](https://github.com/wooorm/lowlight) to produce text and span nodes, not executable HTML. Its language set is bundled with the app, so highlighting needs no network once the app is loaded.

Run `node .agents/skills/verify-moshpit/helpers/check-ansi.mjs` for ANSI parsing checks.

## Links

The Links view lists the `http` and `https` URLs an agent's pane has printed, newest first, capped at 100 per host, pane, and session. Links are collected from the live terminal stream and the pane's own rows, so opening the view does not re-read the pane. They are held in memory only: a reload starts the list over.

Nothing is fetched or previewed. A row opens the URL in a new tab, or copies it. Copying needs a secure context, so a plain-HTTP bridge falls back to a hidden selection and then to a message saying the clipboard is blocked.

## Projects and child agents

The agent list groups agents under collapsible project headers. The bridge asks `herdr worktree list --cwd` for each pane working directory and uses that checkout path as the project root. Without a worktree, grouping uses the working folder, then the herdr workspace if the folder is unknown. Different paths and hosts remain distinct, even when project names match. Linked worktrees group by their own checkout path. Agent cards show the worktree branch next to the kind only when herdr reports a named checkout; detached HEAD omits it.

Project headers show agent totals and attention counts. Collapsed groups persist in the browser profile. Status filters reveal matching children regardless of collapse state; All restores the saved state. Selecting a child opens its existing Chat, Terminal, and Links views. Inbox remains global for the connected host.

The plus control on a project header starts a new herdr agent in that project's directory. The sheet lists only herdr-supported kinds whose binaries are executable on the host PATH. The bridge creates a tab at that cwd, starts the chosen kind, and closes the pane if start fails. Demo herdr adds an in-memory agent instead.

The launch sheet also offers **New worktree** with a base ref and branch. Pi launches can select a model. If startup fails after worktree creation, the checkout is retained for retry rather than deleted; automatic merging and cleanup are not implemented.

**Shell** in an agent's detail header opens or reuses a companion shell in its project. Shell selection and input are separate from the agent pane. Verify shell creation and worktree writes in disposable projects, not the active developer checkout.

Run `node .agents/skills/verify-moshpit/helpers/check-projects.mjs` for repository and grouping checks. Run `node .agents/skills/verify-moshpit/helpers/check-start-agent.mjs` for PATH intersection and demo start. The terminal browser check also verifies child navigation, collapse persistence, and filters.

## Agent logos

Agent cards, detail headers, Inbox, and Jump use theme-colored SVG logos from [Lobe Icons](https://github.com/lobehub/lobe-icons), through the MIT-licensed `@lobehub/icons-static-svg` package. Its base-logo catalog is bundled locally in a lazy-loaded module and cached offline. No icon font or external logo service is required.

The bridge preserves herdr's agent name. Icon lookup ignores capitalization and punctuation, then tries conventional `agent` and `cli` suffixes against catalog filenames. There is no fixed provider list. Names without a matching catalog entry use a neutral agent icon. Updating the catalog package makes new matching logos available on the next build.

Titles remain unchanged for herdr's title plugins. Cards omit the output preview when it repeats the session title. The built-in theme labels are `moshpit light` and `moshpit dark`.
