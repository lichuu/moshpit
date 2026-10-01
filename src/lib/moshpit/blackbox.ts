import { accessError, hostAccess, identityHeaders } from "./access";

type Crumb = { t: number; what: string };

const trail: Crumb[] = [];
const TRAIL = 25;
let target = "";

export function breadcrumb(what: string) {
  trail.push({ t: Math.round(performance.now()), what });
  if (trail.length > TRAIL) trail.shift();
}

function post(payload: Record<string, unknown>) {
  if (!target || hostAccess(target).status !== "ready") return;
  const body = JSON.stringify({ ...payload, trail: trail.slice(-TRAIL) });
  const url = target;
  void fetch(`${url}/api/log`, {
    method: "POST",
    headers: identityHeaders(target),
    redirect: "error",
    body,
    keepalive: true,
  }).then(async (res) => { if (!res.ok) await accessError(res, url, "log"); }).catch(() => {});
}

export function startBlackBox(bridge: string) {
  if (hostAccess(bridge).status !== "ready") return;
  if (target) { target = bridge.replace(/\/$/, ""); return; }
  target = bridge.replace(/\/$/, "");

  window.addEventListener("error", (e) => {
    post({
      kind: "error",
      message: String(e.message).slice(0, 400),
      source: `${e.filename}:${e.lineno}:${e.colno}`,
      stack: String(e.error?.stack ?? "").slice(0, 900),
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as { message?: string; stack?: string } | undefined;
    post({
      kind: "rejection",
      message: String(reason?.message ?? e.reason).slice(0, 400),
      stack: String(reason?.stack ?? "").slice(0, 900),
    });
  });

  // A renderer kill leaves no error, so record the shape of the session as it
  // goes: what was on screen, and how much memory the tab had taken.
  const vitals = () => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      nodes: document.querySelectorAll("*").length,
      w: window.innerWidth,
      h: window.innerHeight,
    };
  };
  window.addEventListener("pagehide", () => post({ kind: "pagehide", ...vitals() }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) post({ kind: "hidden", ...vitals() });
  });

  // Heartbeat: the last one before a gap is the moment the tab died.
  window.setInterval(() => post({ kind: "beat", ...vitals() }), 5000);

  post({ kind: "start", ...vitals() });
}
