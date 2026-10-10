# Terminal

Terminal is one of the three views inside an agent detail. It shows an ANSI-rendered live pane, a special-key bar, and a raw input line. When herdr is not running on the demo host, Terminal shows a shell view with a `Start herdr` button. The agent header, the three-view control, and the phone Back button remain mounted above Terminal. Swipe and pinch gestures use the herdr prefix, which defaults to `ctrl+b`. Headless tests do not cover these touch gestures. On a live bridge host, `WS /pty` supplies the pane dump.

## Sub-features

- The special-key bar contains `esc`, `⌫` (Backspace), `tab`, `shift+tab`, `^C`, `^D`, `^L`, the herdr prefix, `up`, `down`, `left`, and `right`. Each key sends input to the focused pane and echoes it in the log. For example, `esc` adds `[esc]` and `^C` adds `^C` followed by `interrupted`. Hardware Shift+Tab sends the named `shift+tab` sequence. Home, End, PageUp, PageDown, Delete, and function keys toast that they are not sent.
- `Quick replies` is a key-bar button beside `Aa` in Terminal (Chat keeps its collapsible row). It opens a popover region named `Quick replies`; a tap sends that reply to the pane and closes the popover.
- `Display options` (the `Aa` button at the end of the key bar) opens a popover with `Wrap long lines` and `Text size S/M/L`. Both persist. Escape or a tap outside closes it without sending anything to the pane. On a phone the key strip scrolls and fades at its right edge while more keys are past it.
- The Settings `herdr prefix` input accepts `ctrl+<letter>` and defaults to `ctrl+b`. The `^A` through `^D` buttons set common values. The key bar, swipe action, hint, and toasts use the saved value. An invalid draft does not change the store. Run `helpers/check-prefix.mjs <port> [screenshot]` to verify these paths.
- Terminal uses the shared composer with accessible name `Terminal input`. Dictate inserts speech into the draft. Send passes literal text and a separate Enter through the terminal connection. Shift+Enter inserts a newline. An empty Send sends Enter.
- `Attach file`, clipboard paste, and drop accept one image through the shared composer. The thumbnail has a `Remove image` button. Send saves the image privately on the host and sends the text and image path, followed by Enter. An image can be sent without text. Failed sends preserve the text and image for retry. See [Image upload](image-paste.md) for limits.
- Pasting an image while the pane is focused or dropping it anywhere in Terminal adds it to the selected agent's session. Chat and Terminal show the same image; each keeps its own text. Focus moves to the composer. No pane input is sent until Send. Images cannot replace an attachment during delivery. Text paste keeps the pane's existing single-line and multi-line behavior.
- When the host is connected but herdr is down, Terminal shows a shell view with a `Start herdr` button. Click the button to restore the pane and reseed the agents.
- The focused pane follows agent selection; `^C` interrupts the agent (status `idle`).
- Switching to Chat or Links does not change the selected agent. On a phone, Back returns to the list or Inbox that opened it.

## How to get to it (user POV)

- Open an agent from moshpit, Inbox, or `Jump to agent`, then tap `Terminal view`.
- A legacy `?tab=terminal` link opens the currently selected agent's Terminal view instead of a removed global tab.

## Driving it with drive.mjs

Preconditions: doctor healthy; onboarded; demo host connected with herdr running.

- Click the `migrate` agent. Click `Terminal view`. Step 02 shows the terminal key bar and phone `Back`.
- Click `esc`. Step 03 shows `[esc]` in the pane log.
- Click `shift+tab`. Step 04 shows `[shift+tab]` in the pane log. Run `helpers/check-shift-tab.mjs <port> [screenshot]` for the standalone check.
- Run `helpers/check-terminal-backspace.mjs <port>` to verify that `⌫` sends Backspace to the pane without editing the separate composer draft.
- Focus the pane and press a modifier combination the pane does not support, such as Ctrl+Enter. Expect the toast `Ctrl+Enter is not sent to the pane` and no new pane line, while a plain Enter still reaches the pane. Run `helpers/check-pane-modifiers.mjs <port> [screenshot]` for the standalone check.
- Type `hello from verify` into `Terminal input`. Click `Send`. Step 05 shows the text in the pane log.
- Optional: click `^C`; expect `interrupted` in the log and the agent's status pill `idle`.

## Gotchas

- `MOSHPIT_TEST_PORT=4197 MOSHPIT_DEV_PORT=5197 npx playwright test tests/bridge/terminal-typing.spec.ts --project=phone --project=desktop --output=/tmp/moshpit-terminal-image-results --reporter=list` drives isolated bridges. It checks picker, composer and pane paste, Firefox-style body paste, drop, removal, exact image bytes and permissions, literal text, image-only sends, separate Enter, and failed-send preservation. It also checks focus, attachment protection during delivery, and isolation between agent sessions and Chat. The picker test attaches a screenshot of the thumbnail.
- `helpers/check-terminal-send.mjs` checks one-click sends through an isolated bridge, dictation callbacks, onboarding, and simulated keyboard height and offset changes. It does not prove physical iOS keyboard behavior or microphone permissions. It is still written against the pre-refactor three-view UI and needs rework before relying on it.

- A hardware key reaches the pane through `parsePaneKey`, which is a different path from the on-screen key bar. A key-bar check does not cover modifier handling, and `check-pane-modifiers.mjs` does not cover the key bar.
- The pane log keeps only the last 120 lines; assert the latest line or a fresh run's log, not an old one.
- The focused pane defaults to the `migrate` agent (`w1:p2`). Select an agent before a check that expects a different pane.
- `Start herdr` reseeds all agents (statuses reset to the seed); run it last, or re-establish any pre-mutation state afterward.
- Swipe/pinch gestures (tab switch, font resize) need real touch events; headless verification covers the key bar and raw input, which exercise the same store actions.
