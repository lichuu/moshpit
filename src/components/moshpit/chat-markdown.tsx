import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "./styled-output";
import { UploadedImage } from "./uploaded-image";

export function linkTarget(href: string | undefined): "anchor" | "image" | "inert" {
  if (!href) return "inert";
  if (href.startsWith("/api/upload?path=")) return "image";
  try {
    const url = new URL(href);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return "anchor";
  } catch {
    return "inert";
  }
  return "inert";
}

export default function ChatMarkdown({ text }: { text: string }) {
  // The bridge includes this marker in both native submissions and legacy prompts.
  const content = text.replace(/Attached image on this machine: ("(?:[^"\\\r\n]|\\.)*")\r?\nOpen this file to view the image\./g, (marker: string, quoted: string) => {
    try {
      const filename: unknown = JSON.parse(quoted);
      return typeof filename === "string"
        ? `![Uploaded image](/api/upload?${new URLSearchParams({ path: filename })})`
        : marker;
    } catch { return marker; }
  });
  return <div className="chat-markdown min-w-0 whitespace-normal">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      code: ({ className, children }) => {
        const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
        return typeof children === "string"
          ? <HighlightedCode code={children} language={language} />
          : <code>{children}</code>;
      },
      a: ({ href, children }) => {
        if (linkTarget(href) !== "anchor") return <code>{children}</code>;
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      img: ({ src, alt }) => {
        if (linkTarget(src) === "image") return <UploadedImage key={src} src={src ?? ""} alt={alt || "Uploaded image"} />;
        if (linkTarget(src) === "anchor") return <a href={src} target="_blank" rel="noopener noreferrer">{alt || "View image"}</a>;
        return <code>{alt || src}</code>;
      },
    }}>{content}</Markdown>
  </div>;
}
