import { createHash } from "node:crypto";

/**
 * Pulling the question out of a blocked pane.
 *
 * `herdr api snapshot` reports that an agent is blocked but not what it asked,
 * so the Inbox row had nothing to show but the terminal title. The shape is not
 * guesswork: herdr ships versioned per-agent detection manifests
 * (`~/.local/state/herdr/agent-detection/`), and its blocked rules for Claude
 * key on "do you want to proceed?" with numbered "1. Yes" / "2. No" choices, or
 * an "❯ Accept" / "Decline" pair for MCP elicitation.
 *
 * Those dialogs are often drawn inside a box, which is why this does not cut on
 * herdr's `after_last_horizontal_rule` region: the box's own bottom border is a
 * horizontal rule, and cutting there throws the question away. Borders are
 * stripped and the choices are located directly instead.
 *
 * It degrades on purpose: an unrecognised dialog yields a question with no
 * options and the client falls back to free text, rather than showing buttons
 * that would send the wrong key.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Box drawing, rules and quote bars — decoration, never content. */
const BORDER = /[─-╿]/gu;
/** "1. Yes", "  2. No, and tell Claude what to do", optionally cursor-marked. */
const NUMBERED = /^\s*❯?\s*(\d+)[.)]\s+(\S.*?)\s*$/u;
/** The cursor line that opens an arrow-selected choice list. */
const SELECTED = /^\s*❯\s*(\S.*?)\s*$/u;
/** Footers and hints that are chrome, not the question. */
const CHROME =
  /^(esc |press |tab |ctrl\+|shift\+|↑|↓|⏵|\/|enter to |[\w.@-]+ ~|mise )|(to confirm|to cancel|to navigate|to interrupt)\s*$/i;
const TAIL = 40;

function normalize(dump) {
  return String(dump ?? "")
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(ANSI, "")
        .replace(/\u00a0/g, " ")
        .replace(BORDER, " ")
        .replace(/[│|]/g, " ")
        .replace(/\s+$/u, ""),
    );
}

/**
 * A choice list is the cursor line plus the non-empty lines under it. Claude
 * draws both numbered dialogs and arrow-selected ones this way, so finding the
 * cursor finds the block in either case.
 */
function choiceBlock(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const head = SELECTED.exec(lines[i]);
    if (!head) continue;
    const items = [head[1]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) break;
      if (CHROME.test(line.trim())) break;
      items.push(line.trim());
    }
    return { at: i, items };
  }
  return null;
}

export function extractPrompt(dump) {
  const lines = normalize(dump).slice(-TAIL);
  const block = choiceBlock(lines);

  const options = [];
  if (block) {
    for (const item of block.items) {
      const numbered = NUMBERED.exec(item);
      // Only a numbered choice has a keystroke we can send verbatim. Arrow
      // driven lists are labelled but not tappable; the client shows the
      // question and routes the answer through Reply.
      if (numbered) options.push({ key: numbered[1], label: numbered[2] });
      else options.push({ key: "", label: item.replace(/^❯\s*/u, "") });
    }
  }

  const above = lines.slice(0, block ? block.at : lines.length);
  let question = "";
  let fallback = "";
  for (let i = above.length - 1; i >= 0; i--) {
    const line = above[i].trim();
    if (!line || CHROME.test(line)) continue;
    // Long questions wrap, so the "?" is often mid-line rather than at the end.
    if (line.includes("?")) {
      question = line;
      break;
    }
    if (!fallback) fallback = line;
  }

  if (!question && !options.length) return null;
  if (!question) question = fallback;
  if (!question) return null;
  return { question: question.slice(0, 300), options: options.slice(0, 6) };
}

/**
 * Codex renders a fixed `Question N/M (X unanswered)` card with a `›` pointer,
 * numbered choices separated from their descriptions by two-plus spaces, and a
 * single navigation footer. The shape is exact, so any deviation — wrong
 * pointer, extra rows, gapped or duplicate keys, trailing chrome — means we
 * do not know which key sends the answer, and the client falls back to the
 * terminal view instead of guessing.
 */
const CODEX_HEADER = /^Question (\d+)\/(\d+) \(\d+ unanswered\)$/u;
const CODEX_OPTION = /^\s*›?\s*(\d+)\.\s+(\S.*?)\s{2,}(\S.*)$/u;
const CODEX_FOOTER = /^tab to add notes\s+enter to submit (?:answer|all)\s+←\/→ to navigate questions\s+esc to interrupt$/u;
const KIND_TERMINAL = "terminal";

export function inspectAnswerDialog(kind, dump) {
  const raw = String(dump ?? "");
  if (kind === "codex" && Buffer.byteLength(raw, "utf8") <= 32 * 1024) {
    const lines = normalize(raw);
    if (lines.length <= 128) {
      let end = lines.length;
      while (end > 0 && !lines[end - 1].trim()) end--;
      const card = lines.slice(0, end);
      const head = CODEX_HEADER.exec(card[0] ?? "");
      const question = (card[1] ?? "").trim();
      if (head && question.includes("?") && card.length >= 5) {
        const options = [];
        let pointerRows = 0;
        let i = 2;
        while (i < card.length - 1) {
          const opt = CODEX_OPTION.exec(card[i]);
          if (!opt) break;
          if (card[i].trimStart().startsWith("›")) pointerRows++;
          options.push({ key: opt[1], label: opt[2], description: opt[3] });
          i++;
        }
        if (i < card.length - 1 && !card[i].trim()) i++;
        const keysOk =
          options.length > 0 && options.every((o, j) => o.key === String(j + 1));
        if (keysOk && pointerRows === 1 && i === card.length - 1 && CODEX_FOOTER.test(card[i].trim())) {
          const canonical =
            [card[0], card[1], ...options.map((o) => `${o.key} ${o.label} ${o.description}`), card[card.length - 1]]
              .join("\n");
          return {
            kind: "choose",
            family: "codex-request-user-input-v1",
            question,
            step: { index: Number(head[1]) - 1, total: Number(head[2]) },
            options,
            signature: createHash("sha256").update(canonical).digest("hex"),
          };
        }
      }
    }
  }
  return { kind: KIND_TERMINAL };
}
