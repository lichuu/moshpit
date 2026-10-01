import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { Copy, Globe, Plus, QrCode, ScanLine, Server, Share2, X } from "lucide-react";
import {
  hostCodeQrDataUrl,
  hostOrigin,
  makeHostCode,
  parseHostCode,
  type HostCode,
} from "@/lib/moshpit/host-code";
import { Button } from "@/components/ui/button";
import { InstallApp } from "@/components/moshpit/pwa";
import { AccessRequests, RequestAccess } from "@/components/moshpit/enrollment";
import { useLayout } from "@/lib/moshpit/layout-context";
import { useMoshpitStore } from "@/lib/moshpit/store";
import {
  listDevices,
  connectRefusal,
  probeBridgeUrl,
  pushControl,
  revokeDevice,
  setDeviceExpiry,
  type DeviceRecord,
} from "@/lib/moshpit/bridge";
import { DEFAULT_THEME, THEME_LIST, isThemeId } from "@/lib/moshpit/themes";
import type { Host, TermSize } from "@/lib/moshpit/types";
import { cn, formatAgo } from "@/lib/utils";

// Terms the app offers. The bridge accepts any whole number of days, so this
// is a convenience list, not the limit.
const EXPIRY_TERMS: { term: string; label: string }[] = [
  { term: "never", label: "Never expires" },
  { term: "30", label: "30 days" },
  { term: "90", label: "90 days" },
  { term: "365", label: "1 year" },
];

const expiryLabel = (device: DeviceRecord) => {
  if (device.revokedAt !== null) return "Revoked";
  if (device.expiresAt === null) return "Never expires";
  const when = new Date(device.expiresAt).toLocaleDateString();
  return device.active ? `Expires ${when}` : `Expired ${when}`;
};

/**
 * Every device paired with the connected host. Revoking and re-dating a
 * device is the same authority the bridge already gives a paired browser, so
 * this is the host operator's admin CLI without the shell.
 */
