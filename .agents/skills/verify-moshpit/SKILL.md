---
name: verify-moshpit
description: Verify user-facing behavior of the moshpit web demo (the phone-first React preview in this repo). Use when asked to prove the moshpit UI works — onboarding, the moshpit agent list, replying to a blocked agent from Steer, sending keys on the Terminal, or connecting hosts — by driving a locally launched instance in a headless browser.
---

# Verify moshpit (web demo)

The release surface is the responsive Moshpit PWA: onboarding, then three tabs (moshpit / Inbox / Hosts). Agent detail opens from cards, Inbox, Jump, and deep links, with Chat, Terminal, and Links views under one header (the old Output view is gone; exact raw output lives in Terminal). Phones use Back; larger screens keep a persistent list beside the detail. Hosts accepts real Tailscale bridge URLs. Native iOS is deferred. The `?demo=1` fixture provides Demo herdr for isolated UI checks.

The feature map in `features/` is the maintained source for what to verify. Read the index, then the matching feature file.

## Launch

- Start an instance on the dedicated verification port (do **not** reuse the user's `npm run dev` server on 8080 — that is their session):

  ```sh
  cd "$(git rev-parse --show-toplevel)"
  nohup npx vite --host 127.0.0.1 --port 8188 --strictPort \
    > /tmp/moshpit-verify-server.log 2>&1 &
  echo $! > /tmp/moshpit-verify-server.pid
  ```

- It is ready when the log shows `ready in` and the port answers. Confirm with the doctor below before driving.
- If 8188 belongs to another session, use a free verification port and pass it to the helpers. Never stop someone else's server.
- The demo fixture is gated behind `?demo=1`; the browser helpers include it in their launch URL.
- The app state (onboarding, hosts, settings) persists in the browser profile's localStorage (zustand key `moshpit-v1`). Every `drive.mjs` run uses a **fresh browser context**, so onboarding always appears and runs never share state. Two instances can run side by side on different ports (vite + a fresh context per drive).

## Doctor

```sh
node .agents/skills/verify-moshpit/helpers/doctor.mjs 8188
```

Read-only: port answering, `GET /` is 200 and is the moshpit app, port owned by our vite dev server (not a foreign process), and the Playwright Chromium binary is present. Run it first whenever anything looks off; do not drive an instance it rejects.

## Drive

```sh
node .agents/skills/verify-moshpit/helpers/drive.mjs <scenario> 8188 \
  .agents/skills/verify-moshpit/proof
```

Scenarios: `onboard`, `list`, `steer`, `terminal`, `hosts`, `inbox`. Each run: fresh context at a 390×844 phone viewport → completes onboarding (unless the scenario is onboarding) → performs the scenario steps against stable handles (bottom-nav buttons by position in `nav[aria-label="Primary"]`, agent cards by name, the composer placeholders, demo-control button text) → captures per-step evidence → exits 0 only if every assertion passed.

Production checks start and stop their own isolated servers:

- `npm run verify:pwa` builds and checks Chromium, Firefox, and WebKit at phone portrait/landscape, tablet, laptop, and desktop sizes. It also checks offline startup and failed/successful updates. Requires the three Playwright engines and their host libraries. On Linux, `MOSHPIT_WEBKIT_LIBS` can point to locally extracted WebKit dependency libraries without changing system packages.
- `npm run verify:upload` builds and sends real image bytes through an isolated bridge with its demo agent backend. It checks file permissions, prompt paths, rejected files, clipboard/drop input, and failed-send preservation.
- Development mode deliberately does not register a service worker. Run PWA lifecycle checks against the production build.

For behavior not covered by a scenario, use the same handles:

One-shot checks (same launch, doctor, cleanup as scenarios; fresh context each run):

- `node .agents/skills/verify-moshpit/helpers/check-wide.mjs` — wide 1280×800 (side rail, pit/detail pair, Terminal in the detail pane, hosts columns, centered jump dialog) and phone 390×844 (bottom nav, no rail).
- `node .agents/skills/verify-moshpit/helpers/check-commands-ui.mjs` — isolated loopback bridge (own state dir, reserved port, `MOSHPIT_AUTH_MODE=password`, `MOSHPIT_PUBLIC_ORIGIN`, `MOSHPIT_DEV_INSECURE=1`, paired device) in front of the read-only herdr snapshot; on a phone viewport it connects a real host and checks the composer command suggestions end to end: the agent's own prefix opens the real skill catalog (claude `~/.claude/skills` as `/<name>`, pi `~/.pi/agent/skills` as `/skill:<name>`), a token in another agent's prefix never triggers, partial-name filtering, tap-to-insert (replaces the token, adds a trailing space, never sends — it counts every `/api/submit` and `/api/action` request and asserts zero), dismissal until the token changes, URL/path non-triggering, and agent switching (a claude-exclusive skill never appears on a pi agent). It writes no input to any pane.
- `node .agents/skills/verify-moshpit/helpers/check-pane-modifiers.mjs <port> [screenshot]` — focuses the terminal pane and presses a real hardware Ctrl+Enter: asserts the `Ctrl+Enter is not sent to the pane` toast, that no pane line was added, and that a plain Enter still reaches the pane. Exits 1 against a parser that weakens a modifier combination into a different key.
- `node .agents/skills/verify-moshpit/helpers/check-shift-tab.mjs`, `check-prefix.mjs`, `check-inbox-unread.mjs`, `check-chat.mjs`, `check-image-paste.mjs`, `check-bridge.mjs`, `check-theme-clobber.mjs`, `check-chat-repin.mjs`, `check-ask-question.mjs`.

- **Tabs:** `nav[aria-label="Primary"] > button` — order is moshpit, Inbox, Hosts. The active tab has `aria-current="page"`. (Do not match nav buttons by name — the moshpit nav button's accessible name carries the blocked-count badge, e.g. "moshpit2"; Inbox likewise, e.g. "Inbox1".)
- **Agent views:** `nav[aria-label="Agent views"] > button` — Chat, Terminal, Links. The active view has `aria-current="page"`. This control and the phone `Back` button stay mounted while Terminal is active.
- **Agent cards:** button whose name is the agent name (`migrate`, `postcard-ui`, `auth-rewrite`). Selecting a card opens the Steer detail while leaving the originating tab active.
- **Filters:** chips `All`, `Blocked`, `Working`, `Done` (the Blocked chip's name also carries a count, match `/^Blocked/`).
- **Steer composer:** input placeholder `Message this agent…` (blocked agents show their choices above the field); send with `aria-label="Send"`; paperclip `aria-label="Attach image"`; a `Send mode` picker appears when the session exposes steer/queue.
- **Terminal:** open an agent, then `Terminal view`; special-key bar buttons `esc`, `⌫` (Backspace), `tab`, `shift+tab`, `^C`, `^D`, `^L`, `^B`, `up`, `down`, `left`, `right`; shared composer textarea `Terminal input` (placeholder `Type or dictate terminal input`), `Dictate`, and `Send`. `helpers/check-terminal-send.mjs` starts an isolated bridge to check this flow, onboarding, and simulated keyboard offsets — it is still written against the pre-refactor three-view UI and needs rework.
- `helpers/check-terminal-backspace.mjs <port>` checks the phone's pane Backspace button against the demo host and confirms it leaves the separate composer draft unchanged.
- `check-live-detail.mjs` still targets the pre-refactor three-view UI (`Output` view, `Agent output` label); rework before relying on it. `check-terminal-send.mjs` is likewise still on the old view set.
- `check-session-review.mjs` (behind `npm run verify:session-review`) clears its `mergeSession` assertions and then stalls: the host it injects into the store never brings the pane up, so it times out on the first pty dump and never reaches its stale-pagination checks. The node tests the script runs before it are unaffected; rework the browser half before relying on it.
- `check-add-host.mjs` and `check-connect-error.mjs` still mock `/api/vapid` as the discovery endpoint. Discovery moved to `/api/auth-info`, so every door their fixtures stand up now reads as dead: add-host fails its first save and then strands, and connect-error misreports the not-a-bridge door. Rework the fixtures before relying on either.
- **Hosts:** saved host rows with `Connect` / `Disconnect` / `Remove`; `Add host` opens the name and bridge URL form. Legacy profiles without a URL show `Bridge URL needed`. Demo controls include `Simulate: agent blocked`, `Simulate: herdr not running`, and `Reset demo`. Installation and appearance settings are on this page.

## Evidence

Each drive run writes `proof/<timestamp>-<scenario>/` inside this skill directory: a screenshot and an accessibility snapshot (`.aria.json`) per step, named `NN-<step>.png`. Proof artifacts survive cleanup — cleanup never touches `proof/`.

Proof standards:

- Exercise the real user path: onboarding buttons, agent cards, composer, key bar — not store actions or network calls. The demo host's mock snapshot and fake PTY are the app's own production boundary in this surface; everything between the UI and that boundary is real code under test.
- A proof captures the **action and the resulting state**: e.g. `steer` shows the typed `y`, the pane line `running prisma migrate deploy`, and the `working` status pill — not just the final screen.
- Side effects here are observable in-app: agent status changes, blocked badge on the moshpit nav button, host `live` badge, persisted state in localStorage. Verify the state change on screen; the fresh-context design means there are no cross-run side effects to check.
- Real browser connections use the bridge. Profiles without a bridge URL show `Bridge URL needed`. Native socket transports are deferred.

Real-herdr evidence (V1 companion shell and worktree): `MOSHPIT_PROBE_SESSION=moshpit-probe node helpers/check-shell-real.mjs <evidence-dir>`. It starts that named herdr session, drives an isolated bridge against it, refuses `agent start` so no coding agent runs, writes `results.json`, then stops and deletes the session. It refuses the `default` session. Never point it at, or send input to, the user's own session.

## Cleanup

```sh
kill $(cat /tmp/moshpit-verify-server.pid)
rm -f /tmp/moshpit-verify-server.log /tmp/moshpit-verify-server.pid
```

Kill only the PID this run started (recorded at launch); never kill by process name. Remove only scratch files — **never** `proof/`. If a launch or drive failed partway, still run cleanup so a failed attempt does not strand a server on 8188.

## Feature map

- [Onboarding](features/onboarding.md)
- [Command suggestions](features/commands.md)
- [Agent list](features/agent-list.md)
- [Inbox](features/inbox.md)
- [Steer a blocked agent](features/steer.md)
- [Image paste](features/image-paste.md)
- [Terminal](features/terminal.md)
- [Hosts & demo controls](features/hosts.md)
- [PWA bridge](features/pwa.md)
