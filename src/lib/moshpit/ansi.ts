/**
 * SGR-only ANSI parser.
 *
 * `herdr pane read --format ansi` returns an already-rendered grid: one line
 * per visual row, at the pane's real width, with styling reattached. Measured
 * across live panes, the only escape it emits is SGR (`ESC [ ... m`) — no
 * cursor motion, no erases, no scroll regions. So rows need styling applied,
 * not a terminal emulated.
 */

export type Style = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

export type Span = { text: string; style: Style };

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const ANY_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const BASE = Array.from({ length: 16 }, (_, index) => `var(--ansi-${index})`);

// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g;

function hex(n: number) {
  return n.toString(16).padStart(2, "0");
}

/** xterm 256: 0-15 palette, 16-231 a 6x6x6 cube, 232-255 a grey ramp. */
function xterm256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) return BASE[n];
  if (n < 232) {
    const i = n - 16;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `#${hex(step(Math.floor(i / 36) % 6))}${hex(step(Math.floor(i / 6) % 6))}${hex(step(i % 6))}`;
  }
  const g = 8 + (n - 232) * 10;
  return `#${hex(g)}${hex(g)}${hex(g)}`;
}

/** Consumes one SGR parameter run, advancing past any extended-colour tail. */
function applyCode(style: Style, codes: number[], i: number): number {
  const c = codes[i];
  if (c === 0) {
    for (const k of Object.keys(style)) delete style[k as keyof Style];
    return i;
  }
  if (c === 1) style.bold = true;
  else if (c === 2) style.dim = true;
  else if (c === 3) style.italic = true;
  else if (c === 4) style.underline = true;
  else if (c === 9) style.strike = true;
  else if (c === 22) {
    delete style.bold;
    delete style.dim;
  } else if (c === 23) delete style.italic;
  else if (c === 24) delete style.underline;
  else if (c === 29) delete style.strike;
  else if (c >= 30 && c <= 37) style.fg = BASE[c - 30];
  else if (c >= 90 && c <= 97) style.fg = BASE[c - 90 + 8];
  else if (c >= 40 && c <= 47) style.bg = BASE[c - 40];
  else if (c >= 100 && c <= 107) style.bg = BASE[c - 100 + 8];
  else if (c === 39) delete style.fg;
  else if (c === 49) delete style.bg;
  else if (c === 38 || c === 48) {
    const target = c === 38 ? "fg" : "bg";
    if (codes[i + 1] === 2) {
      const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
      if (r !== undefined && g !== undefined && b !== undefined) {
        style[target] = `#${hex(r & 255)}${hex(g & 255)}${hex(b & 255)}`;
      }
      return i + 4;
    }
    if (codes[i + 1] === 5) {
      const c256 = xterm256(codes[i + 2]);
      if (c256) style[target] = c256;
      return i + 2;
    }
  }
  return i;
}

/** Inverse (SGR 7) is how panes paint their own cursor cell. */
function emit(out: Span[], text: string, style: Style, inverse: boolean) {
  if (!text) return;
  const next: Style = { ...style };
  if (inverse) {
    next.fg = style.bg ?? "var(--color-bg-term, #11111b)";
    next.bg = style.fg ?? "var(--color-term, #cdd6f4)";
  }
  const last = out[out.length - 1];
  // Runs split by a no-op SGR are visually one span; merging keeps the DOM small.
  if (last && shallowEqual(last.style, next)) last.text += text;
  else out.push({ text, style: next });
}

function shallowEqual(a: Style, b: Style) {
  const ka = Object.keys(a) as (keyof Style)[];
  const kb = Object.keys(b) as (keyof Style)[];
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Split one rendered row into styled spans. */
export function toSpans(line: string): Span[] {
  line = line.replace(OSC, "").replace(ANY_ESCAPE, (escape) => escape.endsWith("m") ? escape : "");
  const out: Span[] = [];
  const style: Style = {};
  let inverse = false;
  let at = 0;
  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(line))) {
    emit(out, line.slice(at, m.index), style, inverse);
    at = m.index + m[0].length;
    const codes = (m[1] === "" ? "0" : m[1]).split(";").map((n) => Number(n) || 0);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 7) inverse = true;
      else if (codes[i] === 27) inverse = false;
      else if (codes[i] === 0) inverse = false;
      i = applyCode(style, codes, i);
    }
  }
  emit(out, line.slice(at), style, inverse);
  return out;
}

/** Visible text of a row, for width maths and copy. */
export function stripAnsi(s: string): string {
  return s.replace(OSC, "").replace(ANY_ESCAPE, "");
}

/**
 * Where the pane's cursor is.
 *
 * `pane.read` carries no cursor position, but two signals in the render give
 * it away, and both were measured against live panes rather than guessed:
 *
 *  1. Panes that draw their own cursor emit a real inverse-video cell (SGR 7).
 *     pi does this. It is authoritative, so it wins.
 *  2. Agents that leave the cursor to the terminal draw a prompt row instead,
 *     inside a box. Claude renders "\u276f" + U+00A0 + text; the cursor sits one
 *     cell past that text. Only the tail is scanned so prose beginning with
 *     ">" cannot be mistaken for the composer.
 */

const PROMPT_ROW = /^([\u276f>\u203a\u279c])(?:[ \u00a0])?(.*)$/u;
const TAIL_ROWS = 12;

/** Visible column where inverse video turns on, or -1. */
function inverseColumn(line: string): number {
  const style: Style = {};
  let inverse = false;
  let col = 0;
  let at = 0;
  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(line))) {
    col += [...line.slice(at, m.index)].length;
    at = m.index + m[0].length;
    const codes = (m[1] === "" ? "0" : m[1]).split(";").map((n) => Number(n) || 0);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 7) inverse = true;
      else if (codes[i] === 27 || codes[i] === 0) inverse = false;
      // Skips the parameters of 38/48 so a truecolor blue of 7 never reads as
      // inverse -- "38;2;255;193;7" is a colour, not a cursor.
      i = applyCode(style, codes, i);
    }
    if (inverse) return col;
  }
  return -1;
}

/** 1-based row and column, or null when the pane reveals nothing. */
export function findCursor(lines: string[]): { row: number; col: number } | null {
  for (let r = 0; r < lines.length; r++) {
    const col = inverseColumn(lines[r]);
    if (col >= 0) return { row: r + 1, col: col + 1 };
  }
  const from = Math.max(0, lines.length - TAIL_ROWS);
  for (let r = lines.length - 1; r >= from; r--) {
    const text = stripAnsi(lines[r]).replace(/[\s\u00a0]+$/u, "");
    if (!text) continue;
    const m = PROMPT_ROW.exec(text);
    if (m) return { row: r + 1, col: 2 + [...m[2]].length + 1 };
  }
  return null;
}
