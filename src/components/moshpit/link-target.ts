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
