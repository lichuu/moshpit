// Downloads a release from GitHub Releases, or from MOSHPIT_RELEASE_API in
// tests. Every response is size-bounded and time-bounded. Nothing here
// trusts what it downloads: the caller checks the executable against its
// manifest before anything runs.

export const DEFAULT_RELEASE_API = "https://api.github.com/repos/lichuu/moshpit";

// A private repository's release assets need a token. It goes to these hosts
// over HTTPS and nowhere else: GitHub redirects an asset download to a
// storage host that must not see it.
export const TOKEN_HOSTS = Object.freeze(["api.github.com", "github.com"]);
const MAX_REDIRECTS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

const KiB = 1024;
const MiB = 1024 * KiB;
export const LIMITS = Object.freeze({
  // The release metadata carries its notes and every asset, so it gets more room than a manifest.
  metadata: { maxBytes: 256 * KiB, timeoutMs: 30_000 },
  small: { maxBytes: 64 * KiB, timeoutMs: 30_000 },
  executable: { maxBytes: 256 * MiB, timeoutMs: 10 * 60_000 },
});

/** The token `moshpit update` sends to GitHub, or null. */
export const githubToken = (env) => env.MOSHPIT_GITHUB_TOKEN || env.GH_TOKEN || null;

/** A download that did not produce a usable release. */
export class ReleaseSourceError extends Error {}

const cancel = (response) => response.body?.cancel().catch(() => {});

/** Follows redirects itself, so each hop's scheme is checked and the token goes only to TOKEN_HOSTS. */
async function fetchHops(fetch, url, { accept, protocol, token, signal }) {
  let hop = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (hop.protocol !== protocol) throw new ReleaseSourceError(`${url} redirected to ${hop.protocol}, not ${protocol}`);
    const headers = { Accept: accept, "User-Agent": "moshpit-update" };
    if (token && hop.protocol === "https:" && TOKEN_HOSTS.includes(hop.host)) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(hop.href, { headers, credentials: "omit", redirect: "manual", signal });
    } catch (error) {
      throw new ReleaseSourceError(`${url} did not answer (${error.cause?.code ?? error.message})`);
    }
    if (!REDIRECT.has(response.status)) return response;
    await cancel(response);
    const location = response.headers.get("location");
    if (!location) throw new ReleaseSourceError(`${url} answered HTTP ${response.status} with no Location`);
    if (redirects === MAX_REDIRECTS) throw new ReleaseSourceError(`${url} redirected more than ${MAX_REDIRECTS} times`);
    hop = new URL(location, hop);
  }
}

async function fetchBounded(fetch, url, { maxBytes, timeoutMs }, { accept = "application/octet-stream", protocol = new URL(url).protocol, token = null } = {}) {
  const response = await fetchHops(fetch, url, { accept, protocol, token, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200) {
    await cancel(response);
    const hint =
      response.status === 404 && !token ? "; if the repository is private, set MOSHPIT_GITHUB_TOKEN (or GH_TOKEN) to a token that can read it"
      : (response.status === 401 || response.status === 403) && token ? "; check that MOSHPIT_GITHUB_TOKEN (or GH_TOKEN) can read the repository"
      : "";
    throw new ReleaseSourceError(`${url} answered HTTP ${response.status}${hint}`);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new ReleaseSourceError(`${url} is more than the ${maxBytes} bytes allowed`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ReleaseSourceError) throw error;
    throw new ReleaseSourceError(`${url} stopped before it finished (${error.cause?.code ?? error.message})`);
  }
  return Buffer.concat(chunks);
}

/**
 * The release named by `tag`, or the latest one, as raw bytes:
 * `{ tag, binary, manifest }` for `moshpit-linux-<arch>`. Assets come from
 * their API URL, which also serves a private repository's assets to a token.
 */
export async function downloadRelease({ fetch, api = DEFAULT_RELEASE_API, arch, tag, token = null }) {
  const base = api.replace(/\/+$/, "");
  const protocol = new URL(base).protocol;
  const url = tag ? `${base}/releases/tags/${encodeURIComponent(tag)}` : `${base}/releases/latest`;
  let release;
  try {
    release = JSON.parse((await fetchBounded(fetch, url, LIMITS.metadata, { accept: "application/vnd.github+json", protocol, token })).toString("utf8"));
  } catch (error) {
    if (error instanceof ReleaseSourceError) throw error;
    throw new ReleaseSourceError(`${url} did not answer with release JSON`);
  }
  if (typeof release?.tag_name !== "string" || !Array.isArray(release.assets)) throw new ReleaseSourceError(`${url} did not describe a release`);
  const name = `moshpit-linux-${arch}`;
  const assetUrl = (file) => {
    const asset = release.assets.find((entry) => entry?.name === file);
    if (typeof asset?.url !== "string") throw new ReleaseSourceError(`release ${release.tag_name} has no ${file}`);
    const location = new URL(asset.url);
    // Never step down from the API's scheme, for example from https to http.
    if (location.protocol !== protocol) throw new ReleaseSourceError(`release ${release.tag_name} serves ${file} over ${location.protocol}`);
    return location.href;
  };
  const manifest = await fetchBounded(fetch, assetUrl(`${name}.json`), LIMITS.small, { protocol, token });
  const binary = await fetchBounded(fetch, assetUrl(name), LIMITS.executable, { protocol, token });
  return { tag: release.tag_name, binary, manifest };
}
