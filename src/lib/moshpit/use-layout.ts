import { createContext, useContext, useSyncExternalStore } from "react";
import type { Layout } from "./layout";

export const LayoutContext = createContext<Layout | null>(null);

export function useLayout(): Layout {
  const layout = useContext(LayoutContext);
  if (!layout) throw new Error("useLayout must be used inside LayoutProvider");
  return layout;
}

// Matches the short-screen block in styles.css: the iPhone Duo's outer display
// and its inner display held landscape. Not compact, so every control stays,
// but a row that is rarely used moves into a menu.
const SHORT_QUERY = "(max-height: 719px)";

function subscribeShort(onStoreChange: () => void) {
  const mq = window.matchMedia(SHORT_QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

/** True for a screen under 720px tall, in either layout. */
export function useShortScreen() {
  return useSyncExternalStore(subscribeShort, () => window.matchMedia(SHORT_QUERY).matches, () => false);
}
