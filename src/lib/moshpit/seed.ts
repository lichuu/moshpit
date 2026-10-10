import type { Agent, Host, PaneLine } from "./types";

const now = Date.now();

function L(text: string, tone: PaneLine["tone"] = "plain"): PaneLine {
  return { text, tone };
}

export const DEMO_HOST: Host = {
  id: "demo",
  label: "Demo herdr",
  transport: "tailscale",
  user: "you",
  hostname: "100.64.0.12",
  port: 22,
  demo: true,
  lastSeenAt: now,
  pingMs: 12,
};

export const SAMPLE_HOSTS: Host[] = [
  DEMO_HOST,
  {
    id: "mac-mini",
    label: "Mac mini",
    transport: "tailscale",
    user: "ada",
    hostname: "100.91.14.8",
    port: 22,
    demo: false,
    keyName: "ada-ed25519",
    keyFingerprint: "SHA256:mock-mac-mini",
    lastSeenAt: now - 2 * 60 * 60 * 1000,
  },
  {
    id: "vps",
    label: "workbox",
    transport: "ssh",
    user: "deploy",
    hostname: "workbox.example.net",
    port: 22,
    demo: false,
    keyName: "deploy-ed25519",
    keyFingerprint: "SHA256:mock-workbox",
    lastSeenAt: now - 26 * 60 * 60 * 1000,
  },
];

