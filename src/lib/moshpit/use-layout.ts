import { createContext, useContext } from "react";
import type { Layout } from "./layout";

export const LayoutContext = createContext<Layout | null>(null);

export function useLayout(): Layout {
  const layout = useContext(LayoutContext);
  if (!layout) throw new Error("useLayout must be used inside LayoutProvider");
  return layout;
}

