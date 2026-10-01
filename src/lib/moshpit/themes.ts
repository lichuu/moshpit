export type ThemeId =
  | "moshpit-light"
  | "moshpit-dark"
  | "catppuccin"
  | "catppuccin-latte"
  | "tokyo-night"
  | "tokyo-night-day"
  | "dracula"
  | "nord"
  | "gruvbox"
  | "gruvbox-light"
  | "one-dark"
  | "one-light"
  | "solarized"
  | "solarized-light"
  | "kanagawa"
  | "kanagawa-lotus"
  | "rose-pine"
  | "rose-pine-dawn"
  | "vesper";

export type Palette = {
  id: ThemeId;
  label: string;
  scheme: "dark" | "light";
  sibling?: ThemeId;
  bg: string;
  bgTerm: string;
  surface: string;
  surface2: string;
  fg: string;
  muted: string;
  subtle: string;
  accent: string;
  accentFg: string;
  border: string;
  borderStrong: string;
  blocked: string;
  blockedFg: string;
  working: string;
  workingFg: string;
  done: string;
  doneFg: string;
  term: string;
};

/** Quiet app palettes alongside the original Herdr built-ins. */
export const THEMES: Record<ThemeId, Palette> = {
  "moshpit-light": {
    id: "moshpit-light",
    label: "moshpit light",
    scheme: "light",
    sibling: "moshpit-dark",
    bg: "#faf9f6",
    bgTerm: "#f3f2ee",
    surface: "#f1f0eb",
    surface2: "#e8e7e0",
    fg: "#292c27",
    muted: "#686b61",
    subtle: "#777b70",
    accent: "#416349",
    accentFg: "#ffffff",
    border: "#e4e4dc",
    borderStrong: "#cdcec3",
    blocked: "#97621e",
    blockedFg: "#ffffff",
    working: "#416349",
    workingFg: "#ffffff",
    done: "#57717e",
    doneFg: "#ffffff",
    term: "#343a31",
  },
  "moshpit-dark": {
    id: "moshpit-dark",
    label: "moshpit dark",
    scheme: "dark",
    sibling: "moshpit-light",
    bg: "#222420",
    bgTerm: "#1b1d19",
    surface: "#1c1e1a",
    surface2: "#30332c",
    fg: "#eeeee6",
    muted: "#b4b7a9",
    subtle: "#939787",
    accent: "#b5c9a0",
    accentFg: "#22291c",
    border: "#35382f",
    borderStrong: "#505447",
    blocked: "#dfb574",
    blockedFg: "#292216",
    working: "#b5c9a0",
    workingFg: "#22291c",
    done: "#a3b8c0",
    doneFg: "#222420",
    term: "#dce1d2",
  },
  catppuccin: {
    id: "catppuccin",
    label: "catppuccin",
    scheme: "dark",
    sibling: "catppuccin-latte",
    bg: "#1e1e2e",
    bgTerm: "#11111b",
    surface: "#181825",
    surface2: "#313244",
    fg: "#cdd6f4",
    muted: "#a6adc8",
    subtle: "#6c7086",
    accent: "#a6e3a1",
    accentFg: "#11111b",
    border: "#313244",
    borderStrong: "#45475a",
    blocked: "#f9e2af",
    blockedFg: "#1e1e2e",
    working: "#a6e3a1",
    workingFg: "#11111b",
    done: "#89b4fa",
    doneFg: "#11111b",
    term: "#cdd6f4",
  },
  "catppuccin-latte": {
    id: "catppuccin-latte",
    label: "catppuccin-latte",
    scheme: "light",
    sibling: "catppuccin",
    bg: "#eff1f5",
    bgTerm: "#e6e9ef",
    surface: "#e6e9ef",
    surface2: "#ccd0da",
    fg: "#4c4f69",
    muted: "#6c6f85",
    subtle: "#9ca0b0",
    accent: "#40a02b",
    accentFg: "#eff1f5",
    border: "#ccd0da",
    borderStrong: "#bcc0cc",
    blocked: "#df8e1d",
    blockedFg: "#eff1f5",
    working: "#40a02b",
    workingFg: "#eff1f5",
    done: "#1e66f5",
    doneFg: "#eff1f5",
    term: "#4c4f69",
  },
  "tokyo-night": {
    id: "tokyo-night",
    label: "tokyo-night",
    scheme: "dark",
    sibling: "tokyo-night-day",
    bg: "#1a1b26",
    bgTerm: "#16161e",
    surface: "#16161e",
    surface2: "#292e42",
    fg: "#c0caf5",
    muted: "#a9b1d6",
    subtle: "#565f89",
    accent: "#9ece6a",
    accentFg: "#16161e",
    border: "#292e42",
    borderStrong: "#3b4261",
    blocked: "#e0af68",
    blockedFg: "#16161e",
    working: "#9ece6a",
    workingFg: "#16161e",
    done: "#7aa2f7",
    doneFg: "#16161e",
    term: "#c0caf5",
  },
  "tokyo-night-day": {
    id: "tokyo-night-day",
    label: "tokyo-night-day",
    scheme: "light",
    sibling: "tokyo-night",
    bg: "#e1e2e7",
    bgTerm: "#d0d5e3",
    surface: "#d5d6db",
    surface2: "#c4c8da",
    fg: "#3760bf",
    muted: "#6172b0",
    subtle: "#848cb5",
    accent: "#387068",
    accentFg: "#e1e2e7",
    border: "#c4c8da",
    borderStrong: "#a8aecb",
    blocked: "#8c6c3e",
    blockedFg: "#e1e2e7",
    working: "#387068",
    workingFg: "#e1e2e7",
    done: "#2e7de9",
    doneFg: "#e1e2e7",
    term: "#3760bf",
  },
  dracula: {
    id: "dracula",
    label: "dracula",
    scheme: "dark",
    bg: "#282a36",
    bgTerm: "#21222c",
    surface: "#21222c",
    surface2: "#44475a",
    fg: "#f8f8f2",
    muted: "#bfbfbf",
    subtle: "#6272a4",
    accent: "#50fa7b",
    accentFg: "#21222c",
    border: "#44475a",
    borderStrong: "#6272a4",
    blocked: "#f1fa8c",
    blockedFg: "#21222c",
    working: "#50fa7b",
    workingFg: "#21222c",
    done: "#8be9fd",
    doneFg: "#21222c",
    term: "#f8f8f2",
  },
  nord: {
    id: "nord",
    label: "nord",
    scheme: "dark",
    bg: "#2e3440",
    bgTerm: "#2e3440",
    surface: "#3b4252",
    surface2: "#434c5e",
    fg: "#eceff4",
    muted: "#d8dee9",
    subtle: "#7b88a1",
    accent: "#a3be8c",
    accentFg: "#2e3440",
    border: "#434c5e",
    borderStrong: "#4c566a",
    blocked: "#ebcb8b",
    blockedFg: "#2e3440",
    working: "#a3be8c",
    workingFg: "#2e3440",
    done: "#88c0d0",
    doneFg: "#2e3440",
    term: "#eceff4",
  },
  gruvbox: {
    id: "gruvbox",
    label: "gruvbox",
    scheme: "dark",
    sibling: "gruvbox-light",
    bg: "#282828",
    bgTerm: "#1d2021",
    surface: "#1d2021",
    surface2: "#3c3836",
    fg: "#ebdbb2",
    muted: "#d5c4a1",
    subtle: "#928374",
    accent: "#b8bb26",
    accentFg: "#1d2021",
    border: "#3c3836",
    borderStrong: "#504945",
    blocked: "#fabd2f",
    blockedFg: "#1d2021",
    working: "#b8bb26",
    workingFg: "#1d2021",
    done: "#83a598",
    doneFg: "#1d2021",
    term: "#ebdbb2",
  },
  "gruvbox-light": {
    id: "gruvbox-light",
    label: "gruvbox-light",
    scheme: "light",
    sibling: "gruvbox",
    bg: "#fbf1c7",
    bgTerm: "#f9f5d7",
    surface: "#f2e5bc",
    surface2: "#ebdbb2",
    fg: "#3c3836",
    muted: "#504945",
    subtle: "#928374",
    accent: "#79740e",
    accentFg: "#fbf1c7",
    border: "#d5c4a1",
    borderStrong: "#bdae93",
    blocked: "#b57614",
    blockedFg: "#fbf1c7",
    working: "#79740e",
    workingFg: "#fbf1c7",
    done: "#076678",
    doneFg: "#fbf1c7",
    term: "#3c3836",
  },
  "one-dark": {
    id: "one-dark",
    label: "one-dark",
    scheme: "dark",
    sibling: "one-light",
    bg: "#282c34",
    bgTerm: "#21252b",
    surface: "#21252b",
    surface2: "#3e4451",
    fg: "#abb2bf",
    muted: "#9da5b4",
    subtle: "#5c6370",
    accent: "#98c379",
    accentFg: "#21252b",
    border: "#3e4451",
    borderStrong: "#4b5263",
    blocked: "#e5c07b",
    blockedFg: "#21252b",
    working: "#98c379",
    workingFg: "#21252b",
    done: "#61afef",
    doneFg: "#21252b",
    term: "#abb2bf",
  },
  "one-light": {
    id: "one-light",
    label: "one-light",
    scheme: "light",
    sibling: "one-dark",
    bg: "#fafafa",
    bgTerm: "#f0f0f0",
    surface: "#f0f0f0",
    surface2: "#e5e5e6",
    fg: "#383a42",
    muted: "#696c77",
    subtle: "#a0a1a7",
    accent: "#50a14f",
    accentFg: "#fafafa",
    border: "#e5e5e6",
    borderStrong: "#d0d0d1",
    blocked: "#c18401",
    blockedFg: "#fafafa",
    working: "#50a14f",
    workingFg: "#fafafa",
    done: "#4078f2",
    doneFg: "#fafafa",
    term: "#383a42",
  },
  solarized: {
    id: "solarized",
    label: "solarized",
    scheme: "dark",
    sibling: "solarized-light",
    bg: "#002b36",
    bgTerm: "#002b36",
    surface: "#073642",
    surface2: "#094352",
    fg: "#93a1a1",
    muted: "#839496",
    subtle: "#657b83",
    accent: "#859900",
    accentFg: "#002b36",
    border: "#094352",
    borderStrong: "#586e75",
    blocked: "#b58900",
    blockedFg: "#002b36",
    working: "#859900",
    workingFg: "#002b36",
    done: "#268bd2",
    doneFg: "#002b36",
    term: "#93a1a1",
  },
  "solarized-light": {
    id: "solarized-light",
    label: "solarized-light",
    scheme: "light",
    sibling: "solarized",
    bg: "#fdf6e3",
    bgTerm: "#eee8d5",
    surface: "#eee8d5",
    surface2: "#e6ddc4",
    fg: "#657b83",
    muted: "#586e75",
    subtle: "#93a1a1",
    accent: "#859900",
    accentFg: "#fdf6e3",
    border: "#e6ddc4",
    borderStrong: "#93a1a1",
    blocked: "#b58900",
    blockedFg: "#fdf6e3",
    working: "#859900",
    workingFg: "#fdf6e3",
    done: "#268bd2",
    doneFg: "#fdf6e3",
    term: "#657b83",
  },
  kanagawa: {
    id: "kanagawa",
    label: "kanagawa",
    scheme: "dark",
    sibling: "kanagawa-lotus",
    bg: "#1f1f28",
    bgTerm: "#16161d",
    surface: "#16161d",
    surface2: "#2a2a37",
    fg: "#dcd7ba",
    muted: "#c8c093",
    subtle: "#727169",
    accent: "#98bb6c",
    accentFg: "#16161d",
    border: "#2a2a37",
    borderStrong: "#363646",
    blocked: "#e6c384",
    blockedFg: "#16161d",
    working: "#98bb6c",
    workingFg: "#16161d",
    done: "#7e9cd8",
    doneFg: "#16161d",
    term: "#dcd7ba",
  },
  "kanagawa-lotus": {
    id: "kanagawa-lotus",
    label: "kanagawa-lotus",
    scheme: "light",
    sibling: "kanagawa",
    bg: "#f2ecbc",
    bgTerm: "#e7dba0",
    surface: "#e7dba0",
    surface2: "#d5cea3",
    fg: "#545464",
    muted: "#6e6e80",
    subtle: "#8a8980",
    accent: "#6f894e",
    accentFg: "#f2ecbc",
    border: "#d5cea3",
    borderStrong: "#c9c0a5",
    blocked: "#cc6d00",
    blockedFg: "#f2ecbc",
    working: "#6f894e",
    workingFg: "#f2ecbc",
    done: "#4d699b",
    doneFg: "#f2ecbc",
    term: "#545464",
  },
  "rose-pine": {
    id: "rose-pine",
    label: "rose-pine",
    scheme: "dark",
    sibling: "rose-pine-dawn",
    bg: "#191724",
    bgTerm: "#1f1d2e",
    surface: "#1f1d2e",
    surface2: "#26233a",
    fg: "#e0def4",
    muted: "#908caa",
    subtle: "#6e6a86",
    accent: "#31748f",
    accentFg: "#e0def4",
    border: "#26233a",
    borderStrong: "#403d52",
    blocked: "#f6c177",
    blockedFg: "#191724",
    working: "#9ccfd8",
    workingFg: "#191724",
    done: "#c4a7e7",
    doneFg: "#191724",
    term: "#e0def4",
  },
  "rose-pine-dawn": {
    id: "rose-pine-dawn",
    label: "rose-pine-dawn",
    scheme: "light",
    sibling: "rose-pine",
    bg: "#faf4ed",
    bgTerm: "#fffaf3",
    surface: "#fffaf3",
    surface2: "#f2e9e1",
    fg: "#575279",
    muted: "#797593",
    subtle: "#9893a5",
    accent: "#286983",
    accentFg: "#faf4ed",
    border: "#f2e9e1",
    borderStrong: "#dfdad9",
    blocked: "#ea9d34",
    blockedFg: "#faf4ed",
    working: "#56949f",
    workingFg: "#faf4ed",
    done: "#907aa9",
    doneFg: "#faf4ed",
    term: "#575279",
  },
  vesper: {
    id: "vesper",
    label: "vesper",
    scheme: "dark",
    bg: "#101010",
    bgTerm: "#0a0a0a",
    surface: "#141414",
    surface2: "#1c1c1c",
    fg: "#ffffff",
    muted: "#a0a0a0",
    subtle: "#505050",
    accent: "#99ffe4",
    accentFg: "#101010",
    border: "#1c1c1c",
    borderStrong: "#2a2a2a",
    blocked: "#ffc799",
    blockedFg: "#101010",
    working: "#99ffe4",
    workingFg: "#101010",
    done: "#a0a0a0",
    doneFg: "#101010",
    term: "#ffffff",
  },
};

