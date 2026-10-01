import type { Snippet } from "./types";

export const SNIPPET_LIMITS = {
  count: 100,
  name: 80,
  text: 32768,
} as const;

/** Returns an error message, or null when the pair is saveable. */
export function validateSnippet(name: string, text: string): string | null {
  if (!name.trim()) return "Name is required.";
  // Measured on the trimmed name, because that is what saveSnippet stores:
  // validating the raw value rejected names that fit once trimmed.
  if (name.trim().length > SNIPPET_LIMITS.name)
    return `Name must be ${SNIPPET_LIMITS.name} characters or fewer.`;
  if (!text.trim()) return "Snippet text is required.";
  if (text.length > SNIPPET_LIMITS.text)
    return `Snippet text must be ${SNIPPET_LIMITS.text.toLocaleString("en-US")} characters or fewer.`;
  return null;
}

/**
 * Hydrated snippets are untrusted: an older or hand-edited store may carry
 * malformed entries. Keep only the ones that would pass UI validation.
 * Returns null for a non-array so the caller falls back to the default.
 */
export function sanitizeSnippets(raw: unknown): Snippet[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Snippet[] = [];
  // Ids address a snippet for edit and delete, so a duplicate would make
  // saveSnippet rewrite every twin at once. First entry wins.
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Partial<Snippet>;
    if (typeof value.id !== "string" || !value.id || seen.has(value.id)) continue;
    if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > SNIPPET_LIMITS.name) continue;
    if (typeof value.text !== "string" || !value.text.trim() || value.text.length > SNIPPET_LIMITS.text) continue;
    seen.add(value.id);
    out.push({ id: value.id, name: value.name, text: value.text });
    if (out.length >= SNIPPET_LIMITS.count) break;
  }
  return out;
}
