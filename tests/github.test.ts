import { test, expect, afterEach } from "bun:test";
import { openItems, setGhRunner } from "../server/github.ts";

/**
 * The dash's GitHub column shells out to `gh`, which on a developer's machine
 * is signed in as a real human — the CLI equivalent of the live-API problem in
 * #41. So `server/github.ts` has the same seam: a test injects a runner, and
 * with none injected the spawn is blocked outright.
 */

const ROWS = [
  { title: "Provider mock layer", number: 41, updatedAt: new Date(Date.now() - 3_600_000).toISOString(), url: "https://github.com/o/r/issues/41", repository: { nameWithOwner: "o/r" } },
  { title: "spotify: seek + volume", number: 27, updatedAt: new Date(Date.now() - 90_000_000).toISOString(), url: "https://github.com/o/r/pull/27", repository: { nameWithOwner: "o/r" }, isPullRequest: true },
];

afterEach(() => {
  setGhRunner(null);
});

test("openItems parses `gh search`, dedupes and dates the rows", async () => {
  const argv: string[][] = [];
  setGhRunner((args) => {
    argv.push(args);
    // `gh search issues` returns PRs too — the same #27 comes back twice.
    return { exitCode: 0, stdout: JSON.stringify(args[1] === "prs" ? [ROWS[1]] : ROWS), stderr: "" };
  });

  const items = await openItems();
  expect(argv.map((a) => a[1])).toEqual(["prs", "issues"]);
  // Newest-updated first, and the PR that came back from both searches once.
  expect(items.map((i) => `${i.type} ${i.repo}#${i.title}`)).toEqual([
    "Issue o/r#Provider mock layer",
    "PullRequest o/r#spotify: seek + volume",
  ]);
  expect(items.map((i) => i.age)).toEqual(["1h", "1d"]);
});

test("a failing gh surfaces its message, not a stack trace", async () => {
  setGhRunner(() => ({ exitCode: 1, stdout: "", stderr: "gh: command not found" }));
  await expect(openItems()).rejects.toThrow("gh CLI not installed");
});

test("with no runner injected, the spawn is blocked under test", async () => {
  await expect(openItems()).rejects.toThrow(/blocked a live `gh search prs/);
});
