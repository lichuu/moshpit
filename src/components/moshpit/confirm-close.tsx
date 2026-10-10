import { useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle } from "lucide-react";
import type { CloseCheck } from "@/lib/moshpit/close-check";

/** What the user types to close a pane that has work in it. */
const CONSENT = "close";

/**
 * Closing a pane ends it, so it asks first, in a dialog rather than a tap that
 * arms a button for a few seconds. Cancel takes focus (the safe choice, and
 * Enter does nothing destructive), Escape and the backdrop cancel, and focus
 * goes back to whatever opened it.
 *
 * With a `check` (an agent's checkout), the dialog opens at once and the
 * button waits for the answer. Work found, or no answer, asks for the word
 * "close" to be typed: the one tap is not enough when files could be lost
 * track of. The text field and the buttons share a footer that stays on
 * screen above the soft keyboard; the rest scrolls.
 */
export function ConfirmClose({
  open,
  title,
  description,
  confirmLabel,
  check = { phase: "clear" },
  onViewChanges,
  onCancel,
  onConfirm,
  restoreFocus,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  check?: CloseCheck;
  /** Offered beside the findings, to look before deciding. */
  onViewChanges?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** The control that opened the dialog, to refocus when it closes. */
  restoreFocus: () => HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          role="alertdialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
          // Radix cancels on Escape; stop the key here so a popover under the
          // dialog that also listens on the document (and re-subscribes as
          // this closes) does not take the same keypress and close with it,
          // taking its button, our focus target, along.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus()?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-bg shadow-xl"
        >
          <Body
            title={title}
            description={description}
            confirmLabel={confirmLabel}
            check={check}
            cancel={cancel}
            onViewChanges={onViewChanges}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Its own component so the typed text is gone each time the dialog opens.
function Body({
  title,
  description,
  confirmLabel,
  check,
  cancel,
  onViewChanges,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  check: CloseCheck;
  cancel: React.RefObject<HTMLButtonElement | null>;
  onViewChanges?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const fieldId = useId();
  const asks = check.phase === "work" || check.phase === "unknown";
  const consented = typed.trim().toLowerCase() === CONSENT;
  const ready = check.phase === "checking" ? false : asks ? consented : true;

  return (
    <>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-1 pt-5">
        <Dialog.Title className="break-words text-lg font-medium tracking-tight">
          {title}
        </Dialog.Title>
        <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
          {description}
        </Dialog.Description>
        <div role="status" className="text-sm leading-6">
          {check.phase === "checking" ? (
            <p className="mt-3 flex items-center gap-2 text-muted">
              <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
              Checking the checkout…
            </p>
          ) : check.phase === "work" ? (
            <p className="mt-3 break-words">
              This checkout has {check.found.join(", ")}.
            </p>
          ) : check.phase === "unknown" ? (
            <p className="mt-3 break-words">
              Could not check this checkout for work that would be left behind. {check.reason}
            </p>
          ) : null}
        </div>
        {check.phase === "work" && onViewChanges ? (
          <button
            type="button"
            onClick={onViewChanges}
            className="mt-3 flex h-11 items-center justify-center rounded-md px-4 text-sm font-medium text-fg shadow-border tap-scale"
          >
            View changes
          </button>
        ) : null}
      </div>
      <div className="shrink-0 px-5 pb-5 pt-4">
        {asks ? (
          <div className="mb-4">
            <label htmlFor={fieldId} className="block text-sm font-medium">
              Type close to confirm
            </label>
            <input
              id={fieldId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (consented) onConfirm();
              }}
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              // 16px at least, or iOS zooms the page when the field is focused.
              className="mt-1.5 h-11 w-full min-w-0 rounded-md border border-border bg-transparent px-3 text-base outline-none focus-visible:border-accent"
            />
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={onCancel}
            className="flex h-11 min-w-24 items-center justify-center rounded-md px-4 text-sm font-medium text-fg shadow-border tap-scale"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={onConfirm}
            className="flex h-11 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-medium text-white tap-scale disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
