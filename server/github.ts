/**
 * GitHub via the `gh` CLI — no OAuth, piggybacks your existing `gh` auth. The
 * dashboard uses this to surface open PRs/issues that involve you (authored,
 * assigned, review-requested, mentioned). The notification bell is subscription
 * based and mostly CI noise, so we query search instead.
 */

export interface GhItem {
  title: string;
  type: "PullRequest" | "Issue";
  repo: string;
  age: string; // relative "updated" time
  url: string;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function search(kind: "prs" | "issues"): Array<{ title: string; number: number; updatedAt: string; url: string; repository: { nameWithOwner: string }; isPullRequest?: boolean }> {
  const r = Bun.spawnSync([
    "gh", "search", kind,
    "--involves=@me", "--state=open", "--sort=updated", "--limit", "20",
    "--json", "title,number,updatedAt,url,repository,isPullRequest",
  ]);
  if (r.exitCode !== 0) {
    const err = r.stderr.toString().trim();
    throw new Error(/not found|no such file/i.test(err) ? "gh CLI not installed" : err.slice(0, 120) || "gh failed");
  }
  return JSON.parse(r.stdout.toString() || "[]");
}

/** Open PRs and issues involving you, most-recently-updated first. */
export async function openItems(limit = 12): Promise<GhItem[]> {
  const rows = [
    ...search("prs").map((x) => ({ ...x, type: "PullRequest" as const })),
    // `gh search issues` includes PRs; tag by isPullRequest and dedupe below.
    ...search("issues").map((x) => ({ ...x, type: x.isPullRequest ? ("PullRequest" as const) : ("Issue" as const) })),
  ];
  const seen = new Set<string>();
  const deduped = rows.filter((x) => {
    const key = `${x.repository.nameWithOwner}#${x.number}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  deduped.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return deduped.slice(0, limit).map((x) => ({
    title: x.title,
    type: x.type,
    repo: x.repository.nameWithOwner,
    age: ago(x.updatedAt),
    url: x.url,
  }));
}
