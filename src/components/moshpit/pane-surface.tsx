import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type Style, findCursor, toSpans } from "@/lib/moshpit/ansi";
import { extractLinks } from "@/lib/moshpit/links";
import { parsePaneKey } from "@/lib/moshpit/keys";
import { postAction, terminalTicket } from "@/lib/moshpit/bridge";
import { createKeyQueue } from "@/lib/moshpit/key-queue";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { cn } from "@/lib/utils";
import type { TermSize } from "@/lib/moshpit/types";

/**
 * What one mounted surface shows and types into. It never reads the global
 * selection: the wrapper picks the pane, and mounts a new surface (by key) for
 * a new pane, so rows, caret and socket from the old one cannot carry over.
 */
export type PaneTarget = {
  hostId: string;
  /** The bridge origin, or "" for the demo host, which has no socket. */
  url: string;
  /** The bridge's write target: the agent's or companion shell's pane ID. */
  paneId: string;
  nativeSessionId?: string;
};

export type PaneState = "connecting" | "connected" | "retrying" | "disconnected";
export type PaneStatus = { state: PaneState; attempt: number; error: string | null };

export type PaneHandle = {
  /** Queues a key for this pane; false when there is no bridge to send it to. */
  send: (key: string) => boolean;
  focus: () => void;
  blur: () => void;
};

type PtyFrame = {
  dump?: string;
  lines?: [number, string][];
  size?: { cols: number; rows: number };
};

const LINE_HEIGHT = 1.25;
const SIZE_ORDER: TermSize[] = ["sm", "md", "lg"];
const SIZE_LABEL: Record<TermSize, string> = { sm: "S", md: "M", lg: "L" };
const FONT_SIZE: Record<TermSize, number> = { sm: 12, md: 14, lg: 16 };

function css(style: Style): React.CSSProperties {
  return {
    color: style.fg,
    background: style.bg,
    fontWeight: style.bold ? 600 : undefined,
    opacity: style.dim ? 0.65 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline
      ? "underline"
      : style.strike
        ? "line-through"
        : undefined,
  };
}

/** One rendered row. Memoized on its raw text so a diff repaints only its rows. */
const Row = memo(function Row({ line }: { line: string }) {
  const spans = useMemo(() => toSpans(line), [line]);
  return (
    <div style={{ lineHeight: LINE_HEIGHT }}>
      {spans.length ? (
        spans.map((s, i) => (
          <span key={i} style={css(s.style)}>
            {s.text}
          </span>
        ))
      ) : (
        <span>{" "}</span>
      )}
    </div>
  );
});

function keyFor(e: React.KeyboardEvent): string | null {
  const parsed = parsePaneKey(e);
  if (parsed.kind === "deliver") return parsed.value;
  if (parsed.kind === "unsupported") toast(`${parsed.label} is not sent to the pane`);
  return null;
}

function stepSize(
  update: (s: { termSize: TermSize }) => void,
  current: TermSize,
  dir: 1 | -1,
) {
  const i = SIZE_ORDER.indexOf(current);
  const next = SIZE_ORDER[Math.min(2, Math.max(0, i + dir))];
  if (next === current) {
    toast(`Terminal size is already ${SIZE_LABEL[current]}`);
    return;
  }
  update({ termSize: next });
  toast(`Terminal size ${SIZE_LABEL[next]}`);
}

// herdr's send-text carries bytes verbatim, and a live probe on 2026-09-24
// showed a newline inside it runs the line at a shell prompt, with no paste
// bracketing even when the program asked for it. So only a single line of
// printable text is sent, exactly as if typed; anything else is held for the
// composer, where it is reviewed and submitted on purpose.
const plainLine = (text: string) =>
  [...text].every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && (code < 0x7f || code > 0x9f);
  });

// A ticket or socket error can carry a bridge message; the label shows at most
// a short line of it, never markup or a stack.
const sanitize = (error: unknown) =>
  (error instanceof Error ? error.message : typeof error === "string" ? error : "Connection failed")
    .replace(/\s+/g, " ").slice(0, 120);

