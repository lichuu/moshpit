import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Download, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { useOnline } from "@/lib/moshpit/network";

type InstallEvent = Event & {
  prompt: () => Promise<{ outcome: "accepted" | "dismissed" }>;
};

const InstallContext = createContext<{
  installed: boolean;
  prompt: InstallEvent | null;
  clearPrompt: () => void;
  update: ServiceWorker | null;
}>({ installed: false, prompt: null, clearPrompt: () => {}, update: null });

export function PwaProvider({ children }: { children: ReactNode }) {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    let registered: ServiceWorkerRegistration | null = null;
    // An installed app is resumed, not reloaded, so the check at register time
    // can be days old. Look again whenever it comes back to the foreground.
    const recheck = () => {
      if (document.visibilityState === "visible")
        registered?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", recheck);
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (cancelled) return;
        registered = registration;
        if (registration.waiting) setUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (
              !cancelled &&
              worker.state === "installed" &&
              navigator.serviceWorker.controller
            )
              setUpdate(registration.waiting);
          });
        });
      })
      .catch(() => console.warn("moshpit could not enable offline access."));
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const update = () =>
      setInstalled(
        display.matches ||
          ("standalone" in navigator && navigator.standalone === true),
      );
    const capture = (event: Event) => {
      if (!("prompt" in event) || typeof event.prompt !== "function") return;
      event.preventDefault();
      // beforeinstallprompt is browser-owned and absent from TypeScript's DOM declarations.
      setPrompt(event as InstallEvent);
    };
    const complete = () => {
      setInstalled(true);
      setPrompt(null);
    };
    update();
    display.addEventListener("change", update);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", complete);
    return () => {
      display.removeEventListener("change", update);
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);
  return (
    <InstallContext.Provider
      value={{ installed, prompt, clearPrompt: () => setPrompt(null), update }}
    >
      {children}
    </InstallContext.Provider>
  );
}

export function PwaStatus() {
  const online = useOnline();
  const { update } = useContext(InstallContext);
  const [updating, setUpdating] = useState(false);
  const connection = useMoshpitStore((s) => s.connectError);
  if (!online)
    return (
      <div
        role="status"
        className="flex shrink-0 items-center justify-center gap-2 border-b border-blocked/20 bg-blocked/10 px-4 py-3 text-xs text-blocked"
      >
        <WifiOff className="size-4 shrink-0" />
        You're offline. Reconnect to reach your agents.
      </div>
    );
  if (connection?.title === "Connection interrupted")
    return (
      <div
        role="status"
        className="shrink-0 border-b border-blocked/20 bg-blocked/10 px-4 py-3 text-center text-xs text-blocked"
      >
        {connection.detail}
      </div>
    );
  if (!update) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-border bg-surface px-4 py-2 text-xs text-muted"
    >
      A new version is ready. Finish your message before refreshing.
      <button
        type="button"
        disabled={updating}
        className="min-h-11 px-2 font-medium text-accent"
        onClick={() => {
          setUpdating(true);
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => window.location.reload(),
            { once: true },
          );
          update.postMessage({ type: "ACTIVATE_UPDATE" });
        }}
      >
        {updating ? "Updating…" : "Refresh to update"}
      </button>
    </div>
  );
}

export function InstallApp() {
  const { installed, prompt, clearPrompt } = useContext(InstallContext);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function install() {
    if (!prompt) return;
    setBusy(true);
    setError(false);
    try {
      await prompt.prompt();
    } catch {
      setError(true);
    } finally {
      clearPrompt();
      setBusy(false);
    }
  }
  return (
    <section className="rounded-2xl border border-border bg-bg p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        {installed ? (
          <Check className="size-4 text-working" />
        ) : (
          <Download className="size-4 text-accent" />
        )}
        {installed ? "moshpit is installed" : "Make yourself at home"}
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        {installed
          ? "Your workspace is a tap away."
          : "Keep moshpit in your dock or on your Home Screen."}
      </p>
      {!installed && prompt ? (
        <Button className="mt-4" onClick={() => void install()} disabled={busy}>
          {busy ? "Opening installer…" : "Install moshpit"}
          <Download className="size-4" />
        </Button>
      ) : null}
      {!installed ? (
        <details className="mt-3 text-xs leading-6 text-muted">
          <summary className="min-h-9 cursor-pointer text-accent">
            Installation help
          </summary>
          <p className="mt-2">
            On iPhone or iPad, open the Share menu and choose Add to Home
            Screen. On a Mac in Safari, choose File, then Add to Dock. In Chrome
            or Edge, look for Install in the address bar or browser menu. You
            can also keep using moshpit in this tab.
          </p>
        </details>
      ) : null}
      {error ? (
        <p role="status" className="mt-2 text-xs text-blocked">
          The installer didn't open. Use your browser's installation menu.
        </p>
      ) : null}
    </section>
  );
}
