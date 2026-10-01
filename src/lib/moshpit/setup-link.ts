// A setup link, `<origin>/#moshpit-setup=<secret>`, carries a single-use
// pairing grant from `moshpit setup`. This module is imported first by
// src/main.tsx, so the fragment is read and removed before the router, the
// store or any breadcrumb sees the URL. The secret stays in this module's
// memory and is never written to storage.

const KEY = "#moshpit-setup=";

type Entry = { readonly hash: string; readonly pathname: string; readonly search: string };
type Replace = { replaceState(data: unknown, unused: string, url?: string): void; readonly state: unknown };

/** Strips a setup fragment from the current entry and returns its secret. Any other fragment is left alone. */
export function captureSetupLink(location: Entry, history: Replace): string | null {
  if (!location.hash.startsWith(KEY)) return null;
  const secret = location.hash.slice(KEY.length);
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return secret || null;
}

let held = typeof window === "undefined" ? null : captureSetupLink(window.location, window.history);

// A link pasted into a tab already on this page is a fragment navigation,
// which runs no module again. Reloading keeps the fragment for the capture above.
if (typeof window !== "undefined")
  window.addEventListener("hashchange", () => {
    if (window.location.hash.startsWith(KEY)) window.location.reload();
  });

/** The captured secret, once. Every later call returns null. */
export function takeSetupCapability(): string | null {
  const secret = held;
  held = null;
  return secret;
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X/, "Mac"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/** A device name such as "Chrome on Android", for the approval the link creates. */
export function browserDeviceName(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Browser";
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
