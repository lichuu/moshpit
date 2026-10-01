# PWA bridge

The SPA talks to a per-host loopback bridge. The bridge binds 127.0.0.1, checks device credentials on protected API routes, including snapshot reads, pairs devices through a two-step grant and secret exchange, writes `audit.jsonl`, serves `dist/spa`, and (when `MOSHPIT_HERDR_BIN` is set) shells out to herdr. Demo herdr is the default test double.

## Sub-features

- `GET /api/snapshot` returns agents (`herdr api snapshot` when `MOSHPIT_HERDR_BIN` is set). Snapshot reads and other protected API routes require a valid device credential. Discovery, VAPID, login/logout, and pairing routes have separate access rules; pairing requires host identity before a device credential exists.
- `POST /api/action` needs a paired device token. Kinds include `prompt`, `keys`, `answer` (token + optionKey), `start` (with optional worktree checkout), `open-shell`, `rename`, `close`, and `block`.
- `POST /api/devices/pair` is refused with `403 enrollment_authorization_required`; grants come only from `node bridge/admin.mjs pair`. `POST /api/devices/pairing` exchanges the secret for a device id and secret. `GET /api/devices` lists devices. `POST /api/devices/revoke` and `POST /api/devices/expiry` manage them.
- `POST /api/push-subscription` stores or clears the Web Push subscription for the calling device. `GET /api/vapid` returns `{ publicKey }`.
- `POST /api/terminal-ticket` mints a one-shot ticket for a named terminal target. `WS /pty?ticket=<id>` upgrades with a fresh ticket; a missing or reused ticket is 401 `ticket_invalid`. The target is frozen from the ticket. On connect the bridge dumps the pane and refreshes it on change (`MOSHPIT_PTY_POLL_MS`, default 100 ms; text input flushed after 40 ms). Client text frames go to the session-control child as JSON lines; named keys map to raw control bytes.
- Bridge serves `dist/spa` (SPA fallback), `/manifest.webmanifest`, and `/sw.js` from the built files.
- Poll (`MOSHPIT_POLL_MS`, default 2000) detects newly blocked agents and finished turns (`working` to `idle`/`done`) and Web-Pushes paired subscriptions. Delivery is tested in-process by `bridge/push-delivery.test.mjs` with faked DNS. `MOSHPIT_PUSH_ENDPOINT` no longer captures pushes: setting it turns push off (`push.available: false`, `503 push_unavailable`).
- Bind `0.0.0.0` exits 1.
- `public/manifest.webmanifest` has `display: standalone` and name `moshpit`.

## How to get to it (user POV)

- On a real host, `tailscale serve` fronts the loopback bridge. Hosts stores one tailnet URL per profile.
- Phone install and tap-to-Steer remain a device checklist.

## Driving it with drive.mjs

Preconditions: `npm run build:spa` for the SPA helper.

- `node helpers/check-bridge.mjs [spa-port]`
- `node helpers/check-bridge-spa.mjs <bridge-port>`
- `npm run verify:pwa` builds and starts an isolated static server. It checks three browser engines and eight viewport sizes, image-composer fit, saved hosts and themes, offline reload, local font/icon caching, rejected incomplete updates, and user-triggered activation of a complete update.
- `npm run verify:upload` checks paired image uploads through an isolated bridge, with actual file bytes and the resulting agent prompt.

## Gotchas

- Never bind or kill port 8080.
- Phone install, push, and tap-to-Steer stay off headless Chromium.
- The loopback bridge process loads `bridge/index.mjs` once. A new dump pump or SPA in `dist/spa` is invisible until that process is restarted. A live Terminal canvas with chips and a blank pane is usually a stale Node, not a client 403.
- The `/pty` ticket is single-use. A second upgrade with the same ticket gets 401.
