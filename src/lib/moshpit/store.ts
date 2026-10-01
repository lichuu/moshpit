import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { toast } from "sonner";
import { CURRENT_RELEASE } from "@/lib/moshpit/releases";
import { inboxUnread, makeEvent, newId } from "./events";
import { encodeImage, fetchSnapshot, fetchRequesterLogin, inspectPushSupport, consumePairing, discoverAccess, checkDeviceCredential, postAction, postLogin, postLogout, registerPush, type KeyInput, type Snapshot, connectRefusal, diagnoseBridge, unregisterPush } from "./bridge";
import { mergeLinks, pruneStaleLinks, splitLinkKey } from "./links";
import { credentials, hostAccess, watchAccess, setHostAccess } from "./access";
import { breadcrumb, startBlackBox } from "./blackbox";
import { hostOrigin } from "./host-code";
import { browserDeviceName, takeSetupCapability } from "./setup-link";
import { setupLinkFailure } from "./setup-link-failure";
import { formatImageLine } from "./image";
import { SNIPPET_LIMITS, sanitizeSnippets, validateSnippet } from "./snippets";
import {
  DEMO_HOST,
  SAMPLE_HOSTS,
  WORKING_LINES,
  demoEnabled,
  seedAgents,
} from "./seed";
import type {
  Agent,
  AgentView,
  AnswerCallback,
  DemoQuestion,
  AgentEvent,
  AgentStatus,
  ConnectError,
  EventResolution,
  FailureKind,
  FilterId,
  Snippet,
  Attachment,
  Host,
  HostAccess,
  PushSetup,
  Settings,
  Shell,
  TabId,
  Transport,
} from "./types";

// Settings are shared across tabs, and a tab only refreshes its in-memory
// copy on rehydrate. Any state change in a stale tab would otherwise
// restamp its stale settings over what a newer tab wrote (theme clobbered).
// Only the tab that changed settings may write them; every other write
// adopts the settings currently on disk.
let settingsDirty = false;
// Monotonic: deriving a demo shell id from the list length reused the id of
// a still-open shell once an earlier one was closed.
let demoShellSeq = 0;

const parseBlob = (raw: string | null) => {
  try {
    return raw ? (JSON.parse(raw) as { state?: { settings?: Settings } }) : null;
  } catch {
    return null;
  }
};

const settingsGuardedStorage = (ls: Storage) => {
  // The protocol-1 cleanup runs once, on the first read, not on every read.
  let cleaned = false;
  const cleanLegacy = (name: string): string | null => {
    ls.removeItem("moshpit-device-id");
    ls.removeItem("bridgeDeviceId");
    ls.removeItem("bridgeTokens");
    const raw = ls.getItem(name);
    if (!raw) return raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.state) {
        delete parsed.state.bridgeDeviceId;
        delete parsed.state.bridgeTokens;
        const clean = JSON.stringify(parsed);
        ls.setItem(name, clean);
        return clean;
      }
    } catch { /* Persist handles invalid storage. */ }
    return raw;
  };
  // persist saves after every set(), including the runtime tick's no-ops, so
  // an idle tab would restamp its stale hosts over another tab's every 1.8 s.
  let lastWritten: string | null = null;
  return {
    getItem: (name: string) =>
      cleaned ? ls.getItem(name) : ((cleaned = true), cleanLegacy(name)),
    setItem: (name: string, value: string) => {
    if (value === lastWritten) return;
    lastWritten = value;
    let out = value;
    if (!settingsDirty) {
      const existing = parseBlob(ls.getItem(name));
      if (existing?.state?.settings) {
        const parsed = JSON.parse(value) as { state: Record<string, unknown> };
        out = JSON.stringify({
          ...parsed,
          state: { ...parsed.state, settings: existing.state.settings },
        });
      }
    }
    ls.setItem(name, out);
    // The write this flag authorized has landed; later writes adopt from disk.
    settingsDirty = false;
  },
  removeItem: (name: string) => ls.removeItem(name),
  };
};

const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

type NewHost = {
  label: string;
  transport: Transport;
  user: string;
  hostname: string;
  port: number;
  tailnetUrl?: string;
  moshOverTailscale?: boolean;
  udpPort?: string;
  keyName?: string;
  keyFingerprint?: string;
};

type BlockedInsertion = {
  sessionId: string | null;
  dialog: string;
};

type MoshpitState = {
  hydrated: boolean;
  onboarded: boolean;
  lastSeenRelease: string | null;
  tab: TabId;
  filter: FilterId;
  collapsedProjects: string[];
  toggleProject: (id: string) => void;
  hosts: Host[];
  connectedHostId: string | null;
  /**
   * The host whose snapshot this session last applied. Not persisted, so a
   * connectedHostId restored at load does not count until a snapshot lands.
   */
  snapshotHostId: string | null;
  connecting: boolean;
  connectError: ConnectError | null;
  herdrRunning: boolean;
  demoFailure: FailureKind | null;
  agents: Agent[];
  availableKinds: string[];
  events: AgentEvent[];
  blockedInsertions: Record<string, BlockedInsertion>;
  recordBlockedInsertion: (agent: Agent) => void;
  selectedAgentId: string | null;
  selectedShellId: string | null;
  shells: Shell[];
  focusedPaneId: string | null;
  jumpOpen: boolean;
  /** The agent drilled into. Phone-only: wide layouts show it beside the list. */
  detailAgentId: string | null;
  detailView: AgentView;
  closeDetail: () => void;
  setDetailView: (view: AgentView) => void;
  /** In-memory terminal links observed per host+agent+session; never persisted. */
  agentLinks: Record<string, string[]>;
  addAgentLinks: (key: string, urls: string[]) => void;
  hostAccess: HostAccess;
  accessHostId: string | null;
  /** Resolves false when the grant was refused; `failure` turns the refusal into the message shown, in place of the bridge's. */
  pair: (id: string, secret: string, name?: string, failure?: (error: unknown) => ConnectError) => Promise<boolean>;
  /** Approves this browser with a setup link's grant, on the origin that served the app, and opens its herd. */
  openSetupLink: (secret: string) => void;
  /**
   * The setup link's confirmation step, before anything is redeemed. It is
   * never persisted: the secret lives only in memory, so a reload has nothing
   * to confirm and lands on the normal screen.
   */
  setupConfirm: SetupConfirm | null;
  approveSetupLink: () => void;
  cancelSetupLink: () => void;
  pairingOrigins: string[];
  needsPassword: boolean;
  needsPasswordHostId: string | null;
  settings: Settings;
  pushSetup: PushSetup;
  enablePush: () => Promise<void>;
  disablePush: () => Promise<void>;
  snippets: Snippet[];
  saveSnippet: (input: { id?: string; name: string; text: string }) => boolean;
  deleteSnippet: (id: string) => void;
  tick: () => void;
  completeOnboarding: () => void;
  markCurrentReleaseSeen: () => void;
  setTab: (tab: TabId) => void;
  setFilter: (filter: FilterId) => void;
  setJumpOpen: (open: boolean) => void;
  selectAgent: (id: string) => void;
  selectShell: (id: string) => void;
  openShell: (cwd: string) => Promise<boolean>;
  /**
   * `explicit` is a Connect the user pressed; `silent` is startup or an
   * automatic reconnect. Only an explicit attempt announces its success.
   */
  connectHost: (id: string, intent: ConnectIntent, retry?: number) => void;
  login: (id: string, password: string) => void;
  disconnect: () => void;
  startHerdr: () => void;
  stopHerdr: () => void;
  setDemoFailure: (kind: FailureKind | null) => void;
  setHostPing: (id: string, ms: number) => void;
  addHost: (host: NewHost) => string;
  removeHost: (id: string) => void;
  prompt: (agentId: string, text: string, attachment?: Attachment) => Promise<boolean>;
  createAgent: (projectPath: string, kind: string, model?: string, checkout?: { baseRef: string; branch: string }) => Promise<CreateAgentResult>;
  sendKeys: (agentId: string, keys: KeyInput, onOutcome?: AnswerCallback) => void;
  renameAgent: (target: string, name: string) => Promise<boolean>;
  closeAgent: (target: string) => Promise<boolean>;
  answerAgent: (target: string, keys: KeyInput | KeyInput[], onOutcome?: AnswerCallback) => void;
  answerDialog: (target: string, token: string, optionKey: string, onOutcome?: AnswerCallback) => void;
  simulateBlocked: () => void;
  resetDemo: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setHydrated: () => void;
};

