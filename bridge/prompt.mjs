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
const CLAUDE_FOOTER = /^enter to select\s*(?:·\s*)?(?:tab\/arrow keys to navigate|arrow keys to navigate|arrows to navigate|↑\/↓ to navigate|↑↓ to navigate)\s*(?:·\s*)?esc to cancel$/iu;
const compact = (text) => text.replace(/\s+/gu, " ").trim();
const claudeSignature = (lines) => createHash("sha256").update(lines.map((line) => compact(line.replace(/^\s*❯\s*/u, ""))).join("\n")).digest("hex");

function inspectClaudeReview(lines) {
  const title = lines.findLastIndex((line) => line.trim() === "Review your answers");
  if (title < 0) return null;
  const card = lines.slice(title).map((line) => line.trim()).filter(Boolean);
  const ready = card.indexOf("Ready to submit your answers?");
  if (ready < 1 || card.includes("You have not answered all questions")) return null;
  const rows = card.slice(ready + 1);
  if (rows.length !== 2 || !/^❯?\s*1\. Submit answers$/u.test(rows[0]) || !/^❯?\s*2\. Cancel$/u.test(rows[1])) return null;
  if (rows.filter((line) => line.startsWith("❯")).length !== 1) return null;
  const tabs = lines.slice(0, title).findLast((line) => /[☐☑]/u.test(line));
  if (!tabs || tabs.includes("☐") || !tabs.includes("Submit")) return null;
  return {
    kind: "choose",
    family: "claude-ask-user-review-v1",
    question: "Ready to submit your answers?",
    step: null,
    options: [{ key: "1", label: "Submit answers" }],
    signature: claudeSignature(lines),
  };
}

function inspectClaude(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  if (!CLAUDE_FOOTER.test(lines[end - 1]?.trim() ?? "")) return null;
  const first = lines.findLastIndex((line) => NUMBERED.exec(line)?.[1] === "1");
  if (first < 1) return null;
  const options = [];
  let pointerRows = 0;
  let other = false;
  let chat = false;
  for (let i = first; i < end - 1; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const row = NUMBERED.exec(line);
    if (row) {
      if (Number(row[1]) !== options.length + (other ? 2 : 1)) return null;
      if (row[2] === "Type something.") {
        if (other || options.length < 2 || options.length > 4 || line.includes("❯")) return null;
        other = true;
      } else if (row[2] === "Chat about this") {
        if (!other || chat || line.includes("❯")) return null;
        chat = true;
      } else {
        if (other || /[☐☑▢✓]/u.test(row[2])) return null;
        if (line.includes("❯")) pointerRows++;
        options.push({ key: row[1], label: row[2], description: "" });
      }
      continue;
    }
    if (other || !options.length || /[❯☐☑▢✓]/u.test(line) || !/^\s+\S/u.test(line)) return null;
    options.at(-1).description = compact(`${options.at(-1).description} ${line}`);
  }
  if (!other || !chat || pointerRows !== 1) return null;
  let start = first;
  while (start > 0 && !lines[start - 1].trim()) start--;
  let questionStart = start;
  while (questionStart > 0 && lines[questionStart - 1].trim()) questionStart--;
  const question = compact(lines.slice(questionStart, start).join(" "));
  if (!question || /[☐☑]/u.test(question)) return null;
  return {
    kind: "choose",
    family: "claude-ask-user-question-v1",
    question,
    step: null,
    options,
    signature: claudeSignature(lines.slice(0, end)),
  };
}

