# Agent list

The moshpit tab groups agents under collapsible project headers. Each project contains agent cards ordered by status. Project headers retain attention counts while collapsed, and status filters reveal matching children. Project identity uses the repository root, then the working folder or workspace, scoped to the connected host.

## Sub-features

- `Project <name>` buttons expand and collapse children. Collapse state survives reloads. `helpers/check-projects.mjs` verifies grouping and herdr worktree lookup; `helpers/check-terminal-send.mjs` verifies collapse, filtering, and opening child agents in the browser.

- Status filter chips `All`, `Blocked`, `Working`, `Done` filter the list; the Blocked chip shows a count badge when blocked agents exist.
- Cards show agent name, herdr's agent kind, catalog-matched logo, workspace, current herdr worktree branch when named, status pill, and the last output line unless it repeats the title.
- Clicking a card selects the agent and opens the agent detail (Steer).
- A plus on the project header (`New agent in <name>`) opens a sheet of herdr kinds that exist on the host PATH. Tapping a kind starts a session in that project's directory. The sheet also offers an optional `New worktree` checkout (base ref and branch) instead of the project directory, and pi kinds get a model field. A partial failure keeps the created worktree and offers a retry that starts the agent in the retained directory.
- A blocked-count badge (e.g. `2`) sits on the moshpit nav button while connected.
- Empty states: `No host` when disconnected; `herdr not running` screen when the host is up but herdr is down.

## How to get to it (user POV)

- Bottom nav `moshpit` (first tab, active by default after onboarding).
- From the no-host empty state, the `Hosts` button (demo hosts) or `Connect a host` opens the Hosts tab.

## Driving it with drive.mjs

Preconditions: doctor healthy; onboarded (helper does this automatically for non-onboard scenarios).

- Observe the default list: `migrate` (blocked) and `postcard-ui` (blocked) appear before `auth-rewrite` (working) → helper scenario `list` step 01 (or `steer` step 01).
- Click `New agent in web`, pick `pi`, and assert a `pi-` heading, then Back → `list` steps `new-agent-sheet`, `start-pi`, `back-from-new-agent`.
- Click the `/^Blocked/` chip and assert `postcard-ui` is visible while `auth-rewrite` is absent → `list` step 02–03.
- Click the `postcard-ui` card and assert the agent detail shows heading `postcard-ui` → `list` step 04.
- Blocked badge: `nav[aria-label="Primary"] > button:nth(0)` contains a span matching `^\d+$` while blocked agents exist → `hosts` scenario step 07.

## Gotchas

- The Blocked chip's accessible name carries its count (`Blocked2`) — match with `/^Blocked/`, not exact text.
- The moshpit nav button's accessible name likewise carries the blocked badge (`moshpit2`) — address nav buttons by position, not by name.
- Selecting an agent opens the Steer detail over the moshpit tab on phones; use `Back` to return to the list.
- Agent ordering is by status then recency; do not assert absolute card positions, assert relative order or presence.
