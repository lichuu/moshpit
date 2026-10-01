import { Bot } from "lucide-react";
import { findAgentIcon } from "@/lib/moshpit/icon-lookup";
import { cn } from "@/lib/utils";

const sources = import.meta.glob<string>([
  "/node_modules/@lobehub/icons-static-svg/icons/*.svg",
  "!/node_modules/@lobehub/icons-static-svg/icons/*-*.svg",
], { eager: true, query: "?raw", import: "default" });
const catalog = new Map(Object.entries(sources).map(([path, svg]) => [
  path.slice(path.lastIndexOf("/") + 1, -4),
  `data:image/svg+xml,${encodeURIComponent(svg)}`,
]));

export default function CatalogAgentIcon({ kind, className }: { kind: string; className?: string }) {
  const icon = findAgentIcon(catalog, kind);
  if (!icon) return <Bot data-agent-kind={kind} data-icon-fallback="true" role="img" aria-label={kind || "Agent"} className={cn("size-4 shrink-0", className)} />;
  return <span
    data-agent-kind={kind}
    role="img"
    aria-label={kind}
    title={kind}
    className={cn("inline-block size-4 shrink-0 bg-current", className)}
    style={{ mask: `url("${icon}") center / contain no-repeat`, WebkitMask: `url("${icon}") center / contain no-repeat` }}
  />;
}
