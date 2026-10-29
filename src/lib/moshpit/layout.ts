import type { TabId } from "./types";

/* The list beside the detail opens at 860px, so the iPhone Duo's inner display
   held landscape (about 890px) gets both panes while an iPad in portrait (744
   to 834px) keeps the phone layout. Below 1024px it also needs 480px of
   height, which keeps a phone held landscape (up to 932 x 430) on the phone
   layout; a short desktop window stays wide. */
export const WIDE_QUERY = "(min-width: 1024px), (min-width: 860px) and (min-height: 480px)";

export function isWideViewport() {
  return window.matchMedia(WIDE_QUERY).matches;
}

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
