import { useEffect, useLayoutEffect, useRef } from "react";
import type { PaneHandle } from "@/components/moshpit/pane-surface";
import { createHoldRepeat } from "@/lib/moshpit/hold-repeat";
import { cn } from "@/lib/utils";

/**
 * A key-bar button that sends its key on a tap, as every key does, and keeps
 * sending it while it is held. A tap is still its click, so keyboard
 * activation sends one key and never repeats. A hold sends its first key once
 * the delay has passed, and the click that follows its release is swallowed.
 * Repeats take the same `send` as a tap, so they ride the pane's key queue and
 * batch with it.
 */
export function RepeatKey({ keyName, send, handle, live, onSent, className, children, ...rest }: Omit<React.ComponentProps<"button">, "onClick" | "type"> & {
  keyName: string;
  send: (key: string) => void;
  /** The pane this key bar types into; a hold ends when it is replaced. */
  handle: React.RefObject<PaneHandle | null>;
  /** The pane is connected. A hold ends when it is not, and does not start. */
  live: boolean;
  /** After a tap or a hold, for the caller to return focus to the pane. */
  onSent?: () => void;
}) {
  const latest = useRef({ send, handle, onSent, live });
  useLayoutEffect(() => {
    latest.current = { send, handle, onSent, live };
  });
  // The hold in progress, as a way to end it.
  const holding = useRef<(() => number) | null>(null);
  // A hold sent keys; the click after its release is not a tap.
  const repeated = useRef(false);
  const swallow = useRef(false);
  const touch = useRef(false);

  function end() {
    const stop = holding.current;
    holding.current = null;
    if (stop && stop() > 0) repeated.current = true;
  }
  useEffect(() => { if (!live) end(); }, [live]);
  useEffect(() => end, []);

  function begin(event: React.PointerEvent<HTMLButtonElement>) {
    end();
    repeated.current = false;
    swallow.current = false;
    touch.current = event.pointerType !== "mouse";
    const surface = latest.current.handle.current;
    if (!latest.current.live || !surface || event.button !== 0 || !event.isPrimary) return;
    // Without capture, a finger that drifts off the button ends the press.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
    const repeater = createHoldRepeat(() => {
      if (latest.current.handle.current !== surface) end();
      else latest.current.send(keyName);
    });
    // A hold also ends when the page stops being looked at, and when the pane
    // drops its queued keys (a failed request, going offline, a new pane).
    const onStop = (stopEvent: Event) => { if (stopEvent.type !== "visibilitychange" || document.hidden) end(); };
    const events: [EventTarget, string][] = [[window, "blur"], [window, "offline"], [document, "visibilitychange"]];
    for (const [target, type] of events) target.addEventListener(type, onStop);
    const unsubscribe = surface.onDrop(end);
    holding.current = () => {
      for (const [target, type] of events) target.removeEventListener(type, onStop);
      unsubscribe();
      return repeater.stop();
    };
    repeater.start(keyName);
  }

  function release(event: React.PointerEvent<HTMLButtonElement>) {
    const held = holding.current !== null || repeated.current;
    end();
    if (!held) return;
    // A hold is not a tap, and neither is a press let go off the button.
    const box = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    swallow.current = repeated.current || !inside;
  }

  return (
    <button
      type="button"
      {...rest}
      // A long press must not open the browser's menu or select the label.
      className={cn("select-none [-webkit-touch-callout:none]", className)}
      onPointerDown={begin}
      onPointerUp={release}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={(event) => { if (touch.current) event.preventDefault(); }}
      // The auto-repeat of a held Enter would click this again and again.
      onKeyDown={(event) => { if (event.repeat) event.preventDefault(); }}
      onClick={(event) => {
        // Keyboard activation has no detail and is never swallowed.
        const swallowed = swallow.current && event.detail !== 0;
        swallow.current = false;
        if (!swallowed) latest.current.send(keyName);
        latest.current.onSent?.();
      }}
    >
      {children}
    </button>
  );
}
