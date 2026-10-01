import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMoshpitStore } from "@/lib/moshpit/store";
import {
  decideAccessRequest,
  forgetRequest,
  heldRequest,
  listAccessRequests,
  redeemRequest,
  requestAccess,
  requestStatus,
  validateCredential,
  type HeldRequest,
  type PendingRequest,
} from "@/lib/moshpit/enrollment";
import { formatAgo } from "@/lib/utils";

const STATUS_POLL_MS = 2000;
const LIST_POLL_MS = 5000;

type Phase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "pending"; held: HeldRequest }
  | { kind: "joining"; held: HeldRequest }
  | { kind: "rejected" }
  | { kind: "expired" }
  | { kind: "lost" }
  | { kind: "failed"; message: string };

const ENDED: Partial<Record<Phase["kind"], { title: string; detail: string }>> = {
  rejected: { title: "This request was rejected", detail: "A device with access said no. Ask again if that was a mistake." },
  expired: { title: "This request expired", detail: "Nobody approved it within five minutes. Start a new request." },
  lost: {
    title: "This approval was already used",
    detail: "The answer never reached this browser, so it cannot be used again. Start a new request.",
  },
};

const codeOf = (error: unknown) => (error && typeof error === "object" && "code" in error ? String(error.code) : undefined);

/**
 * The primary path for a browser the host has not approved: ask, show the
 * phrase, wait for a decision, then redeem once and connect.
 */
