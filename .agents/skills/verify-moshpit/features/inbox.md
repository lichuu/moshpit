# Inbox event feed

The Inbox tab lists agent events in two sections: `Needs you` (blocked unresolved) and `Recent`. A blocked unresolved row offers insert-only `Type y` / `Type n` buttons and a `Reply` button. The Inbox nav badge counts blocked unresolved events only.

## Sub-features

- Bottom-nav tab, second in order: moshpit, Inbox, Hosts.
- Inbox starts with seeded blocked events from the demo fixture (the seeded blocked agents `migrate` and `postcard-ui` each produce a blocked row). The moshpit badge and the Inbox badge both reflect these.
- `Simulate: agent blocked` (Hosts) appends a blocked row and bumps the Inbox badge. The moshpit tab becomes active after the tap.
- `Type y` and `Type n` insert the character into the pane without submitting. The agent stays blocked, the row shows `Typed into the pane — press Enter in Reply to submit.`, and the Inbox badge is unchanged.
- `Reply` opens the agent in the detail pane (Steer composer) without changing the originating tab. The composer shows the `Blocked reply controls` strip with `Enter` and `Esc`.
- Pressing `Enter` in the strip submits the inserted answer. The agent leaves `blocked`, the event moves from `Needs you` to `Recent` as a button labelled `answered`, and the badge clears if no other unresolved events remain.
- A numbered choose dialog (such as `postcard-ui`) renders tappable numbered option buttons on the row. Options lock while the answer is in flight; a failed bridge write re-enables only the matching attempt.
- A finishing working agent appends a turn row without bumping the badge. The first tool line after a working start appends a tool row, also without a badge bump.
- `Reset demo` and `Start herdr` reset the event list to the seed (blocked agents produce blocked rows again).

## How to get to it (user POV)

- Bottom nav Inbox (second tab). Do not match the button by accessible name when it carries a badge (`Inbox1`).
- After `Simulate: agent blocked`, switch from moshpit to Inbox to see the new row.

## Driving it with drive.mjs

Preconditions: doctor healthy; onboarded; demo host connected (default after onboarding).

- Click the Inbox nav button by position. Step 02 shows the `Needs you` section with the `Should I run prisma migrate? y/n` row and a `Type yes without submitting` button.
- Click `Type yes without submitting`. Step 03 shows the status `Typed into the pane`, the `Reply` button, and the Inbox badge still present.
- Click `Reply`. Step 04 shows the `Blocked reply controls` group with an `Enter` button.
- Click `Enter`, then `Back`. Step 05 shows the answered event as a button in `Recent` matching `/answered migrate.*Should I run prisma migrate/`, and no `Needs you` article for that event.
- Step 06 confirms the answered row persists in `Recent`.

## Gotchas

- Do not treat seed blocked agents as absent from Inbox. The seed produces blocked rows for each blocked agent.
- `simulateBlocked` still switches the tab to moshpit. Open Inbox after the tap.
- The Inbox badge is derived (`inboxUnread`) from blocked unresolved events. Tool and turn rows never bump it.
- Do not match the Inbox nav button by name when the badge is present. Use position 1 in `nav[aria-label="Primary"] > button`.
- Resolved events become `Recent` buttons (not articles). They carry the resolution label (`answered`, `approved`, `denied`) and the agent name.
- Statuses evolve. A later tick may move the agent from `working` to `done`. The settled recent row does not display the agent status.
