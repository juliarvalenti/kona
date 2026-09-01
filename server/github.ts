import { offline } from "./transport.ts";

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

/**
 * How a `gh` invocation is run. This is the CLI equivalent of the HTTP
 * transport in `transport.ts`: a test injects one instead of shelling out to a
 * `gh` that is signed in as a real human (see #41).
 */
export type GhRunner = (args: string[]) => { exitCode: number; stdout: string; stderr: string };

let runner: GhRunner | null = null;

/** Install a fake `gh` (or null to go back to the real CLI). Returns the old one. */
export function setGhRunner(r: GhRunner | null): GhRunner | null {
  const prev = runner;
  runner = r;
  return prev;
}

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  if (runner) return runner(args);
  if (offline()) {
    throw new Error(
      `github: blocked a live \`gh ${args.join(" ")}\` — tests never touch a real account. ` +
        `Inject a fake with setGhRunner(), or run the opt-in live suite with KONA_LIVE=1.`,
    );
  }
  const r = Bun.spawnSync(["gh", ...args]);
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function search(kind: "prs" | "issues"): Array<{ title: string; number: number; updatedAt: string; url: string; repository: { nameWithOwner: string }; isPullRequest?: boolean }> {
  const r = run([
    "search", kind,
    "--involves=@me", "--state=open", "--sort=updated", "--limit", "20",
    "--json", "title,number,updatedAt,url,repository,isPullRequest",
  ]);
  if (r.exitCode !== 0) {
    const err = r.stderr.trim();
    throw new Error(/not found|no such file/i.test(err) ? "gh CLI not installed" : err.slice(0, 120) || "gh failed");
  }
  return JSON.parse(r.stdout || "[]");
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