function append(
  agent: Agent,
  text: string,
  tone: Agent["lines"][number]["tone"] = "plain",
): Agent {
  const lines = [...agent.lines, { text, tone }];
  return {
    ...agent,
    lines: lines.slice(-120),
    lastOutput: text.trim() ? text : agent.lastOutput,
  };
}

function setStatus(agent: Agent, status: AgentStatus): Agent {
  if (agent.status === status) return agent;
  return {
    ...agent,
    status,
    statusChangedAt: Date.now(),
    attention: status === "blocked",
    ticks: 0,
  };
}

const EVENT_CAP = 200;
function capEvents(e: AgentEvent[]) {
  return e.length > EVENT_CAP ? e.slice(e.length - EVENT_CAP) : e;
}

/** A worktree launch that created the worktree but failed to start the agent in it. */
export type WorktreePartial = { path: string; branch: string };

/** Discriminated start result: success, or failure (optionally with a retained worktree partial). */
export type CreateAgentResult =
  | { state: "started" }
  | { state: "failed"; message?: string; partial?: WorktreePartial };

// Client-boundary validation of the bridge's 422 partial payload; a malformed
// body — including a missing or wrong state discriminator — falls back to the
// plain error message rather than presenting a half-validated partial.
function errorText(value: unknown, fallback: string): string {
  return value && typeof value === "object" && "error" in value && typeof (value.error as { message?: unknown })?.message === "string"
    ? (value.error as { message: string }).message
    : fallback;
}

function partialFromPayload(value: unknown): WorktreePartial | null {
  const p = value && typeof value === "object" ? (value as { partial?: unknown }).partial : null;
  if (!p || typeof p !== "object") return null;
  const q = p as { state?: unknown; path?: unknown; branch?: unknown };
  if (q.state !== "created-agent-failed") return null;
  if (typeof q.path !== "string" || !q.path || typeof q.branch !== "string" || !q.branch) return null;
  return { path: q.path, branch: q.branch };
}

function liveHost(s: { hosts: Host[]; connectedHostId: string | null }) {
  return s.hosts.find((h) => h.id === s.connectedHostId) ?? null;
}

function blockedInsertionFor(agent: Agent): BlockedInsertion {
  const dialog = agent.blockedDialog;
  return {
    sessionId:
      agent.sessionId ??
      (dialog?.kind === "choose" ? dialog.sessionId : undefined) ??
      null,
    dialog:
      dialog?.kind === "choose"
        ? `choose:${dialog.expected.token}`
        : dialog?.kind === "terminal"
          ? `terminal:${JSON.stringify([dialog.question, dialog.options])}`
          : `prompt:${agent.blockedPrompt ?? agent.lastOutput}`,
  };
}

function matchesBlockedInsertion(
  insertion: BlockedInsertion,
  agent: Agent,
): boolean {
  if (agent.status !== "blocked") return false;
  const current = blockedInsertionFor(agent);
  return (
    insertion.sessionId === current.sessionId &&
    insertion.dialog === current.dialog
  );
}

function applySnapshot(
  s: MoshpitState,
  snap: Pick<Snapshot, "agents"> & { kinds?: string[]; shells?: Shell[] },
  extra: Partial<MoshpitState> = {},
): Partial<MoshpitState> {
  const agents = snap.agents;
  const shells = Array.isArray(snap.shells) ? snap.shells : s.shells;
  const selected = agents.find((a) => a.id === s.selectedAgentId) ?? agents[0];
  const stillBlocked = new Set(
    agents.filter((a) => a.status === "blocked").map((a) => a.id),
  );
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const known = new Set(agents.map((a) => a.id));
  // Retire link lists for agents or sessions the snapshot no longer has. The
  // connect path carries the new host id, so a host switch prunes the old
  // host's lists in the same write.
  const agentLinks = pruneStaleLinks(
    s.agentLinks,
    extra.connectedHostId ?? s.connectedHostId,
    agents,
  );
  const blockedInsertions = Object.fromEntries(
    Object.entries(s.blockedInsertions).filter(([id, insertion]) => {
      const agent = agentsById.get(id);
      return agent ? matchesBlockedInsertion(insertion, agent) : false;
    }),
  );
  // An agent already blocked when the app opened never transitions, so a
  // transition-only rule leaves the Inbox empty in exactly the case you opened
  // the app for. Ensure every blocked agent has an open row.
  const openBlocked = new Set(
    s.events
      .filter((e) => e.kind === "blocked" && !e.resolved)
      .map((e) => e.agentId),
  );
  const missing = agents
    .filter((a) => a.status === "blocked" && !openBlocked.has(a.id))
    .map((a) => makeEvent(a.id, "blocked", a.blockedPrompt || a.lastOutput));
  return {
    agents,
    shells,
    // A shell closed on the host must not keep steering the detail view at a
    // dead pane: drop the selection and let the user re-open (recreate).
    // Membership is not enough: the bridge deliberately keeps closed shells in
    // the list with alive:false so the phone can offer a recreate, so a guard
    // that only checked ids never fired for the case it was written for — the
    // pane exiting on the host — and the terminal kept reconnecting to it.
    selectedShellId:
      s.selectedShellId &&
      shells.some((shell) => shell.id === s.selectedShellId && shell.alive !== false)
        ? s.selectedShellId
        : null,
    availableKinds: Array.isArray(snap.kinds) ? snap.kinds : s.availableKinds,
    selectedAgentId: selected?.id ?? null,
    focusedPaneId: selected?.paneId ?? s.focusedPaneId,
    herdrRunning: true,
    snapshotHostId: extra.connectedHostId ?? s.connectedHostId,
    // Events survive a reload, so drop any whose pane is gone: a reseeded demo
    // would otherwise show rows pointing at agents that no longer exist.
    blockedInsertions,
    events: capEvents([
      ...s.events
        .filter((event) => known.has(event.agentId))
        .map((event) =>
          event.kind === "blocked" &&
          !event.resolved &&
          !stillBlocked.has(event.agentId)
            ? { ...event, resolved: "answered" as const }
            : event,
        ),
      ...missing,
    ]),
    agentLinks,
    ...extra,
  };
}

function closeLocal(s: MoshpitState, target: string): Partial<MoshpitState> {
  const at = s.agents.findIndex((a) => a.id === target);
  const shellClosed = s.shells.some((shell) => shell.id === target);
  if (at < 0 && !shellClosed) return {};
  const closed = s.agents[at];
  const remaining = s.agents.filter((a) => a.id !== target);
  // Land on the neighbour the closed pane sat next to, not the top of the
  // list: closing the last of five should not scroll you back to the first.
  const next = remaining[Math.min(at, remaining.length - 1)];
  // A closed agent's lists are keyed by session, so drop every session's.
  const agentLinks = Object.fromEntries(
    Object.entries(s.agentLinks).filter(
      ([key]) => splitLinkKey(key)?.agentId !== target,
    ),
  );
  return {
    agents: remaining,
    agentLinks,
    shells: s.shells.filter((shell) => shell.id !== target),
    selectedShellId: s.selectedShellId === target ? null : s.selectedShellId,
    events: s.events.filter((event) => event.agentId !== target),
    blockedInsertions: Object.fromEntries(
      Object.entries(s.blockedInsertions).filter(([id]) => id !== target),
    ),
    selectedAgentId: s.selectedAgentId === target ? (next?.id ?? null) : s.selectedAgentId,
    // A shell is not in s.agents, so `closed` is undefined for one and the
    // paneId comparison alone never fired: selectShell focuses the shell's own
    // id, which was then left pointing at a pane that no longer exists.
    focusedPaneId:
      s.focusedPaneId === closed?.paneId || s.focusedPaneId === target
        ? (next?.paneId ?? null)
        : s.focusedPaneId,
    detailAgentId: s.detailAgentId === target ? null : s.detailAgentId,
  };
}

function yes(text: string) {
  return /^(y|yes|yeah|yep|ok|okay|do it|run it|go)\b/i.test(text.trim());
}
function no(text: string) {
  return /^(n|no|nope|skip|cancel)\b/i.test(text.trim());
}

type DemoChooseDialog = Extract<NonNullable<Agent["blockedDialog"]>, { kind: "choose" }>;

