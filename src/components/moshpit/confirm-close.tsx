import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/**
 * Closing a pane ends it, so it asks first, in a dialog rather than a tap that
 * arms a button for a few seconds. Cancel takes focus (the safe choice, and
 * Enter does nothing destructive), Escape and the backdrop cancel, and focus
 * goes back to whatever opened it.
 */
export function ConfirmClose({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
  restoreFocus,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
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
          className="fixed left-1/2 top-1/2 z-[61] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg p-5 shadow-xl"
        >
          <Dialog.Title className="break-words text-lg font-medium tracking-tight">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
            {description}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
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
              onClick={onConfirm}
              className="flex h-11 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-medium text-white tap-scale"
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