const MULTI_FAMILY = "claude-ask-user-multiselect-v1";
const MULTI_FOOTER = /^enter to select · ↑\/↓ to navigate · esc to cancel$/iu;
const MULTI_TAB = /^←\s+([☐☒])\s+(\S+)\s+✔\s+Submit\s+→$/u;
const MULTI_CHECK = /^\s*(❯)?\s*(\d+)\.\s+\[( |✔)\](?:\s+(\S.*?))?\s*$/u;
const MULTI_CHAT = /^\s*(❯)?\s*(\d+)\.\s+Chat about this\s*$/u;
const MULTI_DESC = /^(\s{2,}\S.*?)\s*$/u;
const MULTI_REVIEW_Q = /^●\s+(\S.*?)\s*$/u;
const MULTI_REVIEW_A = /^→\s+(\S.*?)\s*$/u;
const MULTI_SUBMIT = /^\s*(❯)?\s*(\d+)\.\s+Submit answers\s*$/u;
const MULTI_CANCEL = /^\s*(❯)?\s*(\d+)\.\s+Cancel\s*$/u;

function dialogSignature(parts) {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function lastContent(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end);
}

function inspectClaudeMultiSelect(lines) {
  const card = lastContent(lines);
  if (!MULTI_FOOTER.test(compact(card.at(-1) ?? ""))) return null;
  let tabAt = -1;
  let tabs = 0;
  for (let i = 0; i < card.length; i++) {
    if (MULTI_TAB.test(card[i].trim())) {
      tabs++;
      tabAt = i;
    }
  }
  if (tabs !== 1) return null;
  const tab = MULTI_TAB.exec(card[tabAt].trim());
  if (!tab) return null;
  const rows = [];
  let chat = null;
  let questionLines = [];
  let started = false;
  for (let i = tabAt + 1; i < card.length - 1; i++) {
    const line = card[i];
    if (!line.trim()) {
      if (!started) continue;
      continue;
    }
    const check = MULTI_CHECK.exec(line);
    if (check) {
      started = true;
      rows.push({
        pointer: Boolean(check[1]),
        key: check[2],
        checked: check[3] === "✔",
        label: check[4] ?? "",
        description: "",
      });
      continue;
    }
    const chatRow = MULTI_CHAT.exec(line);
    if (chatRow && started) {
      chat = { pointer: Boolean(chatRow[1]), key: chatRow[2] };
      continue;
    }
    if (started && rows.length && MULTI_DESC.test(line) && !line.includes("❯")) {
      rows.at(-1).description = compact(`${rows.at(-1).description} ${line}`);
      continue;
    }
    if (started) return null;
    questionLines.push(line.trim());
  }
  const options = rows.filter((row) => row.label !== "Type something");
  const other = rows.find((row) => row.label === "Type something");
  if (options.length !== 2 || !other || other.checked || other.pointer || !chat || chat.pointer) return null;
  if (rows.length !== 3) return null;
  const keys = [...options.map((row) => row.key), other.key, chat.key];
  if (keys.some((key, index) => key !== String(index + 1))) return null;
  if (options.some((row) => !row.label)) return null;
  const pointed = options.filter((row) => row.pointer);
  if (pointed.length !== 1) return null;
  const question = compact(questionLines.join(" "));
  if (!question || !question.includes("?")) return null;
  const header = tab[2];
  const answers = options.filter((row) => row.checked).map((row) => row.label);
  const questionId = question;
  return {
    kind: "questions",
    family: MULTI_FAMILY,
    phase: "select",
    questions: [{
      id: questionId,
      header,
      question,
      multiSelect: true,
      options: options.map((row) => ({
        key: row.key,
        label: row.label,
        description: row.description,
        checked: row.checked,
      })),
      other: { key: other.key, label: other.label, text: "", multiline: false },
    }],
    answers: { [questionId]: answers },
    focus: { kind: "option", key: pointed[0].key },
    actions: ["toggle", "review"],
    signature: dialogSignature([
      MULTI_FAMILY,
      "select",
      header,
      question,
      ...options.map((row) => `${row.key}|${row.label}|${row.checked ? "1" : "0"}|${row.description}`),
      `other|${other.key}`,
      `focus|${pointed[0].key}`,
    ]),
  };
}

