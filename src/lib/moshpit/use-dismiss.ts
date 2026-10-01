import { useEffect, useRef } from "react";

/**
 * Close a popover on a pointer-down outside `root` or on Escape. `onEscape`
 * runs after an Escape close, e.g. to hand focus back to the pane.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  root: React.RefObject<HTMLElement | null>,
  onEscape?: () => void,
) {
  // Callers pass inline closures; keep the latest without re-subscribing.
  const latest = useRef({ close, onEscape });
  latest.current = { close, onEscape };
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) latest.current.close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      latest.current.close();
      latest.current.onEscape?.();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, root]);
}