export function PaneSurface({ target, label, demoLines, linkKey, handle, fallbackSend, onStatus, onFocusChange, onSwipe, onTransfer, autoFocus }: {
  target: PaneTarget;
  label: string;
  /** The demo host's seeded output, shown instead of a stream. */
  demoLines?: string[];
  /** Where observed URLs are collected; absent for shells, which have no Links view. */
  linkKey?: string | null;
  handle: React.RefObject<PaneHandle | null>;
  /** The demo host's key path, used when there is no bridge queue. */
  fallbackSend: (key: string) => void;
  onStatus: (status: PaneStatus) => void;
  onFocusChange?: (focused: boolean) => void;
  onSwipe: (dir: "left" | "right") => void;
  /** Moves held paste text into this pane's composer draft, unsent. */
  onTransfer: (text: string) => void;
  autoFocus: boolean;
}) {
  const termSize = useMoshpitStore((s) => s.settings.termSize);
  const wrap = useMoshpitStore((s) => s.settings.termWrap);
  const updateSettings = useMoshpitStore((s) => s.updateSettings);
  const addAgentLinks = useMoshpitStore((s) => s.addAgentLinks);
  const ready = useMoshpitStore((s) => s.hostAccess.status === "ready");
  const [rows, setRows] = useState<string[]>([]);
  const [caret, setCaret] = useState<{ row: number; col: number } | null>(null);
  const [live, setLive] = useState(false);
  const [touch, setTouch] = useState<{ x: number; y: number; pinch: number | null } | null>(null);
  // Paste the pane cannot take safely. It belongs to this mount, so a host or
  // pane switch drops it rather than carrying it to another target.
  const [held, setHeld] = useState<string | null>(null);
  const screenRef = useRef<string[]>([]);
  const panEl = useRef<HTMLDivElement | null>(null);
  // WebKit (so Safari and every iOS browser) delivers no paste to a focused,
  // non-editable element, so Ctrl/Cmd+V over the pane did nothing there. The
  // shortcut instead moves focus here for the browser's own paste to land,
  // then hands the text to the same checks and returns focus to the pane.
  const catcher = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<(key: string) => boolean>(() => false);
  // Callbacks change identity every wrapper render; the connection must not.
  const latest = useRef({ onStatus, linkKey, fallbackSend });
  useLayoutEffect(() => {
    latest.current = { onStatus, linkKey, fallbackSend };
  });

  const { url, paneId, hostId } = target;

  useEffect(() => {
    handle.current = {
      send: (key) => {
        if (sendRef.current(key)) return true;
        latest.current.fallbackSend(key);
        return false;
      },
      focus: () => panEl.current?.focus(),
      blur: () => panEl.current?.blur(),
    };
    return () => { handle.current = null; };
  }, [handle]);

  // Land ready to type. Not on a phone: focusing opens the soft keyboard over
  // half the pane before the reader has seen anything. Once per mount, so a
  // rotation or resize neither refocuses nor reconnects.
  const focusOnMount = useRef(autoFocus);
  useEffect(() => {
    if (focusOnMount.current) panEl.current?.focus();
  }, []);

  // Demo host: the pane is the seeded agent log, not a bridge stream.
  useEffect(() => {
    if (url || !demoLines) return;
    screenRef.current = demoLines.slice();
    setRows(screenRef.current.slice());
  }, [url, demoLines]);

  useEffect(() => {
    if (!url) {
      latest.current.onStatus({ state: "connected", attempt: 0, error: null });
      return;
    }
    // Every callback below belongs to this run. `disposed` retires all of
    // them at once; `ws !== socket` retires a socket this run replaced.
    let disposed = false;
    let ws: WebSocket | undefined;
    let retry: number | undefined;
    let failCount = 0;
    let lastError: string | null = null;
    const status = (state: PaneState) => {
      if (disposed) return;
      setLive(state === "connected");
      latest.current.onStatus({ state, attempt: failCount, error: state === "connected" ? null : lastError });
    };

    // Dumps can outrun the display, so commit rows once per frame. A busy
    // device coalesces more, which is the behaviour we want.
    let frame: number | undefined;
    let fallback: number | undefined;
    function commit() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) window.clearTimeout(fallback);
      frame = undefined;
      fallback = undefined;
      if (disposed || hasSelection()) return;
      setRows(screenRef.current.slice());
      setCaret(findCursor(screenRef.current));
    }
    // rAF alone loses the pane: a background or throttled tab never runs the
    // callback, and the pending handle then blocks every later paint, so the
    // terminal stays blank even after it comes back. The timer is the floor.
    function paint() {
      if (frame !== undefined || fallback !== undefined) return;
      frame = requestAnimationFrame(commit);
      fallback = window.setTimeout(commit, 250);
    }

    // The socket only shows the pane; keys go over HTTP in press order.
    // Raw keys have no receipt: going offline or hidden drops the ones not
    // yet sent, and they are never replayed on return.
    const makeQueue = () => createKeyQueue(
      async (keys) => {
        await postAction(url, { kind: "keys", target: paneId, keys });
      },
      (error) => toast("Keys not sent", { description: error instanceof Error ? error.message : String(error) }),
    );
    let keyQueue = makeQueue();
    const dropKeys = () => {
      const dropped = keyQueue.close();
      keyQueue = makeQueue();
      if (dropped) toast("Keys not sent", { description: `${dropped} unsent ${dropped === 1 ? "key was" : "keys were"} dropped when the connection went away.` });
    };
    sendRef.current = (keys: string) => {
      if (disposed) return false;
      keyQueue.push(keys);
      return true;
    };

    // Links are attributed to the host this run belongs to, and only while it
    // is still the connected one.
    const collect = (text: string) => {
      const key = latest.current.linkKey;
      if (key && useMoshpitStore.getState().connectedHostId === hostId) addAgentLinks(key, extractLinks(text));
    };

    const scheduleRetry = () => {
      window.clearTimeout(retry);
      if (disposed || document.hidden || !navigator.onLine) return;
      status("retrying");
      // Back off: a dead bridge must not cost a handshake every 100ms.
      retry = window.setTimeout(connect, Math.min(100 * 2 ** failCount, 5000));
    };

    let opening = false;
    async function connect() {
      if (disposed || opening) return;
      if (useMoshpitStore.getState().hostAccess.status !== "ready" || !navigator.onLine) {
        status("disconnected");
        return;
      }
      opening = true;
      if (!ws || ws.readyState > WebSocket.OPEN) status(failCount ? "retrying" : "connecting");
      let ticket: string;
      try { ({ ticket } = await terminalTicket(url, paneId)); }
      catch (error) {
        // No socket was opened, so onclose will never fire and nothing else
        // re-drives this. Without a retry here a transient 5xx or a 429 device
        // cap leaves the pane blank until the app is backgrounded and woken.
        opening = false;
        if (disposed) return;
        failCount++;
        lastError = sanitize(error);
        scheduleRetry();
        return;
      }
      opening = false;
      if (disposed || document.hidden || useMoshpitStore.getState().hostAccess.status !== "ready") return;
      ws?.close();
      const socket = new WebSocket(`${url.replace(/^http/, "ws")}/pty?ticket=${encodeURIComponent(ticket)}`);
      ws = socket;
      socket.onmessage = (e) => {
        // A late frame from a socket this run replaced is not this pane's.
        if (disposed || ws !== socket) return;
        try {
          const msg = JSON.parse(String(e.data)) as PtyFrame;
          if (msg.size) screenRef.current = [];
          if (typeof msg.dump === "string") {
            screenRef.current = msg.dump.split(/\r?\n/);
            paint();
            // Observed-output collection, before render: repeated full dumps
            // dedupe in the store; the snapshot lines never reach here.
            collect(msg.dump);
          } else if (msg.lines) {
            for (const [row, text] of msg.lines) screenRef.current[row] = text;
            paint();
            collect(msg.lines.map(([, text]) => text).join("\n"));
          }
        } catch {
          /* not a pane frame */
        }
      };
      socket.onopen = () => {
        if (disposed || ws !== socket) return;
        failCount = 0;
        lastError = null;
        status("connected");
      };
      socket.onerror = () => {
        if (ws !== socket) return;
        failCount++;
        lastError = "The pane socket closed with an error";
        socket.close();
      };
      socket.onclose = () => {
        // A replaced socket's close event must not steer the replacement:
        // a blur can close the old socket while a fresh one is already up.
        if (disposed || ws !== socket) return;
        if (document.hidden || !navigator.onLine) status("disconnected");
        else scheduleRetry();
      };
    }

    function hasSelection() {
      const selection = window.getSelection();
      return Boolean(selection && !selection.isCollapsed && panEl.current &&
        (panEl.current.contains(selection.anchorNode) || panEl.current.contains(selection.focusNode)));
    }
    function onSelectionChange() {
      if (!hasSelection()) paint();
    }

    // A backgrounded phone was still parsing and painting every frame. Drop the
    // stream while hidden; the next dump on wake is a full repaint anyway.
    function onVisibility() {
      if (disposed) return;
      if (document.hidden) {
        window.clearTimeout(retry);
        dropKeys();
        ws?.close();
        status("disconnected");
      } else if (!ws || ws.readyState > WebSocket.OPEN) {
        void connect();
      }
    }
    function onOffline() {
      window.clearTimeout(retry);
      dropKeys();
      ws?.close();
      status("disconnected");
    }
    function onOnline() {
      if (!ws || ws.readyState > WebSocket.OPEN) void connect();
    }
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    if (ready) void connect();
    else status("disconnected");

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) window.clearTimeout(fallback);
      window.clearTimeout(retry);
      ws?.close();
      keyQueue.close();
      sendRef.current = () => false;
    };
  }, [url, paneId, hostId, ready, addAgentLinks]);

  // Follow the bottom, where the prompt is, unless the reader scrolled up. A
  // full-height pane dump on a phone otherwise opened on its top rows with
  // the prompt out of sight. A new pane is a new mount, so it starts following.
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = panEl.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [rows, termSize, wrap]);

  // The demo host has no socket; its pane is always current.
  const paneLive = live || !url;

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      setTouch({ x: 0, y: 0, pinch: Math.hypot(dx, dy) });
    } else if (e.touches.length === 1) {
      setTouch({ x: e.touches[0].clientX, y: e.touches[0].clientY, pinch: null });
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && touch?.pinch != null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const d = Math.hypot(dx, dy);
      const delta = d - touch.pinch;
      if (Math.abs(delta) > 32) {
        stepSize(updateSettings, termSize, delta > 0 ? 1 : -1);
        setTouch({ x: 0, y: 0, pinch: d });
      }
      return;
    }
    if (e.touches.length === 1 && touch) {
      // A pane wider than the viewport pans instead — the browser owns that drag.
      const el = panEl.current;
      if (el && el.scrollWidth > el.clientWidth) return;
      const dx = e.touches[0].clientX - touch.x;
      const dy = e.touches[0].clientY - touch.y;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        onSwipe(dx < 0 ? "left" : "right");
        setTouch({ ...touch, x: e.touches[0].clientX });
      }
    }
  }

  function takePaste(data: DataTransfer) {
    const text = data.getData("text/plain");
    if (!text) {
      if (data.files.length) toast("Images go through the composer", { description: "Attach or paste them in the box below." });
      return;
    }
    if (plainLine(text)) {
      // Once, in order, and with no Enter: the same path as typing it.
      for (const ch of text) handle.current?.send(ch);
      return;
    }
    setHeld(text);
  }
  const pasteRef = useRef(takePaste);
  useLayoutEffect(() => {
    pasteRef.current = takePaste;
  });
  // Firefox dispatches a paste on a focused, non-editable element to <body>,
  // not to the element, so the pane's own onPaste never saw it and a paste
  // there did nothing. Take it at the document while the pane holds focus;
  // Chromium's paste lands on the pane itself and is handled there.
  useEffect(() => {
    function onDocumentPaste(e: ClipboardEvent) {
      const el = panEl.current;
      // Already taken by the pane or the catcher (which refocuses the pane
      // while this event is still bubbling up to here).
      if (e.defaultPrevented) return;
      if (!el || !e.clipboardData || document.activeElement !== el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      e.preventDefault();
      pasteRef.current(e.clipboardData);
    }
    document.addEventListener("paste", onDocumentPaste);
    return () => document.removeEventListener("paste", onDocumentPaste);
  }, []);

  const heldLines = held ? held.split(/\r\n|\r|\n/).length : 0;

  return (
    <>
    <textarea
      ref={catcher}
      aria-hidden
      tabIndex={-1}
      readOnly={false}
      // Off-screen and outside the scroll box: an input inside the pane's
      // max-content child deadlocks layout against scroll-into-view.
      style={{ position: "fixed", left: -9999, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      onPaste={(e) => {
        e.preventDefault();
        takePaste(e.clipboardData);
        panEl.current?.focus();
      }}
    />
    {held !== null ? (
      <div role="alert" className="shrink-0 border-b border-border bg-surface px-4 py-2 text-xs">
        <p className="text-fg">
          {heldLines > 1
            ? `Pasted ${heldLines} lines. Sent here, the terminal would run each line as you pasted it, so nothing was sent.`
            : "The paste holds control characters that the terminal would act on, so nothing was sent."}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => { onTransfer(held); setHeld(null); }}
            className="h-9 rounded-sm bg-surface-2 px-3 font-medium shadow-border"
          >
            Move to composer
          </button>
          <button
            type="button"
            onClick={() => { setHeld(null); panEl.current?.focus(); }}
            className="h-9 rounded-sm px-3 text-muted shadow-border"
          >
            Discard
          </button>
        </div>
      </div>
    ) : null}
    <div
      ref={panEl}
      // Focus lives on the scroll box, not an overlay: an absolutely sized
      // input inside a max-content child deadlocks layout against
      // scroll-into-view.
      tabIndex={0}
      role="application"
      aria-label={label}
      className="terminal-pane min-h-0 min-w-0 flex-1 overflow-auto outline-none"
      onPaste={(e) => {
        e.preventDefault();
        takePaste(e.clipboardData);
      }}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v" && catcher.current) {
          // Not prevented: the default action is the paste, now into the catcher.
          catcher.current.value = "";
          catcher.current.focus();
          // A paste the browser refuses (no permission, empty clipboard) never
          // fires, so focus must not be left stranded in the catcher.
          window.setTimeout(() => {
            if (document.activeElement === catcher.current) panEl.current?.focus();
          }, 300);
          return;
        }
        const k = keyFor(e);
        if (!k) return;
        e.preventDefault();
        handle.current?.send(k);
      }}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Within a row of the bottom still counts as following.
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => setTouch(null)}
      onWheel={(e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          stepSize(updateSettings, termSize, e.deltaY < 0 ? 1 : -1);
        }
      }}
    >
      <div
        className={cn(
          "relative bg-bg-term text-term",
          wrap ? "w-full" : "w-max min-w-full",
          // Stale output should not pass for current output.
          !paneLive && "opacity-60",
        )}
        onClick={() => panEl.current?.focus()}
      >
        <pre
          className="relative m-0 font-mono"
          style={{
            fontSize: FONT_SIZE[termSize],
            whiteSpace: wrap ? "pre-wrap" : "pre",
            overflowWrap: wrap ? "anywhere" : undefined,
          }}
        >
          {rows.map((line, i) => (
            <Row key={i} line={line} />
          ))}
          {/* Inside the <pre>: ch and em only land on the character grid
                when they resolve against the same monospace font. */}
          {/* Wrapped rows no longer sit on the pane's grid, so the
                caret's row and column would land in the wrong place. */}
          {caret && !wrap ? (
            <span
              aria-hidden
              className="pointer-events-none absolute bg-term/70"
              style={{
                left: `${caret.col - 1}ch`,
                top: `${(caret.row - 1) * LINE_HEIGHT}em`,
                width: "1ch",
                height: `${LINE_HEIGHT}em`,
              }}
            />
          ) : null}
        </pre>
      </div>
    </div>
    </>
  );
}