function inspectClaudeMultiReview(lines) {
  const card = lastContent(lines);
  if (!MULTI_CANCEL.test(card.at(-1) ?? "")) return null;
  const submit = MULTI_SUBMIT.exec(card.at(-2) ?? "");
  const cancel = MULTI_CANCEL.exec(card.at(-1) ?? "");
  if (!submit || !cancel) return null;
  if (Boolean(submit[1]) === Boolean(cancel[1])) return null;
  if (submit[2].length !== 1 || cancel[2].length !== 1) return null;
  const title = card.findIndex((line) => line.trim() === "Review your answers");
  const ready = card.findIndex((line) => line.trim() === "Ready to submit your answers?");
  let tabAt = -1;
  let tabs = 0;
  for (let i = 0; i < card.length; i++) {
    if (MULTI_TAB.test(card[i].trim())) {
      tabs++;
      tabAt = i;
    }
  }
  if (tabs !== 1 || title < 0 || ready < title) return null;
  const tab = MULTI_TAB.exec(card[tabAt].trim());
  if (!tab || tab[1] !== "☒") return null;
  let question = "";
  let answerLine = "";
  let askedCount = 0;
  let answerCount = 0;
  for (let i = title + 1; i < ready; i++) {
    const line = card[i].trim();
    if (!line) continue;
    const asked = MULTI_REVIEW_Q.exec(line);
    if (asked) {
      askedCount++;
      question = asked[1];
      continue;
    }
    const answered = MULTI_REVIEW_A.exec(line);
    if (answered) {
      answerCount++;
      answerLine = answered[1];
      continue;
    }
    return null;
  }
  if (askedCount !== 1 || answerCount !== 1 || !question.includes("?") || !answerLine) return null;
  if (card.slice(ready + 1, -2).some((line) => line.trim())) return null;
  const labels = answerLine.split(",").map((label) => label.trim()).filter(Boolean);
  if (!labels.length || new Set(labels).size !== labels.length) return null;
  const questionId = question;
  const focusKey = submit[1] ? submit[2] : cancel[2];
  return {
    kind: "questions",
    family: MULTI_FAMILY,
    phase: "review",
    questions: [{
      id: questionId,
      header: tab[2],
      question,
      multiSelect: true,
      options: [],
      other: null,
    }],
    answers: { [questionId]: labels },
    focus: { kind: submit[1] ? "submit" : "cancel", key: focusKey },
    submitKey: submit[2],
    actions: ["submit"],
    signature: dialogSignature([
      MULTI_FAMILY,
      "review",
      tab[2],
      question,
      labels.join("|"),
      `submit|${submit[2]}`,
      `cancel|${cancel[2]}`,
      `focus|${focusKey}`,
    ]),
  };
}

export function planQuestionWrite(dialog, op) {
  if (dialog?.family !== MULTI_FAMILY || !op || typeof op !== "object") return null;
  if (op.op === "toggle" && dialog.phase === "select" && dialog.actions.includes("toggle")) {
    const question = dialog.questions.find((item) => item.id === op.questionId);
    const option = question?.options.find((item) => item.key === op.optionKey);
    if (!question || !option || option.key.length !== 1) return null;
    return { key: option.key };
  }
  if (op.op === "review" && dialog.phase === "select" && dialog.actions.includes("review")) return { key: "right" };
  if (op.op === "submit" && dialog.phase === "review" && dialog.actions.includes("submit") && typeof dialog.submitKey === "string" && dialog.submitKey.length === 1) {
    return { key: dialog.submitKey };
  }
  return null;
}

export function inspectAnswerDialog(kind, dump) {
  const raw = String(dump ?? "");
  if ((kind === "claude" || kind === "claude-code") && Buffer.byteLength(raw, "utf8") <= 32 * 1024) {
    const lines = normalize(raw);
    if (lines.length <= 128) {
      const inspected = inspectClaudeMultiReview(lines) ?? inspectClaudeMultiSelect(lines) ?? inspectClaudeReview(lines) ?? inspectClaude(lines);
      if (inspected) return inspected;
    }
  }
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
