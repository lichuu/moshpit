import { memo, useMemo } from "react";
import { createLowlight } from "lowlight";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import { stripAnsi, toSpans } from "@/lib/moshpit/ansi";

const highlighter = createLowlight({ javascript, typescript, python, bash, json, css, xml, rust, go, sql, diff });
type SyntaxNode = ReturnType<typeof highlighter.highlight>["children"][number];

function syntaxNode(node: SyntaxNode, index: number): React.ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const classes = node.properties.className;
  return <span key={index} className={Array.isArray(classes) ? classes.join(" ") : undefined}>
    {node.children.map(syntaxNode)}
  </span>;
}

export function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const content = useMemo(() => language && highlighter.registered(language)
    ? highlighter.highlight(language, code).children.map(syntaxNode)
    : code, [code, language]);
  return <code className="styled-output" data-language={language}>{content}</code>;
}

function highlightFences(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^[ \t]*(`{3,}|~{3,})([\w+-]+)[ \t]*\r?\n?$/);
    result.push(line);
    if (!fence || !highlighter.registered(fence[2])) continue;
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== fence[1]) end++;
    if (end === lines.length) continue;
    const code = lines.slice(index + 1, end).join("");
    result.push(<span key={index} data-language={fence[2]}>{highlighter.highlight(fence[2], code).children.map(syntaxNode)}</span>);
    index = end - 1;
  }
  return result;
}

export const StyledOutput = memo(function StyledOutput({ text }: { text: string }) {
  const content = useMemo(() => {
    const spans = toSpans(text);
    const styled = spans.some(({ style }) => Object.keys(style).length > 0);
    if (!styled) return highlightFences(stripAnsi(text));
    return spans.map(({ text: value, style }, index) => <span key={index} style={{
      color: style.fg,
      backgroundColor: style.bg,
      fontWeight: style.bold ? 600 : undefined,
      opacity: style.dim ? 0.65 : undefined,
      fontStyle: style.italic ? "italic" : undefined,
      textDecoration: [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ") || undefined,
    }}>{value}</span>);
  }, [text]);
  return <pre className="styled-output m-0 w-full min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-term" aria-label="Agent output">{content}</pre>;
});
