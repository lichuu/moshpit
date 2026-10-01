import type { TabId } from "./types";

export const WIDE_MIN_PX = 1024;

export type LayoutRegime = "phone" | "wide";
export type LayoutPair = "pit-steer" | "inbox-steer" | "hosts-settings";

export type Layout =
  | { regime: "phone"; chrome: "bottom"; pane: { kind: "single" } }
  | {
      regime: "wide";
      chrome: "side";
      pane: { kind: "pair"; pair: LayoutPair };
    };

export function pairFor(tab: TabId): LayoutPair {
  switch (tab) {
    case "moshpit":
      return "pit-steer";
    case "inbox":
      return "inbox-steer";
    case "hosts":
      return "hosts-settings";
  }
}

export function layoutFor(regime: LayoutRegime, tab: TabId): Layout {
  if (regime === "phone") {
    return { regime: "phone", chrome: "bottom", pane: { kind: "single" } };
  }
  return {
    regime: "wide",
    chrome: "side",
    pane: { kind: "pair", pair: pairFor(tab) },
  };
}
