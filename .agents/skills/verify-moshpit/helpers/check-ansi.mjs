import assert from "node:assert/strict";
import { toSpans, stripAnsi } from "../../../../src/lib/moshpit/ansi.ts";

assert.equal(toSpans("\x1b[31merror")[0].style.fg, "var(--ansi-1)");
assert.equal(toSpans("\x1b[38;5;4mblue")[0].style.fg, "var(--ansi-4)");
assert.equal(toSpans("\x1b[38;5;196mred")[0].style.fg, "#ff0000");
assert.equal(toSpans("\x1b[38;2;12;34;56mRGB")[0].style.fg, "#0c2238");
const text = "\x1b[1;3;4;9;32mfirst\n  second\x1b[0m\nlast";
const spans = toSpans(text);
assert.deepEqual(spans[0].style, { bold: true, italic: true, underline: true, strike: true, fg: "var(--ansi-2)" });
assert.deepEqual(spans.at(-1).style, {});
assert.equal(spans.map(span => span.text).join(""), "first\n  second\nlast");
assert.equal(toSpans("\x1b[7minverse")[0].style.bg, "var(--color-term, #cdd6f4)");
const control = "\x1b]8;;javascript:alert(1)\x07literal\x1b]8;;\x07\x1b[2K <script>alert(1)</script>";
assert.equal(stripAnsi(control), "literal <script>alert(1)</script>");
assert.equal(toSpans(control).map(span => span.text).join(""), stripAnsi(control));
console.log("ok   themed ANSI16, exact extended colors, multiline styles/reset, inverse, control stripping, literal HTML");
