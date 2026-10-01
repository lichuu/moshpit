// herdr names panes by harness, not product: "claude" means Claude Code,
// so prefer its logo over the Claude brand mark when the catalog has one.
const ALIASES: Record<string, string> = { claude: "claudecode" };

export function findAgentIcon<T>(catalog: ReadonlyMap<string, T>, name: string): T | undefined {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!slug) return undefined;
  const base = slug.replace(/(?:agent|cli)$/, "");
  return (ALIASES[slug] ? catalog.get(ALIASES[slug]) : undefined) ?? catalog.get(slug) ?? catalog.get(base) ?? catalog.get(`${base}agent`) ?? catalog.get(`${base}cli`);
}
