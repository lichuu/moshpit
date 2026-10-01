import { lazy, Suspense } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

const CatalogAgentIcon = lazy(() => import("./catalog-agent-icon"));

export function AgentIcon({ kind, className }: { kind: string; className?: string }) {
  return <Suspense fallback={<Bot role="img" aria-label={kind || "Agent"} className={cn("size-4 shrink-0", className)} />}>
    <CatalogAgentIcon kind={kind} className={className} />
  </Suspense>;
}