function demoDialog(agent: Agent, questions: DemoQuestion[], index: number): DemoChooseDialog | undefined {
  const question = questions[index];
  if (!question) return undefined;
  return {
    kind: "choose",
    family: "codex-request-user-input-v1",
    sessionId: `demo:${agent.id}`,
    expected: {
      token: `demo-${agent.id}-token-${index}`,
      signature: `demo-${agent.id}-signature-${index}`,
      revision: null,
    },
    question: question.text,
    step: { index, total: questions.length },
    options: question.options.map((option, optionIndex) => ({
      key: String(optionIndex + 1),
      label: option.label,
      description: option.description,
    })),
  };
}

function pendingDemoText(agent: Agent): string {
  return [...agent.lines].reverse().find((line) => line.tone === "in" && line.text.startsWith("> "))?.text.slice(2) ?? "";
}

function commitDemoText(agent: Agent, text: string): Agent {
  let next = agent;
  if (agent.id === "migrate") {
    if (yes(text)) {
      next = append(next, "running prisma migrate deploy", "ok");
      return {
        ...setStatus(next, "working"),
        blockedPrompt: null,
        workTicks: 4,
        nextStatus: "done",
      };
    }
    if (no(text)) {
      next = append(next, "skipping migrate", "dim");
      return { ...setStatus(next, "idle"), blockedPrompt: null, nextStatus: null };
    }
  }
  if (agent.id === "accent") {
    const green = /green|accent|herdr/i.test(text);
    const mauve = /mauve|purple|catppuccin/i.test(text);
    if (green || mauve) {
      const pick = green ? "green" : "mauve";
      next = append(next, `locking accent to ${pick}`, "ok");
      return {
        ...setStatus(next, "working"),
        blockedPrompt: null,
        workTicks: 3,
        nextStatus: "done",
      };
    }
  }
  next = append(next, "noted — picking the work back up", "ok");
  return {
    ...setStatus(next, "working"),
    blockedPrompt: null,
    workTicks: 4,
    nextStatus: "done",
  };
}

function resolveBlocked(
  events: AgentEvent[],
  agentId: string,
  resolution: EventResolution,
): AgentEvent[] {
  return events.map((event) =>
    event.agentId === agentId && event.kind === "blocked" && !event.resolved
      ? { ...event, resolved: resolution }
      : event,
  );
}

function seedEvents(agents: Agent[]): AgentEvent[] {
  return agents
    .filter((agent) => agent.status === "blocked")
    .map((agent) => makeEvent(agent.id, "blocked", agent.blockedPrompt || agent.lastOutput));
}

function notifyBlocked(agent: Agent, enabled: boolean) {
  toast(`${agent.name} is blocked`, {
    description: agent.lastOutput,
  });
  if (!enabled || typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    try {
      new Notification(`${agent.name} is blocked`, {
        body: agent.lastOutput,
      });
    } catch {
      /* ignore */
    }
  }
}

const pairingRequests = new Map<string, Promise<boolean>>();

// Refusals of stored device credentials after which a setup link may enroll anew.
const REENROLL_CODES = new Set(["device_revoked", "device_expired", "device_required"]);

/** `login` is undefined while the bridge is asked, then the caller's own login or null. */
export type SetupConfirm = { hostId: string; machine: string; login?: string | null };
// The capability waiting for Approve. Module memory only, like setup-link.ts:
// never in store state, which persists, and gone on reload.
let pendingSetupSecret: string | null = null;

// One connection attempt at a time. Every asynchronous step of connectHost
// checks it is still the current attempt, so switching, disconnecting or
// removing a host cannot be overwritten by an older attempt's late result.
// Only network and temporary failures retry, on this schedule, before the
// user is offered Retry; auth, pairing and policy refusals never do.
export const CONNECT_RETRY_MS = [1000, 2000, 4000, 8000];

// This app speaks bridge protocol 2 (discoverAccess). A mismatch is a version
// problem with its own fix, not a sign-in one.
function incompatibleError(bridgeProtocol: number): ConnectError {
  return bridgeProtocol > 2
    ? {
        title: "This app is out of date",
        detail: `The bridge speaks protocol ${bridgeProtocol}; this app speaks 2. Reload to fetch the app the bridge serves. Your drafts are kept.`,
        incompatible: "app",
      }
    : {
        title: "This bridge is out of date",
        detail: `The bridge speaks protocol ${bridgeProtocol}; this app needs 2. Update moshpit on the host and restart its bridge, then check again.`,
        incompatible: "bridge",
      };
}
export type ConnectIntent = "explicit" | "silent";
let connectAttempt = 0;
// The intent of the latest attempt. Login and pairing continue that attempt's
// host, so they carry its intent rather than inventing one.
let connectIntent: ConnectIntent = "silent";
let connectRetry: ReturnType<typeof setTimeout> | undefined;
function abortConnect() {
  connectAttempt += 1;
  clearTimeout(connectRetry);
  return connectAttempt;
}

