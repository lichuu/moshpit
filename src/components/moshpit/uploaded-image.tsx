import { useEffect, useState } from "react";
import { accessError } from "@/lib/moshpit/access";
import { bridgeUrl, headers } from "@/lib/moshpit/bridge";
import { useMoshpitStore } from "@/lib/moshpit/store";

type Preview = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "failed" };

export function UploadedImage({ src, alt }: { src: string; alt: string }) {
  const host = useMoshpitStore((s) => s.hosts.find((h) => h.id === s.connectedHostId));
  const url = host && !host.demo ? bridgeUrl(host) : "";
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreview({ kind: "loading" });
    async function load() {
      try {
        if (!url) throw new Error("No bridge connected");
        const response = await fetch(`${url}${src}`, { headers: headers(url), redirect: "error", signal: controller.signal });
        if (!response.ok) throw await accessError(response, url, "image");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ kind: "ready", url: objectUrl });
      } catch {
        if (!controller.signal.aborted) setPreview({ kind: "failed" });
      }
    }
    void load();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, src]);
  if (preview.kind !== "ready") return <span role="status" className="text-sm text-muted">{preview.kind === "failed" ? "Image unavailable" : "Loading image…"}</span>;
  return <a href={preview.url} target="_blank" rel="noopener noreferrer" aria-label="Open uploaded image">
    <img src={preview.url} alt={alt} className="my-2 max-h-96 max-w-full rounded-lg object-contain" onError={() => setPreview({ kind: "failed" })} />
  </a>;
}
