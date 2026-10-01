import { useEffect } from "react";
import { blockedCount, useMoshpitStore } from "@/lib/moshpit/store";
import { probeBridgeOrigin } from "@/lib/moshpit/bridge";
import { breadcrumb } from "@/lib/moshpit/blackbox";
import { WIDE_MIN_PX } from "@/lib/moshpit/layout";
import type { TabId } from "@/lib/moshpit/types";
import {
  DEFAULT_THEME,
  isThemeId,
  paintTheme,
  resolveTheme,
} from "@/lib/moshpit/themes";

const TABS: TabId[] = ["moshpit", "inbox", "hosts"];

function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab === value);
}

function applySearch(search: string) {
  const q = new URLSearchParams(search);
  const tab = q.get("tab");
  const agent = q.get("agent");
  // "steer" is a legacy alias: notifications already delivered to a phone
  // carry ?tab=steer, and those links must keep working.
  if (agent && (!tab || tab === "steer")) {
    const store = useMoshpitStore.getState();
    store.selectAgent(agent);
    if (window.innerWidth >= WIDE_MIN_PX) store.setTab("moshpit");
    return;
  }
  // Older links opened the global Terminal tab. Terminal now belongs to an
  // agent, so keep those links useful by opening the selected agent there.
  if (tab === "terminal") {
    const store = useMoshpitStore.getState();
    store.setDetailView("terminal");
    const target = agent ?? store.selectedAgentId;
    if (target) store.selectAgent(target);
    if (window.innerWidth >= WIDE_MIN_PX) store.setTab("moshpit");
    return;
  }
  if (tab && isTabId(tab)) {
    useMoshpitStore.getState().setTab(tab);
  }
}

/**
 * Agents waiting on you, in the tab title and on the installed app's icon, so
 * a blocked agent is visible from another tab or the home screen. Counted the
 * way the nav badge counts: only with a host connected.
 */
function useWaitingBadge() {
  const waiting = useMoshpitStore((s) =>
    s.connectedHostId ? blockedCount(s.agents) : 0,
  );
  useEffect(() => {
    document.title = waiting ? `(${waiting}) moshpit` : "moshpit";
    // Badging is installed-PWA only and absent in Firefox; a refusal is fine.
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const done = waiting ? nav.setAppBadge?.(waiting) : nav.clearAppBadge?.();
    done?.catch(() => {});
  }, [waiting]);
}

export function MoshpitRuntime({ onReady }: { onReady: (ready: boolean) => void }) {
  useWaitingBadge();
  const tick = useMoshpitStore((s) => s.tick);
  const onboarded = useMoshpitStore((s) => s.onboarded);
  const theme = useMoshpitStore((s) => s.settings.theme);
  const autoSwitch = useMoshpitStore((s) => s.settings.autoSwitch);

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const root = document.documentElement;
      // A pinch zoom shrinks the visual viewport with no keyboard on screen, so
      // a scaled page is read as no viewport at all. Returning early here left
      // whatever height the keyboard last wrote pinned to the app for good.
      const stable = viewport?.scale === 1 ? viewport : null;
      const editing =
        document.activeElement?.matches("input, textarea, select") ?? false;
      const keyboard =
        stable !== null && editing && root.clientHeight - stable.height > 120;
      // iOS can inset the visual viewport even with no keyboard. Let CSS size
      // the resting app; only follow that viewport when an editor is obscured.
      if (keyboard && stable) {
        root.style.setProperty("--app-height", `${stable.height}px`);
        root.style.setProperty("--app-top", `${stable.offsetTop}px`);
      } else {
        root.style.removeProperty("--app-height");
        root.style.removeProperty("--app-top");
      }
      root.dataset.compact = String(
        (keyboard && stable ? stable.height : root.clientHeight) < 520,
      );
      root.dataset.keyboard = String(keyboard);
    };
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pageshow", resize);
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    document.addEventListener("focusin", resize);
    document.addEventListener("focusout", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("pageshow", resize);
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      document.removeEventListener("focusin", resize);
      document.removeEventListener("focusout", resize);
      document.documentElement.style.removeProperty("--app-height");
      document.documentElement.style.removeProperty("--app-top");
      delete document.documentElement.dataset.compact;
      delete document.documentElement.dataset.keyboard;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void probeBridgeOrigin().then(() => {
      if (!cancelled) onReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [onReady]);

  useEffect(() => {
    if (!onboarded) return;
    applySearch(window.location.search);
  }, [onboarded]);

  // Trail of what the user did, so a crash report says what preceded it.
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA")
        breadcrumb(
          `focus ${el.tagName} ${el.getAttribute("placeholder") ?? ""}`,
        );
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA")
        breadcrumb(`key ${e.key.length === 1 ? "char" : e.key}`);
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useEffect(() => {
    if (!onboarded) return;
    const id = window.setInterval(() => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      tick();
    }, 1800);
    return () => window.clearInterval(id);
  }, [tick, onboarded]);

  useEffect(() => {
    const name = isThemeId(theme) ? theme : DEFAULT_THEME;
    const apply = () => {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      paintTheme(resolveTheme(name, Boolean(autoSwitch), dark));
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, autoSwitch]);

  return null;
}