function PairedDevices() {
  const access = useMoshpitStore((s) => s.hostAccess);
  const host = useMoshpitStore((s) =>
    s.hosts.find((h) => h.id === s.accessHostId),
  );
  const url = host?.tailnetUrl ? host.tailnetUrl.replace(/\/$/, "") : null;
  const [devices, setDevices] = useState<DeviceRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const requestIdentity = useRef({ active: false, controller: new AbortController() });
  const ready = access.status === "ready";
  const thisDevice = access.status === "ready" ? access.deviceId : null;

  useEffect(() => {
    const identity = { active: true, controller: new AbortController() };
    const current = () => {
      const state = useMoshpitStore.getState();
      return identity.active && state.accessHostId === host?.id && state.hostAccess === access;
    };
    requestIdentity.current = identity;
    setBusy(null);
    if (!url || !ready) setDevices(null);
    else void listDevices(url, identity.controller.signal)
      .then((list) => current() && setDevices(list))
      .catch(() => current() && setDevices([]));
    return () => {
      identity.active = false;
      identity.controller.abort();
    };
  }, [host?.id, url, access, ready]);

  if (!url || !ready || !devices || devices.length === 0) return null;

  // Refetching keeps the list honest about what the bridge actually stored,
  // rather than trusting the single record an action hands back.
  const run = async (id: string, action: () => Promise<unknown>, refetch = true) => {
    const identity = requestIdentity.current;
    const current = () => {
      const state = useMoshpitStore.getState();
      return identity.active
        && requestIdentity.current === identity
        && state.accessHostId === host?.id
        && state.hostAccess === access;
    };
    setBusy(id);
    try {
      await action();
      if (!refetch || !current()) return;
      const list = await listDevices(url, identity.controller.signal);
      if (current()) setDevices(list);
    } catch (error) {
      if (current())
        toast.error(error instanceof Error ? error.message : "That did not work");
    } finally {
      if (current()) setBusy(null);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-muted">Paired devices</h3>
      {devices.map((device) => (
        <article
          key={device.id}
          className="rounded-xl bg-surface p-4 shadow-border"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {device.name}
              {device.id === thisDevice ? (
                <span className="ml-2 text-xs font-normal text-muted">
                  this device
                </span>
              ) : null}
            </p>
            <p className="shrink-0 text-xs text-muted">{expiryLabel(device)}</p>
          </div>
          <p className="mt-1 text-xs text-muted">{device.owner}</p>
          {device.revokedAt === null ? (
            <div className="mt-3 flex gap-2">
              <select
                aria-label={`Expiry for ${device.name}`}
                value={device.expiresAt === null ? "never" : ""}
                disabled={busy !== null}
                onChange={(event) =>
                  void run(device.id, () =>
                    setDeviceExpiry(url, device.id, event.target.value),
                  )
                }
                className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-foreground"
              >
                {device.expiresAt === null ? null : (
                  <option value="" disabled>
                    Change expiry…
                  </option>
                )}
                {EXPIRY_TERMS.map((option) => (
                  <option key={option.term} value={option.term}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void run(device.id, () => revokeDevice(url, device.id), device.id !== thisDevice)
                }
              >
                Revoke
              </Button>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}

const TERM: { id: TermSize; label: string }[] = [
  { id: "sm", label: "S" },
  { id: "md", label: "M" },
  { id: "lg", label: "L" },
];

type BarcodeDetectorLike = {
  new (options?: { formats?: string[] }): {
    detect(source: HTMLVideoElement): Promise<{ rawValue?: string }[]>;
  };
};

function AddHostSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const addHost = useMoshpitStore((s) => s.addHost);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [unverified, setUnverified] = useState<URL | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  // Scanning is a capability check, not an assumption: BarcodeDetector is
  // missing in some mobile browsers and camera access can be denied, so the
  // manual and paste paths stay available in every case.
  useEffect(() => {
    if (!scanning || !open) return;
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let video: HTMLVideoElement | null = null;
    let done = false;
    async function start() {
      const Detector = (window as unknown as {
        BarcodeDetector?: BarcodeDetectorLike;
      }).BarcodeDetector;
      if (!Detector) {
        setScanning(false);
        setError(
          "Camera scanning isn't available in this browser. Scan it with your camera app, paste the code below, or enter the address manually.",
        );
        return;
      }
      let detector: InstanceType<BarcodeDetectorLike>;
      try {
        detector = new Detector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch {
        setScanning(false);
        setError(
          "Camera unavailable. Paste the code below or enter the address manually.",
        );
        return;
      }
      if (done) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!videoRef.current || done) {
        stream.getTracks().forEach((t) => t.stop());
        setScanning(false);
        return;
      }
      video = videoRef.current;
      video.srcObject = stream;
      void video.play().catch(() => {});
      let detecting = false;
      // ponytail: fixed-rate detect loop; swap for native detect events if the
      // target browsers expose them and the loop proves too slow.
      timer = window.setInterval(async () => {
        if (done || detecting || !video?.srcObject) return;
        detecting = true;
        const found = await detector.detect(video).catch(() => []);
        detecting = false;
        if (done) return;
        const raw = found[0]?.rawValue;
        if (raw) applyCode(raw);
      }, 600);
    }
    void start();
    return () => {
      done = true;
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      setScanning(false);
    };
  }, [scanning, open]);

  // Scanning and pasting only prefill the form; the existing validation,
  // probe, and the explicit Save/confirm below still gate any connection.
  function applyCode(raw: string) {
    let code: HostCode;
    try {
      code = parseHostCode(raw);
    } catch (cause) {
      setScanning(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not read that host code.",
      );
      return;
    }
    setLabel(code.name);
    setAddress(code.url);
    setError("");
    setUnverified(null);
    const existing = useMoshpitStore
      .getState()
      .hosts.find((h) => !h.demo && hostOrigin(h.tailnetUrl) === code.url);
    setDuplicate(existing ? existing.label : null);
    setScanning(false);
  }
  function commit(url: URL) {
    addHost({
      label: label.trim() || url.hostname,
      transport: "tailscale",
      user: "",
      hostname: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      tailnetUrl: url.origin,
    });
    setLabel("");
    setAddress("");
    setError("");
    setUnverified(null);
    setDuplicate(null);
    onClose();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setUnverified(null);
    let url: URL;
    try {
      url = new URL(address.trim());
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname,
      );
      // A tailnet name is already inside WireGuard, so plain HTTP is sound
      // there -- but only while this page is itself on HTTP. Served over
      // HTTPS the browser blocks the probe and every later fetch as mixed
      // content, so accepting the address would just fail later and quieter.
      const plainOk =
        loopback ||
        (url.hostname.endsWith(".ts.net") &&
          globalThis.location?.protocol !== "https:");
      if (url.protocol !== "https:" && !(url.protocol === "http:" && plainOk))
        throw new Error(
          globalThis.location?.protocol === "https:"
            ? "Use an HTTPS address. This page is served over HTTPS, so the browser blocks plain HTTP bridges."
            : "Use an HTTPS address, or HTTP on localhost or a .ts.net Tailscale name.",
        );
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error(
          "Use the bridge's base address without a path, password, or query.",
        );
    } catch (cause) {
      setError(
        cause instanceof TypeError
          ? "Enter a full URL, such as https://my-machine.tailnet.ts.net."
          : cause instanceof Error
            ? cause.message
            : "Check the bridge address.",
      );
      return;
    }
    setChecking(true);
    const refusal = await connectRefusal(url.origin);
    if (refusal) {
      setChecking(false);
      setError(refusal);
      return;
    }
    const reachable = await probeBridgeUrl(url.origin);
    setChecking(false);
    if (!reachable) {
      // The probe is a convenience, not a gate: a machine that is merely
      // asleep is still a host worth saving, so offer the address anyway.
      setUnverified(url);
      setError(
        "No moshpit bridge answered there. Is the bridge up behind Tailscale Serve?",
      );
      return;
    }
    commit(url);
    toast("Host verified and saved. Connect when you’re ready.");
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setScanning(false);
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed bottom-0 left-1/2 z-50 max-h-[90dvh] w-full max-w-lg -translate-x-1/2 overflow-y-auto rounded-t-3xl border border-border bg-bg p-6 pb-safe shadow-xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:p-8">
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Server className="size-5" />
          </div>
          <Dialog.Title className="text-2xl font-medium tracking-tight">
            Bring your herd home.
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-muted">
            Add the address of your machine's herdr bridge. Keep Tailscale
            connected on both devices.
          </Dialog.Description>
          <Dialog.Close
            aria-label="Close add host"
            className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface"
          >
            <X className="size-5" />
          </Dialog.Close>
          <form onSubmit={save} className="mt-6 space-y-5">
            <button
              type="button"
              onClick={() => setScanning(true)}
              disabled={scanning}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border-strong text-sm font-medium tap-scale"
            >
              <ScanLine className="size-4" />
              {scanning ? "Scanning…" : "Scan host QR"}
            </button>
            {scanning ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="h-40 w-full rounded-xl bg-black object-cover"
              />
            ) : null}
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1 text-sm font-medium">
                Paste host code
                <input
                  value={paste}
                  onChange={(e) => {
                    setPaste(e.target.value);
                    setError("");
                  }}
                  placeholder='e.g. {"type":"moshpit-host"…}'
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="mt-2 h-12 w-full rounded-xl border border-border-strong bg-bg px-4 font-mono text-xs font-normal"
                />
              </label>
              <button
                type="button"
                disabled={!paste.trim()}
                onClick={() => {
                  applyCode(paste);
                  setPaste("");
                }}
                className="h-12 shrink-0 rounded-xl border border-border-strong px-4 text-sm font-medium tap-scale"
              >
                Apply
              </button>
            </div>
            <label className="block text-sm font-medium">
              Host name{" "}
              <span className="font-normal text-subtle">optional</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My Mac mini"
                className="mt-2 h-12 w-full rounded-xl border border-border-strong bg-bg px-4 font-normal"
              />
            </label>
            <label className="block text-sm font-medium">
              Bridge URL
              <input
                required
                type="url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setError("");
                  setUnverified(null);
                }}
                placeholder="https://my-machine.tailnet.ts.net"
                aria-describedby={error ? "host-error" : "host-help"}
                aria-invalid={Boolean(error)}
                className="mt-2 h-12 w-full rounded-xl border border-border-strong bg-bg px-4 font-normal"
              />
            </label>
            <p id="host-help" className="text-xs leading-6 text-muted">
              Use the HTTPS address provided by Tailscale Serve on the machine
              running your bridge. The host approves this browser once you
              connect.
            </p>
            {error ? (
              <p id="host-error" role="alert" className="text-sm text-blocked">
                {error}
              </p>
            ) : null}
            {duplicate ? (
              <p className="text-sm text-working">
                A host with this address is already saved as “{duplicate}”.
                Saving again adds a second profile, it never overwrites the
                first — confirm only if that is what you want.
              </p>
            ) : null}
            <Button type="submit" className="w-full" size="lg" disabled={checking}>
              {checking ? "Verifying bridge…" : unverified ? "Check again" : "Save host"}
              <Plus className="size-4" />
            </Button>
            {unverified ? (
              <button
                type="button"
                onClick={() => {
                  commit(unverified);
                  toast("Host saved unverified. Connect when it's awake.");
                }}
                className="h-11 w-full rounded-xl border border-border text-sm font-medium text-muted tap-scale"
              >
                Save anyway
              </button>
            ) : null}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HostQrDialog({
  open,
  host,
  onClose,
}: {
  open: boolean;
  host: Host;
  onClose: () => void;
}) {
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || !host.tailnetUrl) return;
    let live = true;
    setImage("");
    setFailed(false);
    const url = host.tailnetUrl;
    void Promise.resolve()
      .then(() => hostCodeQrDataUrl(makeHostCode({ name: host.label, url })))
      .then((src) => {
        if (live) setImage(src);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open, host.label, host.tailnetUrl]);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed bottom-0 left-1/2 z-50 max-h-[90dvh] w-full max-w-md -translate-x-1/2 overflow-y-auto rounded-t-3xl border border-border bg-bg p-6 pb-safe shadow-xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:p-8">
          <Dialog.Close
            aria-label="Close host QR"
            className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface"
          >
            <X className="size-5" />
          </Dialog.Close>
          <Dialog.Title className="flex items-center gap-2 text-xl font-medium tracking-tight">
            <QrCode className="size-5 text-accent" />
            Host code
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-muted">
            Scan with the Add host screen on another moshpit device to prefill
            its form. Nothing connects until that device reviews the address
            and confirms.
          </Dialog.Description>
          <div className="mt-5 flex justify-center">
            {failed ? (
              <p className="text-sm text-blocked">
                Could not build the code for this host.
              </p>
            ) : image ? (
              <img
                src={image}
                alt={`QR code for ${host.label} at ${host.tailnetUrl}`}
                className="size-56 rounded-2xl border border-border bg-white p-2"
              />
            ) : null}
          </div>
          <p className="mt-4 break-all text-center font-mono text-xs text-muted">
            {host.tailnetUrl}
          </p>
          <p className="mt-3 text-xs leading-6 text-subtle">
            The code carries only the name and address — no device tokens or
            credentials. A scanned code alone grants no access.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The connected host's address for opening the app on another device. The QR
 * holds only the origin, so a phone camera opens it; access still takes
 * Tailscale as the owner and an approval.
 */
function ShareAddressDialog({
  open,
  origin,
  onClose,
}: {
  open: boolean;
  origin: string;
  onClose: () => void;
}) {
  const [image, setImage] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    void hostCodeQrDataUrl(origin).then((src) => {
      if (live) setImage(src);
    });
    return () => {
      live = false;
    };
  }, [open, origin]);
  const copy = () => {
    void navigator.clipboard
      .writeText(origin)
      .then(() => toast("Address copied"))
      .catch(() => toast("Could not copy", { description: "Select the address and copy it instead." }));
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed bottom-0 left-1/2 z-50 max-h-[90dvh] w-full max-w-md -translate-x-1/2 overflow-y-auto rounded-t-3xl border border-border bg-bg p-6 pb-safe shadow-xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:p-8">
          <Dialog.Close
            aria-label="Close share address"
            className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface"
          >
            <X className="size-5" />
          </Dialog.Close>
          <Dialog.Title className="flex items-center gap-2 text-xl font-medium tracking-tight">
            <Share2 className="size-5 text-accent" />
            Share address
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-muted">
            On a phone: install Tailscale, sign in as this host&apos;s owner,
            then scan the code or open the address. The phone asks for access,
            and you approve it here under Hosts.
          </Dialog.Description>
          <div className="mt-5 flex justify-center">
            {image ? (
              <img
                src={image}
                alt={`QR code for ${origin}`}
                className="size-56 rounded-2xl border border-border bg-white p-2"
              />
            ) : null}
          </div>
          <p className="mt-4 break-all text-center font-mono text-xs text-muted">{origin}</p>
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={copy}>
              <Copy className="size-4" />
              Copy address
            </Button>
          </div>
          <p className="mt-3 text-xs leading-6 text-subtle">
            The code holds only the address. It grants no access by itself.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HostRow({ host }: { host: Host }) {
  const connectedId = useMoshpitStore((s) => s.connectedHostId);
  const connecting = useMoshpitStore((s) => s.connecting);
  const connectHost = useMoshpitStore((s) => s.connectHost);
  const disconnect = useMoshpitStore((s) => s.disconnect);
  const removeHost = useMoshpitStore((s) => s.removeHost);
  const [qrOpen, setQrOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const live = connectedId === host.id;
  // A host is attached only after an approved snapshot read.
  const shareOrigin = live && !host.demo ? hostOrigin(host.tailnetUrl) : null;
  return (
    <article className="rounded-2xl border border-border bg-bg p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-accent">
          <Server className="size-5" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{host.label}</h3>
          <p className="mt-1 truncate text-xs text-muted">
            {host.demo
              ? "A small herd to explore"
              : host.tailnetUrl || host.hostname}
          </p>
        </div>
        {live ? (
          <span className="rounded-full bg-working/10 px-2 py-1 text-2xs font-medium text-working">
            {host.demo ? "live" : "attached"}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex items-center gap-2 text-2xs text-subtle">
        <Globe className="size-3" />
        {host.demo ? "Demo" : "Tailscale bridge"}
        <span>·</span>
        <span>
          {host.lastSeenAt
            ? `Seen ${formatAgo(host.lastSeenAt)}`
            : "Ready to connect"}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {live ? (
          <Button variant="secondary" onClick={disconnect}>
            Disconnect
          </Button>
        ) : host.demo || host.tailnetUrl ? (
          <Button onClick={() => connectHost(host.id, "explicit")} disabled={connecting}>
            {connecting ? "Attaching…" : "Connect"}
          </Button>
        ) : (
          <Button disabled variant="secondary">
            Bridge URL needed
          </Button>
        )}
        {shareOrigin ? (
          <Button variant="ghost" onClick={() => setShareOpen(true)}>
            <Share2 className="size-4" />
            Share address
          </Button>
        ) : null}
        {host.tailnetUrl ? (
          <Button variant="ghost" onClick={() => setQrOpen(true)}>
            <QrCode className="size-4" />
            Host QR
          </Button>
        ) : null}
        {!host.demo ? (
          <Button variant="ghost" onClick={() => removeHost(host.id)}>
            Remove
          </Button>
        ) : null}
      </div>
      <HostQrDialog open={qrOpen} host={host} onClose={() => setQrOpen(false)} />
      {shareOrigin ? <ShareAddressDialog open={shareOpen} origin={shareOrigin} onClose={() => setShareOpen(false)} /> : null}
      {!host.demo && !host.tailnetUrl ? (
        <p className="mt-3 text-xs leading-6 text-muted">
          This saved profile needs a browser bridge. Use Add host with your
          machine's Tailscale HTTPS address.
        </p>
      ) : null}
    </article>
  );
}

/**
 * The host-side command that approves this browser. Only the admin socket can
 * issue a pairing grant, so the browser can show the command but never run it.
 * Characters a double-quoted shell word would expand are dropped from the name.
 */
function pairCommand(name: string) {
  const safe = name.trim().replace(/["$`\\]/g, "") || "This device";
  return `node bridge/admin.mjs pair --name "${safe}"`;
}

export function Hosts() {
  const layout = useLayout();
  const wide =
    layout.pane.kind === "pair" && layout.pane.pair === "hosts-settings";
  const hosts = useMoshpitStore((s) => s.hosts);
  const connectError = useMoshpitStore((s) => s.connectError);
  const access = useMoshpitStore((s) => s.hostAccess);
  const accessHostId = useMoshpitStore((s) => s.accessHostId);
  const connectHost = useMoshpitStore((s) => s.connectHost);
  const connecting = useMoshpitStore((s) => s.connecting);
  const pairingDevice = useMoshpitStore((s) => {
    const origin = hostOrigin(s.hosts.find((host) => host.id === s.accessHostId)?.tailnetUrl);
    return origin !== null && s.pairingOrigins.includes(origin);
  });
  const pair = useMoshpitStore((s) => s.pair);
  const accessUrl = useMoshpitStore((s) => s.hosts.find((host) => host.id === s.accessHostId)?.tailnetUrl?.replace(/\/$/, "") ?? null);
  const [pairingSecret, setPairingSecret] = useState("");
  const [deviceName, setDeviceName] = useState("");
  // Kept here, not in the panel: reconnecting remounts the panel mid-pairing.
  const [manualPairing, setManualPairing] = useState(false);
  const needsPassword = useMoshpitStore((s) => s.needsPassword);
  const needsPasswordHostId = useMoshpitStore((s) => s.needsPasswordHostId);
  const login = useMoshpitStore((s) => s.login);
  const settings = useMoshpitStore((s) => s.settings);
  const pushSetup = useMoshpitStore((s) => s.pushSetup);
  const enablePush = useMoshpitStore((s) => s.enablePush);
  const disablePush = useMoshpitStore((s) => s.disablePush);
  const updateSettings = useMoshpitStore((s) => s.updateSettings);
  const simulateBlocked = useMoshpitStore((s) => s.simulateBlocked);
  const stopHerdr = useMoshpitStore((s) => s.stopHerdr);
  const resetDemo = useMoshpitStore((s) => s.resetDemo);
  const demoHost = useMoshpitStore((s) => s.hosts.some((h) => h.demo));

  const [sheetOpen, setSheetOpen] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState(settings.prefix);
  const [passwordDraft, setPasswordDraft] = useState("");
  const notifyControl = pushControl(pushSetup);

  const hostCol = (
    <>
      {connectError ? (
        <aside role="alert" className="rounded-xl bg-surface p-4 shadow-border">
          <p className="text-sm font-medium text-blocked">
            {connectError.title}
          </p>
          <p className="mt-2 text-pretty text-sm leading-normal text-muted">
            {connectError.detail}
          </p>
          {connectError.retryable && accessHostId ? (
            <Button className="mt-3" onClick={() => connectHost(accessHostId, "explicit")} disabled={connecting}>
              Retry
            </Button>
          ) : null}
          {connectError.incompatible === "app" ? (
            <Button className="mt-3" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          ) : connectError.incompatible === "bridge" && accessHostId ? (
            <Button className="mt-3" onClick={() => connectHost(accessHostId, "explicit")} disabled={connecting}>
              Check again
            </Button>
          ) : null}
        </aside>
      ) : null}

      {access.status === "pairing-required" && accessHostId ? (
        <section className="rounded-xl bg-surface p-4 shadow-border">
          <p className="text-sm font-medium text-foreground">
            {access.reason === "revoked"
              ? "This device was revoked"
              : access.reason === "expired"
                ? "This device's approval expired"
                : "Approve this device"}
          </p>
          <p className="mt-1 text-pretty text-sm leading-normal text-muted">
            {access.reason === "new"
              ? "This browser is signed in to the host but not yet approved to send anything to it."
              : "Signing in is not enough to approve it again."}
          </p>
          {accessUrl ? <RequestAccess hostId={accessHostId} url={accessUrl} /> : null}
          <details className="mt-4" open={manualPairing} onToggle={(event) => setManualPairing(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm text-muted">Have a pairing secret?</summary>
            <p className="mt-2 text-pretty text-sm leading-normal text-muted">
              Create one on the machine running the bridge:
            </p>
            <code className="mt-2 block select-all overflow-x-auto whitespace-pre rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground shadow-border">
              {pairCommand(deviceName)}
            </code>
            <p className="mt-2 text-pretty text-sm leading-normal text-muted">
              Enter the pairing secret it prints. It works once, within five
              minutes.
            </p>
            <form
              aria-label="Device approval"
              aria-busy={pairingDevice}
              className="mt-3 flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void pair(accessHostId, pairingSecret.trim(), deviceName.trim() || undefined);
                setPairingSecret("");
              }}
            >
              <input
                aria-label="Device name"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                disabled={pairingDevice}
                maxLength={64}
                placeholder="This device"
                className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-foreground"
              />
              <div className="flex gap-2">
                <input
                  id="pairing-secret"
                  aria-label="Pairing secret"
                  value={pairingSecret}
                  onChange={(event) => setPairingSecret(event.target.value)}
                  disabled={pairingDevice}
                  required
                  autoComplete="off"
                  // The secret is case sensitive, so every iOS keyboard courtesy
                  // here corrupts it: a capitalised first letter or a smart dash
                  // fails the pairing with no clue why.
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Pairing secret"
                  className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 font-mono text-sm text-foreground"
                />
                <button
                  type="submit"
                  disabled={pairingDevice}
                  className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  {pairingDevice ? "Pairing…" : "Pair"}
                </button>
              </div>
            </form>
          </details>
        </section>
      ) : null}
      {needsPassword ? (
        <form
          className="rounded-xl bg-surface p-4 shadow-border"
          onSubmit={(event) => {
            event.preventDefault();
            if (needsPasswordHostId && passwordDraft)
              login(needsPasswordHostId, passwordDraft);
            setPasswordDraft("");
          }}
        >
          <label
            htmlFor="bridge-password"
            className="text-sm font-medium text-muted"
          >
            Bridge password
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="bridge-password"
              type="password"
              autoFocus
              value={passwordDraft}
              onChange={(event) => setPasswordDraft(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-foreground"
            />
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Unlock
            </button>
          </div>
        </form>
      ) : null}

      <section className="space-y-3">
        {hosts.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border-strong p-6 text-sm leading-6 text-muted">
            Your machines will appear here. Add a host to get started.
          </p>
        ) : null}
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} />
        ))}
      </section>

      <Button
        variant="secondary"
        className="w-full"
        onClick={() => setSheetOpen(true)}
      >
        <Plus className="size-4" />
        Add host
      </Button>
      <AccessRequests />
      <PairedDevices />
      <InstallApp />
    </>
  );

  const demoCol = (
    <>
      {/* Fixture controls: only meaningful against the seeded demo host. */}
      {demoHost ? (
        <section className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">
            Demo controls
          </p>
          <Button
            variant="secondary"
            className="w-full"
            onClick={simulateBlocked}
          >
            Simulate: agent blocked
          </Button>
          <Button variant="secondary" className="w-full" onClick={stopHerdr}>
            Simulate: herdr not running
          </Button>
          <Button variant="ghost" className="w-full" onClick={resetDemo}>
            Reset demo
          </Button>
        </section>
      ) : null}

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">
          Settings
        </p>
        <div className="rounded-xl bg-surface px-3 py-3 shadow-border">
          <label className="flex flex-col gap-2">
            <span className="text-sm">Appearance</span>
            <select
              aria-label="Appearance"
              value={isThemeId(settings.theme) ? settings.theme : DEFAULT_THEME}
              onChange={(e) =>
                updateSettings({
                  theme: isThemeId(e.target.value)
                    ? e.target.value
                    : DEFAULT_THEME,
                  autoSwitch: false,
                })
              }
              className="h-11 rounded-md bg-surface-2 px-3 font-mono text-sm text-fg shadow-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {THEME_LIST.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-muted">
            Choose the quiet moshpit palette or any of the original herdr
            themes.
          </p>
        </div>
        <label className="flex h-14 items-center justify-between rounded-xl bg-surface px-3 shadow-border">
          <span className="text-sm">Match device appearance</span>
          <input
            type="checkbox"
            checked={Boolean(settings.autoSwitch)}
            onChange={(e) => updateSettings({ autoSwitch: e.target.checked })}
            className="size-4 accent-accent"
          />
        </label>
        <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2 shadow-border">
          <span className="text-sm">Terminal size</span>
          <div className="flex gap-1">
            {TERM.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => updateSettings({ termSize: t.id })}
                className={cn(
                  "size-9 rounded-sm text-xs font-medium",
                  settings.termSize === t.id
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-2 text-muted",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex h-14 items-center justify-between rounded-xl bg-surface px-3 shadow-border">
          <span className="text-sm">Wrap long terminal lines</span>
          <input
            type="checkbox"
            checked={Boolean(settings.termWrap)}
            onChange={(e) => updateSettings({ termWrap: e.target.checked })}
            className="size-4 accent-accent"
          />
        </label>
        <div className="flex flex-col gap-2 rounded-xl bg-surface px-3 py-2 shadow-border">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">herdr prefix</span>
            <input
              value={prefixDraft}
              onChange={(e) => {
                const v = e.target.value.trim().toLowerCase();
                setPrefixDraft(v);
                if (/^ctrl\+[a-z]$/.test(v)) updateSettings({ prefix: v });
              }}
              placeholder="ctrl+b"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-10 w-28 rounded-md bg-surface-2 px-3 text-center font-mono text-sm text-fg shadow-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
          </div>
          <div className="flex gap-1">
            {"abcd".split("").map((letter) => (
              <button
                key={letter}
                type="button"
                onClick={() => {
                  setPrefixDraft(`ctrl+${letter}`);
                  updateSettings({ prefix: `ctrl+${letter}` });
                }}
                aria-label={`Set prefix ctrl plus ${letter}`}
                className={cn(
                  "size-9 rounded-sm font-mono text-xs font-medium",
                  settings.prefix === `ctrl+${letter}`
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-2 text-muted shadow-border",
                )}
              >
                ^{letter.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <label className="flex h-14 items-center justify-between rounded-xl bg-surface px-3 shadow-border">
          <span className="text-sm">Voice to composer</span>
          <input
            type="checkbox"
            checked={settings.voice}
            onChange={(e) => updateSettings({ voice: e.target.checked })}
            className="size-4 accent-accent"
          />
        </label>
        <label className="flex h-14 items-center justify-between rounded-xl bg-surface px-3 shadow-border">
          <span className="text-sm">Notify when an agent blocks</span>
          <input
            type="checkbox"
            checked={notifyControl.checked}
            disabled={notifyControl.disabled}
            onChange={() => {
              if (notifyControl.checked) void disablePush();
              else void enablePush();
            }}
            className="size-4 accent-accent"
          />
        </label>
        {notifyControl.note ? (
          <p className="px-1 text-2xs text-subtle">{notifyControl.note}</p>
        ) : null}
        <p className="px-1 text-2xs text-subtle">
          Open source. Your agents run on your machines.
        </p>
      </section>
    </>
  );

  return (
    <div
      className={
        wide
          ? "mx-auto grid min-h-0 w-full max-w-5xl flex-1 grid-cols-2 gap-8 overflow-y-auto px-7 py-7"
          : "mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-y-auto px-5 py-6"
      }
    >
      {wide ? (
        <>
          <div className="space-y-6">{hostCol}</div>
          <div className="space-y-6">{demoCol}</div>
        </>
      ) : (
        <>
          {hostCol}
          {demoCol}
        </>
      )}
      <AddHostSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}