export function RequestAccess({ hostId, url }: { hostId: string; url: string }) {
  const connectHost = useMoshpitStore((s) => s.connectHost);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>(() => {
    const held = heldRequest(url);
    return held ? { kind: "pending", held } : { kind: "idle" };
  });

  useEffect(() => {
    const held = heldRequest(url);
    setPhase(held ? { kind: "pending", held } : { kind: "idle" });
  }, [url]);

  useEffect(() => {
    if (phase.kind !== "pending" && phase.kind !== "joining") return;
    let live = true;
    const held = phase.held;
    const end = (kind: "rejected" | "expired" | "lost") => {
      forgetRequest(url);
      if (live) setPhase({ kind });
    };
    const join = async () => {
      try {
        await redeemRequest(url, held);
        await validateCredential(url);
        if (live) connectHost(hostId, "explicit");
      } catch (error) {
        const code = codeOf(error);
        if (!live) return;
        if (code === "enrollment_consumed") end("lost");
        else if (code === "enrollment_expired") end("expired");
        else if (code === "enrollment_rejected") end("rejected");
        // No answer at all: the next status read says whether it was used.
        else if (code === undefined && error instanceof TypeError) setPhase({ kind: "pending", held });
        else {
          forgetRequest(url);
          setPhase({ kind: "failed", message: error instanceof Error ? error.message : "Could not finish the request." });
        }
      }
    };
    if (phase.kind === "joining") {
      void join();
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(async () => {
      if (Date.now() >= held.expiresAt) return end("expired");
      try {
        const status = await requestStatus(url, held);
        if (!live) return;
        if (status === "approved") setPhase({ kind: "joining", held });
        else if (status === "rejected") end("rejected");
        else if (status === "expired" || status === "unknown") end("expired");
        else if (status === "consumed") end("lost");
        else setPhase({ kind: "pending", held });
      } catch {
        if (live) setPhase({ kind: "pending", held });
      }
    }, STATUS_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [phase, url, hostId, connectHost]);

  const ask = async () => {
    setPhase({ kind: "asking" });
    try {
      setPhase({ kind: "pending", held: await requestAccess(url, name.trim() || "This device") });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : "Could not ask for access." });
    }
  };

  if (phase.kind === "pending" || phase.kind === "joining")
    return (
      <div className="mt-3 space-y-2" aria-live="polite">
        <p className="text-sm font-medium text-foreground">
          {phase.kind === "joining" ? "Approved. Connecting…" : "Waiting for approval"}
        </p>
        <p
          aria-label="Verification phrase"
          className="rounded-lg bg-background px-3 py-2 text-center font-mono text-lg text-foreground shadow-border"
        >
          {phase.held.phrase}
        </p>
        <p className="text-pretty text-sm leading-normal text-muted">
          Approve this browser from a device that already has access, or run moshpit devices approve on the host.
          Check that it shows the same phrase.
        </p>
        <p className="text-xs text-muted">
          Expires {new Date(phase.held.expiresAt).toLocaleTimeString()}.
        </p>
        <Button
          variant="ghost"
          disabled={phase.kind === "joining"}
          onClick={() => {
            forgetRequest(url);
            setPhase({ kind: "idle" });
          }}
        >
          Cancel request
        </Button>
      </div>
    );

  const ended = ENDED[phase.kind];
  return (
    <div className="mt-3 space-y-2">
      {ended ? (
        <div role="status">
          <p className="text-sm font-medium text-blocked">{ended.title}</p>
          <p className="mt-1 text-pretty text-sm leading-normal text-muted">{ended.detail}</p>
        </div>
      ) : phase.kind === "failed" ? (
        <p role="status" className="text-pretty text-sm leading-normal text-blocked">
          {phase.message}
        </p>
      ) : null}
      <form
        aria-label="Request access"
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input
          aria-label="Name for this device"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          placeholder="This device"
          className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-foreground"
        />
        <button
          type="submit"
          disabled={phase.kind === "asking"}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {phase.kind === "asking" ? "Asking…" : ended ? "Request access again" : "Request access"}
        </button>
      </form>
    </div>
  );
}

/**
 * Requests waiting on the connected host, for an approved browser to decide.
 * Polled only while this view is mounted and the page is visible.
 */
export function AccessRequests() {
  const access = useMoshpitStore((s) => s.hostAccess);
  const host = useMoshpitStore((s) => s.hosts.find((h) => h.id === s.accessHostId));
  const url = host?.tailnetUrl ? host.tailnetUrl.replace(/\/$/, "") : null;
  const ready = access.status === "ready";
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    setRequests([]);
    setConfirming(null);
    if (!url || !ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    const load = () => {
      clearTimeout(timer);
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      void listAccessRequests(url, controller.signal)
        .then((list) => !controller.signal.aborted && setRequests(list))
        .catch(() => {})
        .finally(() => {
          loading = false;
          if (!controller.signal.aborted) timer = setTimeout(load, LIST_POLL_MS);
        });
    };
    refresh.current = load;
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [url, ready, access]);

  if (!url || !ready || requests.length === 0) return null;

  const decide = async (request: PendingRequest, decision: "approve" | "reject") => {
    setBusy(true);
    try {
      await decideAccessRequest(url, request.id, decision);
      toast(decision === "approve" ? `Approved ${request.name}` : `Rejected ${request.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work");
    } finally {
      setBusy(false);
      setConfirming(null);
      refresh.current();
    }
  };

  return (
    <section className="space-y-3" aria-label="Access requests">
      <h3 className="text-sm font-medium text-muted">Access requests</h3>
      {requests.map((request) => (
        <article key={request.id} className="rounded-xl bg-surface p-4 shadow-border">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-foreground">{request.name}</p>
            <p className="shrink-0 text-xs text-muted">{formatAgo(Date.now() - request.ageMs)}</p>
          </div>
          <p className="mt-1 font-mono text-sm text-foreground">{request.phrase}</p>
          {confirming === request.id ? (
            <div className="mt-3 space-y-2">
              <p className="text-pretty text-sm leading-normal text-muted">
                Approve only if the new device shows <span className="font-mono text-foreground">{request.phrase}</span>.
              </p>
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => void decide(request, "approve")}>
                  Confirm approval
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button disabled={busy} onClick={() => setConfirming(request.id)}>
                Approve
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void decide(request, "reject")}>
                Reject
              </Button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
