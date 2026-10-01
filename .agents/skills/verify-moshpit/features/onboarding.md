# Onboarding

First launch checks for a same-origin bridge, then a new browser profile shows the three-step introduction. A detected bridge does not skip the introduction. Completion and Skip persist in that profile, so later visits open the main UI. The demo host is available only with `?demo=1`.

## Sub-features

- Three steps (01–03) advanced with `Next`; the last step's button reads `Open moshpit`.
- `Skip` on the first step completes onboarding immediately; `Back` appears from step 2 on.
- After completion the moshpit tab is active and the agent list is visible.
- Completing onboarding records the current release without a notice. An existing profile with an older release marker gets one `What's new in moshpit` toast, then persists the new marker so later visits stay quiet.

## How to get to it (user POV)

- Automatically on first launch without a bridge or an existing connection. Completion is persisted in the profile.

## Driving it with drive.mjs

Preconditions: doctor healthy; fresh browser context (the helper always provides one).

- Load `http://127.0.0.1:8188/?demo=1` and expect heading `A little space. For your whole herd.` → `drive.mjs onboard` step 01.
- Click `Next` twice, then `Open moshpit` → helper steps 02–04.
- Assert the moshpit nav button has `aria-current="page"` and the `migrate` agent card is visible → helper step 05.
- A fresh profile served by an authenticated bridge must still open onboarding. After completion, reloading that profile opens the main UI. `tests/demo/onboarding.spec.ts` verifies both paths.

## Gotchas

- Onboarding state persists per browser profile (zustand key `moshpit-v1`); driving a warm profile skips it and the scenario's first-step assertion fails.
- The `Next`/`Open moshpit` buttons exist only while onboarding is showing; once the main UI is up, name-matching them fails.
