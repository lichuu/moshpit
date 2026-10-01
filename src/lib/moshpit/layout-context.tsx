import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { layoutFor, WIDE_MIN_PX, type Layout, type LayoutRegime } from "./layout";
import { useMoshpitStore } from "./store";

const LayoutContext = createContext<Layout | null>(null);

const QUERY = `(min-width: ${WIDE_MIN_PX}px)`;

function subscribe(onStoreChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

function getSnapshot(): LayoutRegime {
  return window.matchMedia(QUERY).matches ? "wide" : "phone";
}

function getServerSnapshot(): LayoutRegime {
  return "phone";
}

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const regime = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const tab = useMoshpitStore((s) => s.tab);
  const layout = layoutFor(regime, tab);

  useEffect(() => {
    document.documentElement.dataset.layout = regime;
    return () => {
      delete document.documentElement.dataset.layout;
    };
  }, [regime]);

  return <LayoutContext.Provider value={layout}>{children}</LayoutContext.Provider>;
}

export function useLayout(): Layout {
  const layout = useContext(LayoutContext);
  if (!layout) throw new Error("useLayout must be used inside LayoutProvider");
  return layout;
}

