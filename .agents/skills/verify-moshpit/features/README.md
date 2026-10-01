# moshpit web demo — verification map

This directory is the maintained source for verifying the user-facing behavior of the moshpit web preview. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch the verification instance on port 8188 with `npx vite --host 127.0.0.1 --port 8188 --strictPort` (see SKILL.md Launch).
- Run `node helpers/doctor.mjs 8188` and require a healthy result before driving.
- Every drive opens `?demo=1` in a fresh browser context, so the onboarding flow always appears first; the demo host `Demo herdr` is connected by default after onboarding with `herdr` running.
- Never drive a server that was not started by this verification run — in particular, never the user's `npm run dev` on port 8080.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer stable handles: bottom-nav buttons by position in `nav[aria-label="Primary"]` (order moshpit, Inbox, Hosts), agent cards by name, the `Agent views` control, composer placeholders, and demo-control button text.
- Do not match nav buttons by accessible name — the moshpit nav button's name carries the blocked-count badge (e.g. "moshpit2"); Inbox likewise (`Inbox1`); filter chips likewise (`Blocked2`).
- Run browser actions through `node helpers/drive.mjs <scenario> 8188 <evidence-dir>`.
- Record the feature ID and the scenario used with every artifact.
- Do not report a skipped entry point as verified through a different path.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Each step produces a screenshot plus an accessibility snapshot in the run's evidence directory.
- Mutation proof includes a second observation of the changed state (status pill, badge, pane log line).
- Report an unreachable path with the attempted command and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.mjs`, `Gotchas`.

## Features

- [Onboarding](./onboarding.md) covers the three-step first-launch flow and its Skip shortcut.
- [Agent list](./agent-list.md) covers the moshpit tab: status ordering, filters, agent selection.
- [Inbox](./inbox.md) covers the event feed, insert-only Type y / Type n with Reply and Enter resolution, and the Inbox badge.
- [Steer a blocked agent](./steer.md) covers the agent detail, its Chat / Terminal / Links views, answering a blocked agent, and returning to the originating list.
- [Command suggestions](./commands.md) covers the composer catalog, prefixes, and insert-without-send.
- [Image paste](./image-paste.md) covers attaching one image to a Steer prompt.
- [Terminal](./terminal.md) covers the Terminal view inside an agent, the special-key bar, and raw input.
- [Hosts & demo controls](./hosts.md) covers connect/disconnect, host rows, and the demo control panel.
- [PWA bridge](./pwa.md) covers the loopback bridge, pair, 403, and the web manifest.
