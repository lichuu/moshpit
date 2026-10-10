import type { ThemeId } from "./themes";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type Transport = "ssh" | "tailscale" | "mosh";
export type TabId = "moshpit" | "inbox" | "hosts";
export type EventKind = "blocked" | "tool" | "turn";
export type EventResolution = "approved" | "denied" | "answered";
/** What became of one answer a control sent, so the control can unlatch. */
export type AnswerOutcome = {
  state: "delivered" | "failed";
  message: string;
};
export type AnswerCallback = (outcome: AnswerOutcome) => void;
export type FilterId = "all" | "blocked" | "working" | "done";
export type TermSize = "sm" | "md" | "lg";
export type AgentView = "chat" | "terminal" | "links";

/** A companion shell: a bare interactive pane in an agent's working directory. */
export type Shell = {
  /** The pane id the terminal and key writes target. */
  id: string;
  cwd: string;
  /** Bridge-only: false when the pane has exited; the demo host keeps it true. */
  alive?: boolean;
  /** Demo-only lines; the live host renders from PTY dumps. */
  lines?: PaneLine[];
};

export type Attachment = File;
export type LineTone = "dim" | "ok" | "warn" | "in" | "out" | "plain";
export type FailureKind =
  | "tailscale-off"
  | "sshd-refused"
  | "herdr-path"
  | "mosh-missing"
  | "udp-blocked";
export type KeySource = "paste" | "file" | "generated";
export type { ThemeId };

export type Host = {
  id: string;
  label: string;
  transport: Transport;
  user: string;
  hostname: string;
  port: number;
  demo: boolean;
  tailnetUrl?: string;
  moshOverTailscale?: boolean;
  udpPort?: string;
  keyName?: string;
  keyFingerprint?: string;
  lastSeenAt?: number;
  pingMs?: number | null;
};

export type PaneLine = {
  text: string;
  tone: LineTone;
};

export type DemoQuestionOption = {
  label: string;
  description?: string;
};

export type DemoQuestion = {
  text: string;
  multi?: boolean;
  options: DemoQuestionOption[];
  answer?: string;
};

export type Snippet = {
  id: string;
  name: string;
  text: string;
};

export type AgentEvent = {
  id: string;
  agentId: string;
  kind: EventKind;
  text: string;
  at: number;
  resolved?: EventResolution;
};

/** What the bridge makes of a pull request: one word, so the client holds no forge logic. */
export type PullRequestReadiness = "ready" | "pending" | "blocked" | "draft" | "merged" | "closed";

/** The pull request for an agent's branch, when the bridge found one. */
export type PullRequest = { number: number; readiness: PullRequestReadiness; url: string };

export type Agent = {
  id: string;
  sessionId?: string;
  name: string;
  kind: string;
  status: AgentStatus;
  workspace: string;
  tab: string;
  paneId: string;
  cwd: string;
  projectRoot?: string;
  branch: string;
  /** The branch's pull request. Absent when the bridge has none, or does not report them. */
  pullRequest?: PullRequest;
  /** The pane's own terminal title, when herdr reports one. */
  title?: string;
  /** pi's current model, read from its session file, when known. */
  model?: string;
  lastOutput: string;
  lines: PaneLine[];
  attention: boolean;
  statusChangedAt: number;
  /** When the session's newest message was sent or received, when known. */
  lastMessageAt?: number;
  workTicks: number;
  ticks: number;
  nextStatus: AgentStatus | null;
  blockedPrompt: string | null;
  revision?: number;
  /** Choices parsed off a blocked dialog, when the agent offered numbered ones. */
  blockedOptions?: BlockedOption[];
  /** Bridge-observed blocked dialog: Chat can answer a `choose` directly. */
  blockedDialog?: BlockedDialog;
  /** Demo-only: the questions carried by one rendered ask-user entry. */
  question?: DemoQuestion[];
};

export type AgentDetail = {
  agentId: string;
  revision: number;
  output: string;
  conversation:
    | { kind: "available"; messages: import("./chat").ChatMessage[] }
    | { kind: "unavailable"; reason: string };
};

/** One tappable answer. `key` is the literal keystroke that picks it. */
export type BlockedOption = { key: string; label: string };

/**
 * A blocked dialog observed by the bridge. `choose` carries the agent's own
 * printed keys and is answerable from Chat; `terminal` falls back to the
 * terminal view. `expected` is the token signature the bridge minted, so an
 * answer is only accepted while the same dialog step is still open.
 */
export type BlockedDialog =
  | {
      kind: "choose";
      family: string;
      sessionId?: string;
      expected: { token: string; signature: string; revision: number | null };
      question: string;
      step: { index: number; total: number } | null;
      options: { key: string; label: string; description?: string }[];
    }
  | { kind: "terminal"; question: string; options: BlockedOption[]; reason?: string };

export type Settings = {
  termSize: TermSize;
  /** Soft-wrap long terminal rows to the pane width instead of panning. */
  termWrap: boolean;
  prefix: string;
  voice: boolean;
  /** Intent only. Delivery truth is session `pushSetup`. */
  notify: boolean;
  /** What a notification on this device may show; the connected host holds the same value. */
  notifyText: PushPrivacy;
  /** A short sound, while the app is open and visible, when an agent blocks or finishes. */
  cueSound: boolean;
  theme: ThemeId;
  autoSwitch: boolean;
};

/** Delivery truth for the Hosts control. Not persisted. */
export type PushSetup =
  | { status: "off" }
  | { status: "unavailable"; reason: "no-notification" | "no-push-manager" | "no-sw" }
  /** The browser could receive push, but the host says it cannot send it. */
  | { status: "unavailable"; reason: "bridge"; message: string }
  | { status: "denied" }
  | { status: "pending" }
  | { status: "failed"; message: string }
  /** Permission granted, but no bridge to register with: this tab only. */
  | { status: "local" }
  | { status: "on" };

/** Full text, the agent's name only, or no agent detail at all. */
export type PushPrivacy = "full" | "name" | "generic";

export type PairPush =
  | { action: "retain" }
  | { action: "set"; subscription: PushSubscriptionJSON; privacy?: PushPrivacy }
  | { action: "privacy"; privacy: PushPrivacy }
  | { action: "clear" };

export const BRIDGE_PROBE_MS = 4000;

export type ConnectError = {
  title: string;
  detail: string;
  /** A network failure the store will retry on its own at this time. */
  retryAt?: number;
  /** Automatic retries are spent; offer a Retry action. */
  retryable?: boolean;
  /**
   * The bridge and this app speak different protocols: "app" when the bridge
   * is newer, so reloading fetches the matching app; "bridge" when the host
   * needs updating. Never an authentication problem.
   */
  incompatible?: "app" | "bridge";
};

export type TestStageState = "idle" | "run" | "ok" | "fail";
export type TestStage = {
  id: string;
  label: string;
  state: TestStageState;
  detail?: string;
};

export type HostAccess =
  | { status: "disconnected" }
  | { status: "login-required" }
  | { status: "pairing-required"; reason: "new" | "expired" | "revoked" }
  // A null expiry is a device the host chose not to expire.
  | { status: "ready"; deviceId: string; deviceExpiresAt: number | null }
  | { status: "incompatible"; requiredProtocol: number };
