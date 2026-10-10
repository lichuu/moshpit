import type { Agent, PullRequest, PullRequestReadiness } from "./types";

// C9: the bridge decides how ready a pull request is; this only words it and
// refuses anything that does not look like what the bridge sends.

const READINESS: Record<PullRequestReadiness, string> = {
  ready: "ready to merge",
  pending: "checks or review pending",
  blocked: "blocked by conflicts, failing checks or requested changes",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** The same words for the accessible name and the tooltip. */
export function pullRequestLabel(pr: PullRequest): string {
  return `Pull request ${pr.number}, ${READINESS[pr.readiness]}`;
}

function safeLink(url: string, number: number): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      new RegExp(`^/[^/]+/[^/]+/pull/${number}$`).test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** The agent's pull request if the bridge sent a well-formed one, else nothing. */
export function pullRequestOf(agent: Pick<Agent, "pullRequest">): PullRequest | undefined {
  const pr = agent.pullRequest as unknown;
  if (!pr || typeof pr !== "object") return undefined;
  const { number, readiness, url } = pr as Record<string, unknown>;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (typeof readiness !== "string" || !Object.hasOwn(READINESS, readiness)) return undefined;
  if (typeof url !== "string" || !safeLink(url, number)) return undefined;
  return { number, readiness: readiness as PullRequestReadiness, url };
}

/**
 * The one pull request a project header can speak for: the one every agent in
 * the project has. Agents on different branches of one project have different
 * pull requests (or none), and then the header says nothing; each card still
 * shows its own.
 */
export function sharedPullRequest(agents: readonly Pick<Agent, "pullRequest">[]): PullRequest | undefined {
  let shared: PullRequest | undefined;
  for (const agent of agents) {
    const pr = pullRequestOf(agent);
    if (!pr || (shared && (shared.url !== pr.url || shared.readiness !== pr.readiness))) return undefined;
    shared = pr;
  }
  return shared;
}