export function seedAgents(): Agent[] {
  return [
    {
      id: "migrate",
      name: "migrate",
      kind: "codex",
      status: "blocked",
      workspace: "web",
      tab: "db",
      paneId: "w1:p2",
      cwd: "~/src/web",
      branch: "main",
      pullRequest: { number: 455, readiness: "closed", url: "https://github.com/example/web-app/pull/455" },
      lastOutput: "Should I run prisma migrate? y/n",
      attention: true,
      statusChangedAt: now - 2 * 60 * 1000,
      workTicks: 0,
      ticks: 0,
      nextStatus: null,
      blockedPrompt: "Should I run prisma migrate? y/n",
      lines: [
        L("codex  ·  web / db  ·  ~/src/web", "dim"),
        L("on branch main", "dim"),
        L(""),
        L("schema.prisma changed:"),
        L("  + model Host {", "ok"),
        L("  +   id        String  @id", "ok"),
        L("  +   transport String", "ok"),
        L("  +   hostname  String", "ok"),
        L("  + }", "ok"),
        L(""),
        L("4 pending migrations.", "warn"),
        L(""),
        L("Should I run prisma migrate? y/n", "warn"),
      ],
      // A y/n prompt the card parser cannot read: the question is known but
      // the keys are not, so Chat shows the choices and sends you to the
      // Terminal rather than guessing which key commits.
      question: [
        {
          text: "Should I run prisma migrate?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
      blockedDialog: {
        kind: "terminal",
        question: "Should I run prisma migrate? y/n",
        options: [],
      },
    },
    {
      id: "accent",
      name: "postcard-ui",
      kind: "opencode",
      status: "blocked",
      workspace: "side-quest",
      tab: "ui",
      paneId: "w3:p1",
      cwd: "~/src/postcard",
      branch: "visuals",
      pullRequest: { number: 318, readiness: "ready", url: "https://github.com/example/postcard/pull/318" },
      lastOutput: "Which deployment experience should we design first?",
      attention: true,
      statusChangedAt: now - 48 * 1000,
      workTicks: 0,
      ticks: 0,
      nextStatus: null,
      blockedPrompt: "Which deployment experience should we design first?",
      question: [
        {
          text: "Which deployment experience should we design first?",
          options: [
            { label: "Own machine (Recommended)", description: "Run it on your laptop" },
            { label: "Remote server" },
            { label: "Both equally" },
          ],
        },
        {
          text: "How should the machines talk to each other?",
          options: [
            { label: "Require Tailscale (Recommended)" },
            { label: "Public ports" },
          ],
        },
        {
          text: "What is the first step after choosing?",
          options: [
            { label: "One command, then browser (Recommended)" },
            { label: "Full setup docs" },
          ],
        },
      ],
      blockedDialog: {
        kind: "choose",
        family: "codex-request-user-input-v1",
        sessionId: "demo:accent",
        expected: {
          token: "demo-accent-token-0",
          signature: "demo-accent-signature-0",
          revision: null,
        },
        question: "Which deployment experience should we design first?",
        step: { index: 0, total: 3 },
        options: [
          { key: "1", label: "Own machine (Recommended)", description: "Run it on your laptop" },
          { key: "2", label: "Remote server" },
          { key: "3", label: "Both equally" },
        ],
      },
      lines: [
        L("opencode  ·  side-quest / ui  ·  ~/src/postcard", "dim"),
        L(""),
        L("Drafting the mark and tokens."),
        L("Two palettes still in play:", "dim"),
        L("  green  #a6e3a1  — herdr accent", "dim"),
        L("  mauve  #cba6f7  — catppuccin", "dim"),
        L(""),
        L("Which deployment experience should we design first?", "warn"),
      ],
    },
    {
      id: "auth",
      name: "auth-rewrite",
      kind: "claude-code",
      status: "working",
      workspace: "web",
      tab: "auth",
      paneId: "w1:p1",
      cwd: "~/src/web",
      branch: "session-refresh",
      pullRequest: { number: 482, readiness: "pending", url: "https://github.com/example/web-app/pull/482" },
      lastOutput: "rewriting refresh tokens in src/lib/session.ts",
      attention: false,
      statusChangedAt: now - 6 * 60 * 1000,
      workTicks: 18,
      ticks: 3,
      nextStatus: "done",
      blockedPrompt: null,
      question: [
        {
          text: "Which refresh strategy?",
          options: [{ label: "rotate on use" }, { label: "fixed expiry" }],
          answer: "rotate on use",
        },
      ],
      lines: [
        L("claude-code  ·  web / auth", "dim"),
        L(""),
        L("Read src/lib/session.ts", "dim"),
        L("The session path is too wide — tightening to /api."),
        L("editing src/lib/session.ts", "ok"),
        L("rewriting refresh tokens in src/lib/session.ts"),
      ],
    },
    {
      id: "pager",
      name: "pager-duty",
      kind: "claude-code",
      status: "working",
      workspace: "infra",
      tab: "alerts",
      paneId: "w2:p1",
      cwd: "~/infra",
      branch: "oncall",
      pullRequest: { number: 17, readiness: "blocked", url: "https://github.com/example/infra/pull/17" },
      lastOutput: "wiring Tailscale ACL checks into the probe",
      attention: false,
      statusChangedAt: now - 11 * 60 * 1000,
      workTicks: 22,
      ticks: 5,
      nextStatus: "done",
      blockedPrompt: null,
      lines: [
        L("claude-code  ·  infra / alerts", "dim"),
        L(""),
        L("probe.ts: timeout was 2s — too tight on Mosh UDP."),
        L("wiring Tailscale ACL checks into the probe"),
      ],
    },
    {
      id: "ci",
      name: "ci-green",
      kind: "opencode",
      status: "done",
      workspace: "web",
      tab: "ci",
      paneId: "w1:p3",
      cwd: "~/src/web",
      branch: "main",
      pullRequest: { number: 470, readiness: "merged", url: "https://github.com/example/web-app/pull/470" },
      lastOutput: "42 tests passed. typecheck clean.",
      attention: false,
      statusChangedAt: now - 18 * 60 * 1000,
      workTicks: 0,
      ticks: 0,
      nextStatus: null,
      blockedPrompt: null,
      lines: [
        L("opencode  ·  web / ci", "dim"),
        L(""),
        L("pnpm test", "in"),
        L("  42 passed", "ok"),
        L("pnpm typecheck", "in"),
        L("  clean", "ok"),
        L(""),
        L("42 tests passed. typecheck clean.", "ok"),
      ],
    },
    {
      id: "docs",
      name: "tailscale-docs",
      kind: "codex",
      status: "idle",
      workspace: "infra",
      tab: "docs",
      paneId: "w2:p2",
      cwd: "~/infra",
      branch: "docs",
      pullRequest: { number: 23, readiness: "draft", url: "https://github.com/example/infra/pull/23" },
      lastOutput: "Waiting for the next prompt.",
      attention: false,
      statusChangedAt: now - 40 * 60 * 1000,
      workTicks: 0,
      ticks: 0,
      nextStatus: null,
      blockedPrompt: null,
      lines: [
        L("codex  ·  infra / docs", "dim"),
        L(""),
        L("Wrote notes on MagicDNS vs 100.x on iOS."),
        L("published: https://tailscale.com/kb/1082/magicdns", "ok"),
        L("Waiting for the next prompt.", "dim"),
      ],
    },
  ];
}

export const WORKING_LINES: Record<string, string[]> = {
  auth: [
    "splitting session writes from token rotation",
    "adding a single-flight lock around refresh",
    "tests: session.test.ts — 6 passing",
    "tightening SameSite on the host session",
  ],
  pager: [
    "probe now retries once on Tailscale idle-wake",
    "ACL: tag:oncall can ssh to tag:herdr",
    "dropping the public :22 probe — tailnet only",
    "writing the runbook paragraph on Mac lid sleep",
  ],
  migrate: [
    "prisma migrate deploy",
    "Applying migration 20260831_hosts",
    "Applying migration 20260831_agent_status",
    "4 migrations applied",
  ],
  accent: [
    "locking accent to the chosen token",
    "updating @theme --color-accent",
    "status pills stay semantic, brand stays bone/olive",
  ],
  default: [
    "reading the surrounding files",
    "applying the change",
    "running the nearby tests",
  ],
};

/**
 * The demo seed is a test fixture, not a product surface.
 *
 * Every verify-moshpit feature doc drives through it, so it stays reachable —
 * but only when asked for with `?demo=1`, which also persists for the session
 * so the flag survives in-app navigation.
 */
export function demoEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).has("demo")) {
      window.sessionStorage.setItem("moshpit-demo", "1");
      return true;
    }
    return window.sessionStorage.getItem("moshpit-demo") === "1";
  } catch {
    return false;
  }
}