export const THEME_LIST = Object.values(THEMES);

export const DEFAULT_THEME: ThemeId = "moshpit-dark";

export function isThemeId(v: string | undefined): v is ThemeId {
  return !!v && v in THEMES;
}

export function resolveTheme(
  name: ThemeId,
  autoSwitch: boolean,
  prefersDark: boolean,
): Palette {
  const base = THEMES[name] ?? THEMES[DEFAULT_THEME];
  if (!autoSwitch || !base.sibling) return base;
  const a = base;
  const b = THEMES[base.sibling];
  const dark = a.scheme === "dark" ? a : b;
  const light = a.scheme === "light" ? a : b;
  return prefersDark ? dark : light;
}

export function paintTheme(palette: Palette) {
  const root = document.documentElement;
  root.dataset.theme = palette.id;
  root.style.colorScheme = palette.scheme;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--color-bg", palette.bg);
  set("--color-bg-term", palette.bgTerm);
  set("--color-surface", palette.surface);
  set("--color-surface-2", palette.surface2);
  set("--color-fg", palette.fg);
  set("--color-muted", palette.muted);
  set("--color-subtle", palette.subtle);
  set("--color-accent", palette.accent);
  set("--color-accent-fg", palette.accentFg);
  set("--color-border", palette.border);
  set("--color-border-strong", palette.borderStrong);
  set("--color-blocked", palette.blocked);
  set("--color-blocked-fg", palette.blockedFg);
  set("--color-working", palette.working);
  set("--color-working-fg", palette.workingFg);
  set("--color-done", palette.done);
  set("--color-done-fg", palette.doneFg);
  set("--color-term", palette.term);
  const dark = palette.scheme === "dark";
  const ansi = [
    dark ? "#484b45" : "#343a31",
    dark ? "#ef9a94" : "#b13c3f",
    palette.working,
    palette.blocked,
    palette.done,
    dark ? "#cfabe0" : "#82519a",
    dark ? "#8ac9c6" : "#287673",
    palette.term,
    palette.muted,
    dark ? "#ffb0a9" : "#a22b31",
    palette.working,
    palette.blocked,
    palette.done,
    dark ? "#dfb9ef" : "#78428f",
    dark ? "#a4dedb" : "#1b6c69",
    palette.fg,
  ];
  ansi.forEach((color, index) => set(`--ansi-${index}`, color));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", palette.bg);
}
