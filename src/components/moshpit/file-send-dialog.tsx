import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle } from "lucide-react";
import type { StoredFile } from "@/lib/moshpit/bridge";
import { formatBytes } from "@/lib/moshpit/file-upload";

/**
 * Copying a file to the host is not undone by closing the session, so it asks
 * first and says what happens: the file is copied to the host, it stays there,
 * and its path goes into the message. Cancel takes focus, Escape and the
 * backdrop cancel, and focus goes back to whatever the composer names.
 *
 * Upload runs inside the dialog. Cancel while it runs aborts the request, and
 * the bridge removes what it had begun. A refusal stays on screen with its
 * reason and a way to try again, and puts nothing in the message.
 */
export function FileSendDialog({
  file,
  upload,
  onUploaded,
  onClose,
  restoreFocus,
}: {
  /** The file to offer; the dialog is open while there is one. */
  file: File | null;
  upload: (file: File, signal: AbortSignal) => Promise<StoredFile>;
  onUploaded: (stored: StoredFile) => void;
  onClose: () => void;
  restoreFocus: () => HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const running = useRef<AbortController | null>(null);
  const dismiss = () => {
    running.current?.abort();
    running.current = null;
    onClose();
  };
  return (
    <Dialog.Root open={file !== null} onOpenChange={(next) => !next && dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
          // The composer's own popovers listen for Escape on the document.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus()?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-bg shadow-xl"
        >
          {file ? (
            <Body
              key={`${file.name}:${file.size}:${file.lastModified}`}
              file={file}
              cancel={cancel}
              running={running}
              upload={upload}
              onUploaded={onUploaded}
              onCancel={dismiss}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Its own component so a new file starts from the question again.
function Body({
  file,
  cancel,
  running,
  upload,
  onUploaded,
  onCancel,
}: {
  file: File;
  cancel: React.RefObject<HTMLButtonElement | null>;
  running: React.RefObject<AbortController | null>;
  upload: (file: File, signal: AbortSignal) => Promise<StoredFile>;
  onUploaded: (stored: StoredFile) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"ask" | "uploading" | "failed">("ask");
  const [reason, setReason] = useState("");

  function start() {
    const controller = new AbortController();
    running.current = controller;
    setPhase("uploading");
    upload(file, controller.signal).then(
      (stored) => {
        if (controller.signal.aborted) return;
        running.current = null;
        onUploaded(stored);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        running.current = null;
        setReason(error instanceof Error ? error.message : "The upload failed.");
        setPhase("failed");
      },
    );
  }

  return (
    <>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-1 pt-5">
        <Dialog.Title className="text-lg font-medium tracking-tight">
          {phase === "uploading" ? "Copying to the host" : "Copy this file to the host?"}
        </Dialog.Title>
        <p className="mt-3 break-all rounded-lg bg-surface px-3 py-2 text-sm">
          <span className="font-medium">{file.name}</span>
          <span className="text-muted"> · {formatBytes(file.size)}</span>
        </p>
        <Dialog.Description className="mt-3 text-sm leading-6 text-muted">
          It will be copied to the host this agent runs on and stay there after
          this session. Its path will be added to your message. Nothing is sent
          to the agent until you send the message.
        </Dialog.Description>
        <div role="status" className="text-sm leading-6">
          {phase === "uploading" ? (
            <p className="mt-3 flex items-center gap-2">
              <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-accent" />
              Uploading…
            </p>
          ) : null}
        </div>
        {phase === "failed" ? (
          <p role="alert" className="mt-3 break-words text-sm leading-6 text-blocked">
            {reason} Nothing was added to your message.
          </p>
        ) : null}
      </div>
      <div className="shrink-0 px-5 pb-5 pt-4">
        <div className="flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={onCancel}
            className="flex h-11 min-w-24 items-center justify-center rounded-md px-4 text-sm font-medium text-fg shadow-border tap-scale"
          >
            {phase === "failed" ? "Close" : "Cancel"}
          </button>
          {phase !== "uploading" ? (
            <button
              type="button"
              onClick={start}
              className="flex h-11 min-w-24 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-bg tap-scale"
            >
              {phase === "failed" ? "Try again" : "Upload"}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
