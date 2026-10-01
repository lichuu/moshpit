import { createFileRoute } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast, Toaster } from "sonner";
import { AppShell } from "@/components/moshpit/app-shell";
import { Onboarding } from "@/components/moshpit/onboarding";
import { MoshpitRuntime } from "@/components/moshpit/runtime";
import { SetupConfirm } from "@/components/moshpit/setup-confirm";
import { PwaProvider } from "@/components/moshpit/pwa";
import { LayoutProvider } from "@/lib/moshpit/layout-context";
import { CURRENT_RELEASE } from "@/lib/moshpit/releases";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { DEFAULT_THEME, THEMES, isThemeId } from "@/lib/moshpit/themes";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const onboarded = useMoshpitStore((s) => s.onboarded);
  const confirmingSetup = useMoshpitStore((s) => s.setupConfirm !== null);
  const [ready, setReady] = useState(false);
  const connected = useMoshpitStore((s) => s.hosts.some((host) => host.id === s.connectedHostId && !host.demo));
  const lastSeenRelease = useMoshpitStore((s) => s.lastSeenRelease);
  const markCurrentReleaseSeen = useMoshpitStore((s) => s.markCurrentReleaseSeen);
  const themeId = useMoshpitStore((s) => s.settings.theme);
  const toastTheme = (
    isThemeId(themeId) ? THEMES[themeId] : THEMES[DEFAULT_THEME]
  ).scheme;

  useEffect(() => {
    if (!ready || !onboarded || lastSeenRelease === CURRENT_RELEASE.id) return;
    markCurrentReleaseSeen();
    toast(CURRENT_RELEASE.title, {
      description: CURRENT_RELEASE.description,
      duration: 10_000,
    });
  }, [lastSeenRelease, markCurrentReleaseSeen, onboarded, ready]);

  return (
    <PwaProvider>
      <MoshpitRuntime onReady={setReady} />
      <Toaster theme={toastTheme} position="top-center" />
      {confirmingSetup ? (
        <SetupConfirm />
      ) : !ready && !onboarded && !connected ? (
        <div className="app-viewport grid w-full place-items-center text-sm text-muted" role="status">
          <div className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" />
            <span>Connecting to your herd…</span>
          </div>
        </div>
      ) : !onboarded && !connected ? (
        <Onboarding />
      ) : (
        <LayoutProvider>
          <AppShell />
        </LayoutProvider>
      )}
    </PwaProvider>
  );
}
