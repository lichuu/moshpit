# Steer a blocked agent

Steer is the agent detail view, not a tab. The bottom nav contains moshpit, Inbox, and Hosts. Open a blocked agent from an agent card, Inbox, the Jump sheet, or a `?agent=` deep link. The detail has one persistent header with Chat, Terminal, and Links views.

On a phone it opens as a drill-in over the current tab, with an icon-only `Back` button (accessible name `Back`) and a `More actions` menu holding `Open shell here`, `Rename agent`, and `Close pane` (wide layouts show those three inline); the tab you came from stays selected, and `Back` returns to it. Switching to Terminal does not leave this drill-in: the view control and Back button remain available. In wide layouts the detail is the right-hand pane beside moshpit and Inbox. Answering a blocked agent transitions it to `working`, then to `done` after a few ticks.

## Sub-features

- Selecting an agent card shows its pane log and a composer. The composer placeholder is `Message this agent…` in Chat and `Type or dictate terminal input` in Terminal. A blocked agent shows its prompt in a banner above the composer, with the blocked choices rendered there.
- For an unread blocked dialog, Send inserts text without submitting it. A `Blocked reply controls` strip exposes `Enter` and `Esc` with the note `Typed without submitting.`. These buttons send the selected key explicitly. The demo submits on Enter and leaves the blocked state on Esc. A live choose dialog owns the keyboard and disables free-text Send.
- For the `migrate` prompt, `y` plus Enter adds `running prisma migrate deploy` and sets the status to `working`. `n` plus Enter adds `skipping migrate` and sets the status to `idle`. Other input plus Enter adds `noted — picking the work back up` and sets the status to `working`.
- For the `postcard-ui` agent, the blocked dialog is a three-step choose wizard (deployment experience, networking, first step). Tapping a numbered option sends that option through the answer path. The options lock while the answer is in flight. The next step's token unlocks its options; failure unlocks only the matching attempt.
- The demo's generic unread-dialog fallback resumes work only after an explicit Enter.
- Chat is the default view and renders user and agent bubbles with Markdown, themed syntax, and wrapping code/tables. Recognized terminal status footers are hidden outside code fences. Terminal replaces only the content below the same agent header.
- Quick replies are text-only buttons in a composer disclosure that starts collapsed. Expanding it reveals the choices; collapsing it returns that space to the conversation. Replies use the existing send path, preserve the saved draft and attachment, and never mark the draft as submitting. Unread blocked quick replies insert only; the choose dialog refuses them with a toast until the agent is unblocked.
- Pressing Send keeps focus in the textarea so a phone's soft-keyboard resize cannot move the button between press and click. The first press submits.
- The special-key bar sends input to the agent's pane. `^C` interrupts the agent and sets its status to `idle`.
- A `Dictate` button (aria-label `Dictate`) toggles voice input; a blocked agent firing raises a toast.
- Ask-user question cards appear in Chat when the agent asked a question. A live choose dialog prints the observed keys. Each wizard answer advances to the next blocked step; the final answer releases the demo agent to `working`. Resolved cards retain per-question answers. Multi-select and automatic type-then-verify submission are not implemented. Unread prompts offer `Answer in Terminal` plus the insert-only composer. Use `tests/demo/chat.spec.ts` and `tests/bridge/chat-answer.spec.ts` for wizard and delayed-response lock coverage.

## How to get to it (user POV)

- Click an agent card on the moshpit tab (jumps straight to Steer).
- Tap `Chat view`, `Terminal view`, or `Links view` in the agent header. These are sibling views of the selected agent.
- On a phone, tap `Back` from any of the views to return to the originating tab.

## Driving it with drive.mjs

Preconditions: doctor healthy; onboarded; demo host connected (default after onboarding).

- Click the `migrate` agent card. Step 02 shows the agent detail and the `Message this agent…` input.
- Type `y` and click `Send`. Step 03 shows the `Blocked reply controls` group with `Typed without submitting` and no `running prisma migrate deploy` line yet.
- Click `Enter` in the strip. Step 04 shows `running prisma migrate deploy`.
- Step 05 shows the `working` status.
- Steps 06 and 07 show a user bubble with `y` and an agent bubble with `running prisma migrate deploy`.
- Step 08 asserts the `Exact terminal output` button is detached (the Output view is removed) and `Terminal view` is present.
- Click `Terminal view`. Step 09 shows `Back`, the active moshpit tab, the pane line, and the terminal key bar.
- Click `Chat view`. Step 10 shows the agent bubble without reopening the agent.
- Click `Back`. Step 11 shows the moshpit agent list and no agent-detail dialog.
- Headless Chromium cannot verify `Dictate` because it has no microphone permission. The text path covers the same store action.

## Gotchas

- Statuses evolve over time: a `working` agent becomes `done` after a few runtime ticks (the app ticks every ~1.8 s). Assert `working` promptly after the answer, not seconds later, or re-assert with a fresh run.
- The pane log keeps the last 120 lines. Assert the latest line in a long session.
- The dictation path depends on Web Speech support, which headless Chromium lacks; do not report it as broken, report it as unverifiable here.
- Chat stores no separate messages in the demo fixture. It derives bubbles from pane-line roles and preserves blank lines within a role so fenced code stays intact.
- The `Blocked reply controls` strip only appears after an insert (Send while blocked, or `Type y`/`Type n` from Inbox). It is absent while the agent is unblocked.
