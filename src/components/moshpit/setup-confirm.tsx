import { LoaderCircle, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoshpitStore } from "@/lib/moshpit/store";

/**
 * The setup link's browser step: name the machine and the Tailscale account
 * before this browser is approved. Nothing is redeemed until Approve.
 */
export function SetupConfirm() {
  const confirm = useMoshpitStore((s) => s.setupConfirm);
  const approve = useMoshpitStore((s) => s.approveSetupLink);
  const cancel = useMoshpitStore((s) => s.cancelSetupLink);
  if (!confirm) return null;

  return (
    <main className="app-viewport mx-auto flex w-full max-w-xl flex-col items-start justify-center px-6">
      <div className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <Server className="size-5" />
      </div>
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">Finish setup</p>
      <h1 className="mt-3 text-2xl font-medium tracking-tight">Approve this browser?</h1>
      <p className="mt-3 max-w-sm text-sm leading-6 text-muted">
        The setup link lets this browser into the herd on this machine. Approve
        only if the machine and account below are the ones you set up.
      </p>
      <dl className="mt-5 grid w-full max-w-sm grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl bg-surface p-4 text-sm shadow-border">
        <dt className="text-muted">Machine</dt>
        <dd className="break-all font-mono" aria-label="Machine">{confirm.machine}</dd>
        <dt className="text-muted">Tailscale account</dt>
        <dd className="break-all font-mono" aria-label="Tailscale account">
          {confirm.login === undefined ? (
            <LoaderCircle className="size-4 animate-spin" aria-label="Checking" />
          ) : (
            confirm.login ?? "Not named by Tailscale"
          )}
        </dd>
      </dl>
      {confirm.login === null ? (
        <p className="mt-3 max-w-sm text-xs leading-5 text-muted">
          Tailscale did not name an account for this browser. Approval needs
          this browser signed in to Tailscale as the host&apos;s owner.
        </p>
      ) : null}
      <div className="mt-6 flex gap-2">
        <Button onClick={approve} disabled={confirm.login === undefined}>
          Approve
        </Button>
        <Button variant="secondary" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </main>
  );
}