export const useMoshpitStore = create<MoshpitState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      onboarded: false,
      lastSeenRelease: null,
      tab: "moshpit",
      filter: "all",
      collapsedProjects: [],
      toggleProject: (id) => set((state) => ({
        collapsedProjects: state.collapsedProjects.includes(id)
          ? state.collapsedProjects.filter((project) => project !== id)
          : [...state.collapsedProjects, id],
      })),
      hosts: demoEnabled() ? SAMPLE_HOSTS : [],
      connectedHostId: demoEnabled() ? "demo" : null,
      snapshotHostId: null,
      connecting: false,
      connectError: null,
      herdrRunning: demoEnabled(),
      demoFailure: null,
      agents: demoEnabled() ? seedAgents() : [],
      availableKinds: demoEnabled() ? ["codex", "claude", "opencode", "pi"] : [],
      events: demoEnabled() ? seedEvents(seedAgents()) : [],
      blockedInsertions: {},
      recordBlockedInsertion: (source) =>
        set((state) => {
          const current = state.agents.find(
            (candidate) => candidate.id === source.id,
          );
          const insertion = blockedInsertionFor(source);
          if (!current || !matchesBlockedInsertion(insertion, current)) return {};
          return {
            blockedInsertions: {
              ...state.blockedInsertions,
              [source.id]: insertion,
            },
          };
        }),
      selectedAgentId: "migrate",
      selectedShellId: null,
      shells: [],
      focusedPaneId: "w1:p2",
      jumpOpen: false,
      detailAgentId: null,
      detailView: "chat",
      agentLinks: {},
      addAgentLinks: (key, urls) => {
        if (!urls.length) return;
        set((s) => {
          const prev = s.agentLinks[key] ?? [];
          const next = mergeLinks(prev, urls);
          if (next === prev) return {};
          return { agentLinks: { ...s.agentLinks, [key]: next } };
        });
      },
      hostAccess: { status: "disconnected" },
      accessHostId: null,
      pairingOrigins: [],
      needsPassword: false,
      needsPasswordHostId: null,
      settings: {
        termSize: "md",
        termWrap: false,
        prefix: "ctrl+b",
        voice: true,
        notify: false,
        theme: "moshpit-dark",
        // Off, or a light device would resolve the dark default to its light
        // sibling and the app would not open dark for anyone but dark-mode
        // devices. "Match device appearance" in Settings turns it back on.
        autoSwitch: false,
      },
      pushSetup: { status: "off" },
      snippets: [],

      setHydrated: () => {

        set({ hydrated: true });
        const setupSecret = takeSetupCapability();
        if (setupSecret) {
          get().openSetupLink(setupSecret);
          return;
        }
        const s = get();
        const connected = s.hosts.find((h) => h.id === s.connectedHostId);
        // A remembered bridge reconnects here, and connectHost registers push
        // once it lands, so this path is done.
        if (connected?.tailnetUrl) { get().connectHost(connected.id, "silent"); return; }
        // Anything left has no bridge URL, so there is nothing to subscribe to:
        // all push can say is whether the browser itself could carry it.
        if (!s.settings.notify) return;
        if (inspectPushSupport().status === "ready") set({ pushSetup: { status: "local" } });
      },
      completeOnboarding: () => set({
        onboarded: true,
        lastSeenRelease: CURRENT_RELEASE.id,
      }),
      markCurrentReleaseSeen: () => set({ lastSeenRelease: CURRENT_RELEASE.id }),
      setTab: (tab) => {
        breadcrumb(`tab ${tab}`);
        set({ tab, detailAgentId: null, selectedShellId: null });
      },
      setFilter: (filter) => set({ filter }),
      setJumpOpen: (jumpOpen) => set({ jumpOpen }),

      closeDetail: () => set({ detailAgentId: null, selectedShellId: null }),
      setDetailView: (detailView) => set({ detailView }),
      updateSettings: (patch) => {
        settingsDirty = true;
        set((s) => ({ settings: { ...s.settings, ...patch } }));
      },
      enablePush: async () => {
        const support = inspectPushSupport();
        if (support.status === "unavailable") {
          set({ pushSetup: support });
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          settingsDirty = true;
          set((s) => ({
            settings: { ...s.settings, notify: false },
            pushSetup: { status: "denied" },
          }));
          return;
        }
        settingsDirty = true;
        set((s) => ({
          settings: { ...s.settings, notify: true },
          pushSetup: { status: "pending" },
        }));
        const host = get().hosts.find((h) => h.id === get().connectedHostId);
        const url = host?.tailnetUrl?.replace(/\/$/, "");
        if (!url) {
          set({ pushSetup: { status: "local" } });
          return;
        }
        const setup = await registerPush(url);
        if (!get().settings.notify) return;
        set({ pushSetup: setup });
      },
      disablePush: async () => {
        settingsDirty = true;
        set((s) => ({
          settings: { ...s.settings, notify: false },
          pushSetup: { status: "off" },
        }));
        const host = get().hosts.find((h) => h.id === get().connectedHostId);
        const url = host?.tailnetUrl?.replace(/\/$/, "");
        if (url) await unregisterPush(url).catch(() => undefined);
      },
      // Upsert: an existing id edits in place, anything else appends. The
      // composer pre-validates for inline errors; this guard covers every
      // other caller and the persisted list cap.
      saveSnippet: ({ id, name, text }) => {
        const error = validateSnippet(name, text);
        if (error) {
          toast("Snippet not saved", { description: error });
          return false;
        }
        const s = get();
        if (id) {
          // Say which failure this is: the caller cannot tell a missing id from
          // a full list, and reported "limit reached" for both.
          if (!s.snippets.some((snippet) => snippet.id === id)) {
            toast("Snippet not saved", { description: "That snippet no longer exists." });
            return false;
          }
          set({
            snippets: s.snippets.map((snippet) =>
              snippet.id === id ? { ...snippet, name: name.trim(), text } : snippet,
            ),
          });
          return true;
        }
        if (s.snippets.length >= SNIPPET_LIMITS.count) {
          toast("Snippet not saved", {
            description: `Snippet limit reached (${SNIPPET_LIMITS.count}). Delete one first.`,
          });
          return false;
        }
        set({ snippets: [...s.snippets, { id: newId(), name: name.trim(), text }] });
        return true;
      },
      deleteSnippet: (id) =>
        set((s) => ({ snippets: s.snippets.filter((snippet) => snippet.id !== id) })),
      setDemoFailure: (kind) => set({ demoFailure: kind }),
      stopHerdr: () =>
        set({
          herdrRunning: false,
        }),
      startHerdr: () => {
        const wasDown = !get().herdrRunning;
        const agents = seedAgents();
        set({
          herdrRunning: true,
          agents,
          events: seedEvents(agents),
          blockedInsertions: {},
          selectedAgentId: "migrate",
          selectedShellId: null,
          shells: [],
          focusedPaneId: "w1:p2",
        });
        if (wasDown) {
          toast("herdr is running", {
            description: "interactive PTY attached · snapshot polling",
          });
        }
      },

      selectAgent: (id) =>
        set((s) => ({
          selectedAgentId: id,
          selectedShellId: null,
          focusedPaneId:
            s.agents.find((a) => a.id === id)?.paneId ?? s.focusedPaneId,
          // Picking an agent opens that agent, rather than moving you to a tab
          // that shows whichever agent was last selected.
          detailAgentId: id,
          jumpOpen: false,
          agents: s.agents.map((a) =>
            a.id === id ? { ...a, attention: false } : a,
          ),
        })),

      // Selecting a shell moves the terminal view; the pane itself lives on
      // the host until explicitly closed.
      selectShell: (id) =>
        set({
          selectedShellId: id,
          focusedPaneId: id,
          detailAgentId: id,
          detailView: "terminal",
          jumpOpen: false,
        }),

      // One reusable shell per canonical cwd: a repeat tap re-attaches, and a
      // dead or closed shell is recreated by the bridge.
      openShell: async (cwd) => {
        const directory = cwd.trim().replace(/\/+$/, "");
        if (!directory) return false;
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            toast("Bridge write failed", { description: "not paired" });
            return false;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          try {
            const res = await postAction(url, {
              kind: "open-shell",
              cwd: directory,
            });
            if (!res.ok) {
              const failure: unknown = await res.json().catch(() => null);
              const message =
                failure && typeof failure === "object" && "error" in failure && typeof (failure.error as { message?: unknown })?.message === "string"
                  ? (failure.error as { message: string }).message
                  : `Request failed (${res.status})`;
              toast("Shell wasn't opened", { description: message });
              return false;
            }
            const payload: unknown = await res.json().catch(() => null);
            const paneId =
              payload && typeof payload === "object" && "paneId" in payload && typeof payload.paneId === "string"
                ? payload.paneId
                : null;
            // A host switched while the open was in flight: the new
            // connection's first snapshot owns the selection, and the shell
            // lives on this host's bridge until re-attached.
            if (get().connectedHostId !== host.id) return true;
            const snap = await fetchSnapshot(url).catch(() => null);
            // Re-check after the await, the way startAgent does: a host switch
            // during the fetch would otherwise apply this host's agents,
            // shells and kinds on top of the one now connected, and select a
            // pane that does not exist there.
            if (get().connectedHostId !== host.id) return true;
            if (snap) {
              set(applySnapshot(get(), snap, paneId ? { selectedShellId: paneId, detailAgentId: paneId, detailView: "terminal" } : {}));
            } else if (paneId) {
              set({ selectedShellId: paneId, detailAgentId: paneId, detailView: "terminal" });
            }
            return true;
          } catch (err) {
            toast("Shell wasn't opened", {
              description: err instanceof Error ? err.message : "Check your connection and try again.",
            });
            return false;
          }
        }
        const existing = get().shells.find((shell) => shell.cwd === directory);
        if (existing) {
          get().selectShell(existing.id);
          return true;
        }
        const id = `demo:shell${(demoShellSeq += 1).toString(36)}`;
        set((s) => ({
          shells: [
            ...s.shells,
            {
              id,
              cwd: directory,
              alive: true,
              lines: [
                { text: `shell in ${directory}`, tone: "dim" as const },
                { text: "type a command, or close it from its header", tone: "plain" as const },
              ],
            },
          ],
        }));
        get().selectShell(id);
        return true;
      },

      disconnect: () => {
        abortConnect();
        const state = get();
        const host = state.hosts.find((h) => h.id === state.connectedHostId);
        if (host?.tailnetUrl) {
          void postLogout(host.tailnetUrl.replace(/\/$/, "")).catch(() => {
            toast("Disconnected locally", { description: "The bridge could not revoke the session. It remains valid until expiry or restart." });
          });
          setHostAccess(host.tailnetUrl, { status: "disconnected" });
        }
        set({
          // The attempt this cancelled will never clear its own flag.
          connecting: false,
          connectedHostId: null,
          connectError: null,
          hostAccess: { status: "disconnected" },
          needsPassword: false,
          needsPasswordHostId: null,
          agentLinks: {},
          blockedInsertions: {},
          // Host-scoped like agentLinks: without this the next host — the demo
          // one included — lists the previous host's shells and lets you open
          // a pane id it never issued.
          shells: [],
          selectedShellId: null,
        });
      },

      connectHost: (id, intent, retry = 0) => {
        const mine = abortConnect();
        connectIntent = intent;
        const current = () => mine === connectAttempt;
        const host = get().hosts.find((h) => h.id === id);
        if (!host) return;
        if (host.tailnetUrl) {
          const url = host.tailnetUrl.replace(/\/$/, "");

          // A reconnect to the same host (after a login, say) keeps
          // connectedHostId, so the earlier snapshot stops counting here.
          set({ connecting: true, connectError: null, accessHostId: id, hostAccess: { status: "disconnected" }, blockedInsertions: {}, snapshotHostId: null });
          void discoverAccess(url)
            .then((access) => {
              if (!current()) return null;
              set({ hostAccess: access, needsPassword: access.status === "login-required", needsPasswordHostId: id });
              if (access.status !== "ready") {
                set({
                  connecting: false,
                  connectError: access.status === "incompatible"
                    ? incompatibleError(access.requiredProtocol)
                    : { title: access.status === "login-required" ? "Password required" : "Pairing required", detail: access.status === "pairing-required" ? `This browser is not approved yet. Request access below, or use a pairing secret from the host.` : "Authenticate with this bridge to continue." },
                });
                return null;
              }
              return fetchSnapshot(url);
            })
            .then((snap) => {
              if (!snap || !current()) return;
              startBlackBox(url);
              const s = get();
              set({
                ...applySnapshot(s, snap, {
                  connecting: false,
                  connectedHostId: id,
                  events: [],
                  needsPassword: false,
                  needsPasswordHostId: null,
                  hosts: s.hosts.map((h) =>
                    h.id === id ? { ...h, lastSeenAt: Date.now() } : h,
                  ),
                }),
              });
              // One success per explicit attempt, under one ID, so a
              // repeated Connect replaces rather than stacks it.
              if (intent === "explicit") {
                toast(`Attached to ${host.label}`, {
                  id: "host-connected",
                  description: `snapshot · ${snap.agents.length} agents`,
                });
              }
              if (get().settings.notify) {
                void registerPush(url).then((setup) => {
                  if (get().settings.notify) set({ pushSetup: setup });
                });
              }
            })
            .catch(async (err: unknown) => {
              if (!current()) return;
              const needsPassword =
                hostAccess(url).status === "login-required";
              if (needsPassword) {
                set({
                  connecting: false,
                  needsPassword,
                  needsPasswordHostId: id,
                  connectError: {
                    title: "Password required",
                    detail: "This bridge is password protected. Enter its password to attach.",
                  },
                });
                return;
              }
              const access = hostAccess(url);
              if (access.status === "pairing-required") {
                set({ connecting: false, connectError: { title: "Pairing required", detail: err instanceof Error ? err.message : access.reason } });
                return;
              }
              const refusal = await connectRefusal(new URL(url).origin);
              if (!current()) return;
              if (refusal) {
                set({ connecting: false, connectError: { title: "Not allowed from this app", detail: refusal } });
                return;
              }
              const verdict = await diagnoseBridge(url);
              if (!current()) return;
              const connectError: ConnectError =
                verdict === "unreachable"
                  ? {
                      title: "Can’t reach the bridge",
                      detail: `The door at ${url} is not answering. Check that Tailscale is connected on this device, the machine is awake, and its bridge is running behind Tailscale Serve.`,
                    }
                  : verdict === "not-bridge"
                    ? {
                        title: "Not a moshpit bridge",
                        detail: `That address answers, but it isn’t serving a moshpit bridge. Check the machine’s tailscale serve registration.`,
                      }
                    : {
                        title: "Bridge unreachable",
                        detail: `Could not read ${url}/api/snapshot. The door answers, so check that the loopback bridge is up behind tailscale serve.`,
                      };
              // Unreachable, or answering but failing: both may pass. A
              // door that is not a bridge will not become one.
              if (verdict !== "not-bridge") {
                const wait = CONNECT_RETRY_MS[retry];
                if (wait !== undefined) {
                  connectError.retryAt = Date.now() + wait;
                  connectError.detail += ` Trying again in ${wait / 1000} s.`;
                  connectRetry = setTimeout(() => {
                    if (current()) get().connectHost(id, intent, retry + 1);
                  }, wait);
                } else {
                  connectError.retryable = true;
                }
              }
              set({ connecting: false, connectError });
            });
          return;
        }
        if (!host.demo) {
          set({
            connectError: {
              title: "Bridge URL needed",
              detail:
                "Add this machine with its Tailscale HTTPS bridge address in Hosts to connect from your browser.",
            },
          });
          return;
        }
        set({ connecting: true, connectError: null });
        window.setTimeout(() => {
          if (!current()) return;
          const agents = seedAgents();
          set({
            connecting: false,
            connectedHostId: id,
            herdrRunning: true,
            agents,
            events: seedEvents(agents),
            blockedInsertions: {},
            selectedAgentId: "migrate",
            focusedPaneId: "w1:p2",
            hosts: get().hosts.map((h) =>
              h.id === id ? { ...h, lastSeenAt: Date.now() } : h,
            ),
          });
          if (intent === "explicit") {
            toast("Attached to Demo herdr", {
              id: "host-connected",
              description: "herdr api snapshot · 6 agents",
            });
          }
        }, 420);
      },

      login: (id, password) => {
        const host = get().hosts.find((h) => h.id === id);
        if (!host?.tailnetUrl) return;
        const url = host.tailnetUrl.replace(/\/$/, "");
        void postLogin(url, password)
          .then(() => {
            set({ needsPassword: false });
            get().connectHost(id, connectIntent);
          })
          .catch((err: unknown) =>
            set({
              needsPassword: true,
              connectError: {
                title: "Login failed",
                detail: err instanceof Error && "status" in err && err.status === 429
                  ? "Too many login attempts. Wait a minute and try again."
                  : "Could not sign in. Check your password and bridge connection.",
              },
            }),
          );
      },

      pair: (id, secret, name, failure) => {
        const host = get().hosts.find((h) => h.id === id);
        const origin = hostOrigin(host?.tailnetUrl);
        if (!origin) return Promise.resolve(false);
        const pending = pairingRequests.get(origin);
        if (pending) return pending;
        set((state) => ({
          pairingOrigins: [...state.pairingOrigins, origin],
          connectError: null,
        }));
        const request = consumePairing(origin, secret, name)
          .then(() => {
            get().connectHost(id, connectIntent);
            return true;
          })
          .catch((error) => {
            set({ connectError: failure?.(error) ?? { title: "Pairing failed", detail: error instanceof Error ? error.message : "Could not pair" } });
            return false;
          })
          .finally(() => {
            pairingRequests.delete(origin);
            set((state) => ({ pairingOrigins: state.pairingOrigins.filter((pendingOrigin) => pendingOrigin !== origin) }));
          });
        pairingRequests.set(origin, request);
        return request;
      },

      openSetupLink: (secret) => {
        // Only the origin that served this page: the link was printed for it,
        // and the grant must never travel to another saved host.
        const url = new URL(window.location.origin);
        const existing = get().hosts.find((h) => !h.demo && hostOrigin(h.tailnetUrl) === url.origin);
        const id = existing?.id ?? get().addHost({
          label: url.hostname,
          transport: "tailscale",
          user: "",
          hostname: url.hostname,
          port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
          tailnetUrl: url.origin,
        });
        get().completeOnboarding();
        set({ tab: "moshpit", detailAgentId: null });
        // Nothing is redeemed until the person confirms the machine and the
        // account this browser is signed in as.
        const redeem = () => {
          pendingSetupSecret = secret;
          set({ setupConfirm: { hostId: id, machine: url.host } });
          void fetchRequesterLogin(url.origin).then(
            (login) => login,
            () => null,
          ).then((login) => {
            const current = get().setupConfirm;
            if (current?.hostId === id) set({ setupConfirm: { ...current, login } });
          });
        };
        const stored = credentials(url.origin);
        if (!stored.deviceId || !stored.deviceSecret) return redeem();
        // An approved browser keeps its approval and the unused grant expires.
        // Stored credentials the bridge revoked or expired are cleared by
        // accessError, and then the link is what re-enrolls this browser.
        void checkDeviceCredential(url.origin).then(
          () => get().connectHost(id, "silent"),
          (error: { code?: string }) =>
            REENROLL_CODES.has(error.code ?? "") ? redeem() : get().connectHost(id, "silent"),
        );
      },
      setupConfirm: null,
      approveSetupLink: () => {
        const confirm = get().setupConfirm;
        const secret = pendingSetupSecret;
        pendingSetupSecret = null;
        if (!confirm || !secret) return;
        set({ setupConfirm: null, tab: "moshpit" });
        void get().pair(confirm.hostId, secret, browserDeviceName(navigator.userAgent), setupLinkFailure).then((paired) => {
          if (!paired) set({ tab: "hosts" });
        });
      },
      cancelSetupLink: () => {
        pendingSetupSecret = null;
        set({ setupConfirm: null, tab: "hosts", detailAgentId: null });
        toast("Setup link cancelled", {
          description: "This browser was not approved. Open the link again, or run moshpit setup on the host for a new one.",
        });
      },

      setHostPing: (id, ms) =>
        set((s) => ({
          hosts: s.hosts.map((h) =>
            h.id === id ? { ...h, pingMs: ms, lastSeenAt: Date.now() } : h,
          ),
        })),

      addHost: (input) => {
        const id = `host-${Date.now().toString(36)}`;
        const host: Host = { ...input, id, demo: false };
        set((s) => ({ hosts: [...s.hosts, host] }));
        return id;
      },

      removeHost: (id) => {
        // Cancelling the attempt also ends its Attaching… state and its error,
        // or every Connect would stay disabled on a host that no longer exists.
        if (get().accessHostId === id) {
          abortConnect();
          set({ connecting: false, connectError: null });
        }
        set((s) => ({
          hosts: s.hosts.filter((h) => h.id !== id || h.demo),
          connectedHostId: s.connectedHostId === id ? null : s.connectedHostId,
        }));
      },

      prompt: async (agentId, text, attachment) => {
        const trimmed = text.replace(/\s+$/, "");
        if (!trimmed && !attachment) return false;
        const host = liveHost(get());
        const blockedAgent = get().agents.find(
          (agent) => agent.id === agentId && agent.status === "blocked",
        );
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            toast("Bridge write failed", { description: "not paired" });
            return false;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          try {
            const res = await postAction(url, {
              kind: "prompt", target: agentId, text: trimmed,
              attachment: attachment ? await encodeImage(attachment) : undefined,
            });
            if (!res.ok) {
              const failure: unknown = await res.json().catch(() => null);
              const message = failure && typeof failure === "object" && "error" in failure && typeof (failure.error as { message?: unknown })?.message === "string" ? (failure.error as { message: string }).message : `Request failed (${res.status})`;
              throw new Error(message);
            }
            if (blockedAgent) {
              get().recordBlockedInsertion(blockedAgent);
            }
            void fetchSnapshot(url).then((snap) => {
              if (get().connectedHostId === host.id) set(applySnapshot(get(), snap));
            }).catch(() => {});
            return true;
          } catch (err) {
            toast("Message wasn't sent", { description: err instanceof Error ? err.message : "Check your connection and try again." });
            return false;
          }
        }
        set((s) => {
          const shellAt = s.shells.findIndex((shell) => shell.id === agentId);
          if (shellAt >= 0) {
            const shells = s.shells.map((shell) => {
              if (shell.id !== agentId) return shell;
              const prior = shell.lines ?? [];
              const lines = trimmed
                ? [...prior, { text: `> ${trimmed}`, tone: "in" as const }, { text: "demo shell ran it", tone: "dim" as const }]
                : prior;
              return { ...shell, lines: lines.slice(-120) };
            });
            return { shells };
          }
          const prior = s.agents.find((a) => a.id === agentId);
          const agents: Agent[] = s.agents.map((agent): Agent => {
            if (agent.id !== agentId) return agent;
            let next = append(agent, "");
            if (attachment)
              next = append(next, formatImageLine(attachment), "in");
            if (trimmed) next = append(next, `> ${trimmed}`, "in");

            if (agent.status === "blocked") return next;

            if (!trimmed) {
              next = append(next, "queued on the running turn", "dim");
              return {
                ...setStatus(next, "working"),
                workTicks: Math.max(agent.workTicks, 3),
                nextStatus: agent.nextStatus ?? "done",
              };
            }

            next = append(next, "queued on the running turn", "dim");
            return {
              ...setStatus(next, "working"),
              workTicks: Math.max(agent.workTicks, 3),
              nextStatus: agent.nextStatus ?? "done",
            };
          });
          const nextAgent = agents.find((a) => a.id === agentId);
          const unblocked =
            prior?.status === "blocked" && nextAgent?.status !== "blocked";
          const events = unblocked
            ? resolveBlocked(
                s.events,
                agentId,
                yes(trimmed) ? "approved" : no(trimmed) ? "denied" : "answered",
              )
            : s.events;
          return {
            agents,
            events,
            blockedInsertions:
              prior?.status === "blocked" && (trimmed || attachment)
                ? {
                    ...s.blockedInsertions,
                    [agentId]: blockedInsertionFor(prior),
                  }
                : s.blockedInsertions,
          };
        });
        return true;
      },

      createAgent: async (projectPath, kind, model, checkout) => {
        const directory = projectPath.trim();
        const modelValue = model?.trim();
        if (!directory || !kind) return { state: "failed" };
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            toast("Bridge write failed", { description: "not paired" });
            return { state: "failed" };
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          try {
            const res = await postAction(url, {
              kind: "start",
              cwd: directory,
              agentKind: kind,
              model: modelValue,
              ...(checkout ? { checkout: { baseRef: checkout.baseRef, branch: checkout.branch } } : {}),
            });
            const payload: unknown = await res.json().catch(() => null);
            const partial = partialFromPayload(payload);
            if (!res.ok) {
              // A partial result is not a hard failure: the worktree exists and
              // must not be recreated. Report it so the caller can retry by
              // starting the agent in the retained directory — with the reason
              // the agent would not start, which is the only thing that tells
              // the user whether retrying is worth anything.
              if (partial) return { state: "failed", message: errorText(payload, "The agent would not start."), partial };
              throw new Error(errorText(payload, `Request failed (${res.status})`));
            }
            const paneId =
              payload &&
              typeof payload === "object" &&
              "paneId" in payload &&
              typeof payload.paneId === "string"
                ? payload.paneId
                : null;
            if (get().connectedHostId !== host.id) return { state: "started" };
            if (paneId) get().selectAgent(paneId);
            const snap = await fetchSnapshot(url).catch(() => null);
            if (snap && get().connectedHostId === host.id) {
              set(applySnapshot(get(), snap, paneId ? { selectedAgentId: paneId, detailAgentId: paneId, focusedPaneId: paneId } : {}));
            }
            return { state: "started" };
          } catch (err) {
            toast("Agent wasn't started", {
              description: err instanceof Error ? err.message : "Check your connection and try again.",
            });
            return { state: "failed" };
          }
        }
        if (checkout) {
          toast("Worktree launch needs a real host", {
            description: "The demo herdr has no Git. Connect a bridge to start an agent in a new worktree.",
          });
          return { state: "failed" };
        }
        const paneId = `demo:p${Date.now().toString(36)}`;
        const name = `${kind}-${paneId.slice(-6)}`;
        const agent: Agent = {
          id: paneId,
          name,
          kind,
          status: "working",
          workspace: "demo",
          tab: name,
          paneId,
          cwd: directory,
          projectRoot: directory,
          branch: "",
          lastOutput: `started ${kind}`,
          model: modelValue,
          lines: [{ text: `started ${kind}`, tone: "dim" }],
          attention: false,
          statusChangedAt: Date.now(),
          workTicks: 2,
          ticks: 0,
          nextStatus: "idle",
          blockedPrompt: null,
        };
        set((s) => ({ agents: [...s.agents, agent] }));
        get().selectAgent(paneId);
        return { state: "started" };
      },

      sendKeys: (agentId, keys, onOutcome) => {
        const finish = (state: "delivered" | "failed", message: string) =>
          onOutcome?.({ state, message });
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            const message = "not paired";
            toast("Bridge write failed", { description: message });
            finish("failed", message);
            return;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          // postAction throws on a non-2xx, so the catch below is the only
          // failure path there is.
          void postAction(url, {
            kind: "keys",
            target: agentId,
            keys,
          })
            .then(() => {
              finish("delivered", "Keys sent");
              // Only apply if we are still on the host this went to; a
              // disconnect mid-flight would otherwise repopulate the list.
              return fetchSnapshot(url).then((snap) => {
                if (get().connectedHostId === host.id) set(applySnapshot(get(), snap));
              });
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              toast("Bridge write failed", { description: message });
              finish("failed", message);
            });
          return;
        }
        // Marked text is echoed, never matched against key names.
        const name = typeof keys === "string" ? keys : "";
        const shown = typeof keys === "string" ? keys : keys.text;
        set((s) => {
          const shellAt = s.shells.findIndex((shell) => shell.id === agentId);
          if (shellAt >= 0) {
            const shells = s.shells.map((shell) => {
              if (shell.id !== agentId) return shell;
              const prior = shell.lines ?? [];
              if (name === "ctrl+l") return { ...shell, lines: prior.slice(-2) };
              const echo = name === "ctrl+c" ? "^C" : name === "esc" ? "[esc]" : shown;
              const tone = name === "ctrl+c" ? ("warn" as const) : name === "esc" ? ("dim" as const) : ("in" as const);
              return { ...shell, lines: [...prior, { text: echo, tone }].slice(-120) };
            });
            return { shells };
          }
          const prior = s.agents.find((a) => a.id === agentId);
          const agents = s.agents.map((agent) => {
            if (agent.id !== agentId) return agent;
            if (name === "enter" && agent.status === "blocked") {
              // Only an insertion made into this block can be committed. The
              // scan walks the whole pane, so without this gate Enter would
              // answer with a prompt sent during an earlier turn.
              if (!s.blockedInsertions[agentId]) return agent;
              const text = pendingDemoText(agent);
              return text ? commitDemoText(agent, text) : agent;
            }
            if (name === "esc" && agent.status === "blocked") {
              return {
                ...setStatus(append(agent, "[esc]", "dim"), "idle"),
                blockedPrompt: null,
                nextStatus: null,
              };
            }
            if (name === "ctrl+c") {
              let next = append(agent, "^C", "warn");
              next = append(next, "interrupted", "dim");
              return {
                ...setStatus(next, "idle"),
                blockedPrompt: null,
                nextStatus: null,
              };
            }
            if (name === "ctrl+l") {
              return { ...agent, lines: agent.lines.slice(-2) };
            }
            if (name === "ctrl+d") {
              return append(agent, "^D", "dim");
            }
            if (name === "esc") {
              return append(agent, "[esc]", "dim");
            }
            if (name === "tab") {
              return append(agent, "    ", "dim");
            }
            if (name === "shift+tab") {
              return append(agent, "[shift+tab]", "dim");
            }
            if (name.startsWith("ctrl+")) {
              return append(agent, `^${name.slice(5).toUpperCase()}`, "dim");
            }
            return append(agent, shown, "in");
          });
          const nextAgent = agents.find((a) => a.id === agentId);
          const interrupted =
            (keys === "ctrl+c" || keys === "enter" || keys === "esc") &&
            prior?.status === "blocked" &&
            nextAgent?.status !== "blocked";
          return {
            agents,
            events: interrupted
              ? resolveBlocked(
                  s.events,
                  agentId,
                  keys === "esc" ? "denied" : "answered",
                )
              : s.events,
            blockedInsertions:
              interrupted
                ? Object.fromEntries(
                    Object.entries(s.blockedInsertions).filter(([id]) => id !== agentId),
                  )
                : s.blockedInsertions,
          };
        });
        finish("delivered", "Keys sent");
      },

      renameAgent: async (target, name) => {
        const trimmed = name.trim();
        // The bridge persists the rename in herdr's pane label, so the
        // optimistic title is a gap-filler until the confirming snapshot lands.
        const applyRename = () =>
          set((s) => ({
            agents: s.agents.map((agent) =>
              agent.id === target ? { ...agent, title: trimmed || undefined, name: trimmed || agent.name } : agent,
            ),
          }));
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            toast("Bridge write failed", { description: "not paired" });
            return false;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          try {
            const res = await postAction(url, {
              kind: "rename", target, name: trimmed || undefined, clear: trimmed ? undefined : true,
            });
            if (!res.ok) {
              const failure: unknown = await res.json().catch(() => null);
              const message = failure && typeof failure === "object" && "error" in failure && typeof (failure.error as { message?: unknown })?.message === "string" ? (failure.error as { message: string }).message : `Request failed (${res.status})`;
              toast("Rename failed", { description: message });
              return false;
            }
            applyRename();
            void fetchSnapshot(url).then((snap) => {
              if (get().connectedHostId === host.id) set(applySnapshot(get(), snap));
            }).catch(() => {});
            return true;
          } catch (err) {
            toast("Rename failed", { description: err instanceof Error ? err.message : "Check your connection and try again." });
            return false;
          }
        }
        applyRename();
        return true;
      },

      closeAgent: async (target) => {
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            toast("Bridge write failed", { description: "not paired" });
            return false;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          try {
            const res = await postAction(url, { kind: "close", target });
            if (!res.ok) {
              const failure: unknown = await res.json().catch(() => null);
              const message = failure && typeof failure === "object" && "error" in failure && typeof (failure.error as { message?: unknown })?.message === "string" ? (failure.error as { message: string }).message : `Request failed (${res.status})`;
              toast("Close failed", { description: message });
              return false;
            }
            set((s) => closeLocal(s, target));
            void fetchSnapshot(url).then((snap) => {
              if (get().connectedHostId === host.id) set(applySnapshot(get(), snap));
            }).catch(() => {});
            return true;
          } catch (err) {
            toast("Close failed", { description: err instanceof Error ? err.message : "Check your connection and try again." });
            return false;
          }
        }
        set((s) => closeLocal(s, target));
        return true;
      },

      answerDialog: (target, token, optionKey, onOutcome) => {
        const finish = (state: "delivered" | "failed", message: string) =>
          onOutcome?.({ state, message });
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            const message = "not paired";
            toast("Bridge write failed", { description: message });
            finish("failed", message);
            return;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          // postAction throws on a non-2xx, so the catch below is the only
          // failure path there is.
          void postAction(url, {
            kind: "answer",
            target,
            token,
            optionKey,
          })
            .then(() => {
              finish("delivered", "Answer sent");
              void fetchSnapshot(url).then((snap) => {
                if (get().connectedHostId === host.id) set(applySnapshot(get(), snap));
              }).catch(() => {});
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              toast("Bridge write failed", { description: message });
              finish("failed", message);
            });
          return;
        }
        const current = get().agents.find((agent) => agent.id === target);
        const dialog = current?.blockedDialog;
        const choice = dialog?.kind === "choose"
          ? dialog.options.find((option) => option.key === optionKey)
          : undefined;
        const questions = current?.question;
        const step = dialog?.kind === "choose" ? dialog.step.index : -1;
        if (
          !dialog ||
          dialog.kind !== "choose" ||
          dialog.expected.token !== token ||
          !choice ||
          !questions ||
          !questions[step]
        ) {
          finish("failed", "That answer is no longer available.");
          return;
        }
        const answered = questions.map((question, index) =>
          index === step ? { ...question, answer: choice.label } : question,
        );
        const nextQuestion = answered[step + 1];
        set((s) => {
          const agents = s.agents.map((agent) => {
            if (agent.id !== target) return agent;
            let next = append(agent, optionKey, "in");
            next = append(next, "thinking…", "dim");
            if (nextQuestion) {
              next = append(next, nextQuestion.text, "warn");
              return {
                ...next,
                question: answered,
                blockedPrompt: nextQuestion.text,
                blockedDialog: demoDialog(next, answered, step + 1),
                nextStatus: null,
              };
            }
            const cleared = {
              ...setStatus(next, "working"),
              question: answered,
              blockedPrompt: null,
              workTicks: 3,
              nextStatus: "done" as const,
            };
            delete cleared.blockedDialog;
            return cleared;
          });
          return {
            agents,
            events: nextQuestion
              ? s.events
              : resolveBlocked(s.events, target, "answered"),
            blockedInsertions: nextQuestion
              ? s.blockedInsertions
              : Object.fromEntries(
                  Object.entries(s.blockedInsertions).filter(([id]) => id !== target),
                ),
          };
        });
        finish("delivered", "Answer sent");
      },

      answerAgent: (target, keys, onOutcome) => {
        const finish = (state: "delivered" | "failed", message: string) =>
          onOutcome?.({ state, message });
        // askOptionKeys yields nothing for an option it cannot place; sending
        // that would just earn a 400 from the bridge's key validation.
        if (Array.isArray(keys) && !keys.length) {
          finish("failed", "That option has no key to send.");
          return;
        }
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const ready = get().hostAccess.status === "ready";
          if (!ready) {
            const message = "not paired";
            toast("Bridge write failed", { description: message });
            finish("failed", message);
            return;
          }
          const url = host.tailnetUrl.replace(/\/$/, "");
          // postAction throws on a non-2xx, so the catch below is the only
          // failure path there is.
          void postAction(url, {
            kind: "keys",
            target,
            keys,
          })
            .then(() => {
              finish("delivered", "Answer sent");
              // Only apply if we are still on the host this went to; a
              // disconnect mid-flight would otherwise repopulate the list.
              return fetchSnapshot(url).then((snap) => {
                if (get().connectedHostId === host.id) set(applySnapshot(get(), snap));
              });
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              toast("Bridge write failed", { description: message });
              finish("failed", message);
            });
          return;
        }
        set((s) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const prior = s.agents.find((a) => a.id === target);
          const agents = s.agents.map((agent) => {
            if (agent.id !== target) return agent;
            let next = agent;
            for (const key of list) next = append(next, typeof key === "string" ? key : key.text, "in");
            if (prior?.status === "blocked") {
              next = append(next, "thinking…", "dim");
              next = {
                ...setStatus(next, "working"),
                blockedPrompt: null,
                workTicks: 3,
                nextStatus: "done",
              };
            }
            return next;
          });
          return {
            agents,
            events:
              prior?.status === "blocked"
                ? resolveBlocked(s.events, target, "answered")
                : s.events,
          };
        });
        finish("delivered", "Answer sent");
      },

      simulateBlocked: () => {
        const { agents, settings } = get();
        const candidate =
          agents.find((a) => a.status === "idle" || a.status === "done") ??
          agents.find((a) => a.status === "working");
        if (!candidate) return;
        const question = "Need a decision before I continue — proceed? y/n";
        set((s) => ({
          agents: s.agents.map((a) => {
            if (a.id !== candidate.id) return a;
            let next = append(a, "");
            next = append(next, question, "warn");
            next = {
              ...setStatus(next, "blocked"),
              blockedPrompt: question,
              lastOutput: question,
              nextStatus: null,
            };
            return next;
          }),
          events: capEvents([
            ...s.events,
            makeEvent(candidate.id, "blocked", question),
          ]),
          blockedInsertions: Object.fromEntries(
            Object.entries(s.blockedInsertions).filter(([id]) => id !== candidate.id),
          ),
          tab: "moshpit",
        }));
        const blocked = {
          ...candidate,
          lastOutput: "Need a decision before I continue — proceed? y/n",
        };
        notifyBlocked(blocked, settings.notify);
      },

      resetDemo: () => {
        const agents = seedAgents();
        set({
          agents,
          events: seedEvents(agents),
          blockedInsertions: {},
          selectedAgentId: "migrate",
          selectedShellId: null,
          shells: [],
          focusedPaneId: "w1:p2",
          connectedHostId: "demo",
          connectError: null,
          herdrRunning: true,
          demoFailure: null,
          filter: "all",
          tab: "moshpit",
        });
        toast("Demo herdr reset");
      },

      tick: () => {
        const host = liveHost(get());
        if (host?.tailnetUrl) {
          const url = host.tailnetUrl.replace(/\/$/, "");
          void fetchSnapshot(url)
            .then((snap) => {
              const s = get();
              if (s.connectedHostId !== host.id) return;
              const prior = new Map(s.agents.map((a) => [a.id, a.status]));
              const extra: AgentEvent[] = [];
              for (const agent of snap.agents) {
                const was = prior.get(agent.id);
                // No row here for a new block: applySnapshot opens one for
                // every blocked agent without one. Adding it here as well put
                // two rows in the Inbox for every live block.
                if (agent.status === "blocked") continue;
                // A finished turn is the whole point of watching from a phone,
                // and only the live path can see it: the demo tick emits its
                // own. `was` is undefined on the first snapshot, so a pane that
                // is merely idle at attach never reads as a completion.
                if (
                  was === "working" &&
                  (agent.status === "idle" || agent.status === "done")
                ) {
                  extra.push(
                    makeEvent(
                      agent.id,
                      "turn",
                      agent.title || agent.lastOutput || "Turn finished",
                    ),
                  );
                }
              }
              const next = applySnapshot(s, snap);
              set({
                ...next,
                connectError: null,
                events: extra.length
                  ? capEvents([...(next.events ?? s.events), ...extra])
                  : next.events,
              });
            })
            .catch(() => {
              if (get().connectedHostId !== host.id) return;
              set({ connectError: { title: "Connection interrupted", detail: "Your host isn't responding. Showing the last received state. Retrying automatically." } });
            });
          return;
        }
        set((s) => {
          if (!s.connectedHostId || !s.herdrRunning) return s;
          const extra: AgentEvent[] = [];
          const agents = s.agents.map((agent) => {
            if (agent.status !== "working") return agent;
            const ticks = agent.ticks + 1;
            const pool = WORKING_LINES[agent.id] ?? WORKING_LINES.default;
            const line = pool[(ticks - 1) % pool.length];
            let next = append({ ...agent, ticks }, line, "plain");
            if (ticks === 1) extra.push(makeEvent(agent.id, "tool", line));
            if (ticks >= agent.workTicks && agent.nextStatus) {
              if (agent.nextStatus === "done") {
                const finished = `${agent.kind} finished ${agent.name}.`;
                next = append(next, finished, "ok");
                extra.push(makeEvent(agent.id, "turn", finished));
              } else {
                extra.push(
                  makeEvent(
                    agent.id,
                    "turn",
                    `${agent.name} is ${agent.nextStatus}`,
                  ),
                );
              }
              next = {
                ...setStatus(next, agent.nextStatus),
                nextStatus: null,
                workTicks: 0,
              };
            }
            return next;
          });
          return extra.length
            ? { agents, events: capEvents([...s.events, ...extra]) }
            : { agents };
        });
      },
    }),
    {
      name: "moshpit-v1",
      storage: createJSONStorage(() => {
        // Touching the property (rather than a typeof test) throws under
        // Node and when storage access is blocked, which keeps zustand's
        // no-storage fallback instead of hydrating against dead storage.
        const ls = window.localStorage;
        return settingsGuardedStorage(ls);
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const support = inspectPushSupport();
        if (!state.settings.notify) state.pushSetup = { status: "off" };
        else if (support.status === "unavailable" || support.status === "denied") state.pushSetup = support;
        else if (support.status === "ready") state.pushSetup = { status: "pending" };
        else state.pushSetup = { status: "off" };
        state.setHydrated();
      },
      partialize: (s) => ({
        onboarded: s.onboarded,
        lastSeenRelease: s.lastSeenRelease,
        collapsedProjects: s.collapsedProjects,
        hosts: s.hosts,
        settings: s.settings,
        connectedHostId: s.connectedHostId,
        herdrRunning: s.herdrRunning,
        events: s.events,
        snippets: s.snippets,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MoshpitState>;
        const stored = p.hosts ?? current.hosts;
        // The demo host is fixture-only now. Seed it just for ?demo=1, and
        // drop it from installs that were seeded before the pivot.
        const demo = demoEnabled();
        const hosts = demo
          ? stored.some((h) => h.demo)
            ? stored
            : [DEMO_HOST, ...stored]
          : stored.filter((h) => !h.demo);
        const storedConnectedHostId =
          p.connectedHostId === undefined
            ? current.connectedHostId
            : p.connectedHostId;
        const connectedHostId = hosts.some(
          (h) => h.id === storedConnectedHostId,
        )
          ? (storedConnectedHostId ?? null)
          : null;
        return {
          ...current,
          ...p,
          connectedHostId,
          hosts,
          setupConfirm: null,
          // Persisted snippets are untrusted; drop entries that fail
          // validation instead of failing the whole rehydrate.
          snippets: sanitizeSnippets(p.snippets) ?? [],
          settings: {
            ...current.settings,
            ...p.settings,
          },
        };
      },
    },
  ),
);

export function sortedAgents(agents: Agent[], filter: FilterId) {
  const list =
    filter === "all" ? agents : agents.filter((a) => a.status === filter);
  return [...list].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    return a.statusChangedAt - b.statusChangedAt;
  });
}

export function blockedCount(agents: Agent[]) {
  return agents.filter((a) => a.status === "blocked").length;
}

export { inboxUnread, formatImageLine };

watchAccess((origin, access) => {
  const s = useMoshpitStore.getState();
  const host = s.hosts.find((h) => h.id === s.accessHostId || h.id === s.connectedHostId);
  if (!host?.tailnetUrl || new URL(host.tailnetUrl).origin !== origin) return;
  useMoshpitStore.setState({ hostAccess: access, needsPassword: access.status === "login-required", needsPasswordHostId: host.id, accessHostId: host.id });
});
