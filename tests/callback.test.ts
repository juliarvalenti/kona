import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callbackHtml, callbackPage } from "../server/callback.ts";
import { DEFAULT_THEME, resetConfig } from "../core/config.ts";

/**
 * The last thing you see before flipping back to the terminal. It has to be
 * self-contained: by the time the tab renders, the loopback server it came
 * from is about to stop listening.
 *
 * The page wears the LIVE theme, so pin the config to an empty dir — otherwise
 * these assertions (which check the page against DEFAULT_THEME) would fail on
 * any machine whose real ~/.config/kona sets a non-default preset.
 */

let prevCfgDir: string | undefined;
beforeAll(() => {
  prevCfgDir = process.env.KONA_CONFIG_DIR;
  process.env.KONA_CONFIG_DIR = mkdtempSync(join(tmpdir(), "kona-callback-"));
  resetConfig();
});
afterAll(() => {
  if (prevCfgDir === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = prevCfgDir;
  resetConfig();
});

const GMAIL = { name: "Google", login: "gmail" };

test("the success page says who you signed in to and how to get out", async () => {
  const res = callbackPage(GMAIL, "ok");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const html = await res.text();
  expect(html).toContain("signed in to <b>Google</b>");
  expect(html).toContain("you can close this tab and go back to kona");
  // Auto-close, with the manual fallback for a tab the browser won't let go of.
  expect(html).toContain("window.close()");
  expect(html).toContain("closing this tab in a moment");
});

test("the failure page names the command that retries, and never auto-closes", () => {
  const html = callbackHtml({ name: "Spotify", login: "spotify" }, "failed", "access_denied");
  expect(html).toContain("auth didn't go through");
  expect(html).toContain("<code>kona login spotify</code>");
  expect(html).toContain("access_denied");
  // Nothing to read if the tab shuts itself.
  expect(html).not.toContain("window.close()");
});

test("a provider's own words are escaped, never spliced into the page", () => {
  const html = callbackHtml(GMAIL, "failed", '<img src=x onerror="alert(1)">');
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("it needs nothing from the network — no src, no href, no fetch", () => {
  for (const outcome of ["ok", "failed", "waiting"] as const) {
    const html = callbackHtml(GMAIL, outcome);
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("<!doctype html>");
  }
});

test("it wears the user's palette rather than colors of its own", () => {
  expect(callbackHtml(GMAIL, "ok")).toContain(`--accent: ${DEFAULT_THEME.ok};`);
  expect(callbackHtml(GMAIL, "failed")).toContain(`--accent: ${DEFAULT_THEME.error};`);
  expect(callbackHtml(GMAIL, "waiting")).toContain(`--bg: ${DEFAULT_THEME.bg};`);
});

test("the aloha greeting rotates", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(callbackHtml(GMAIL, "ok").match(/class="greeting">([^<]+)</)![1]!);
  }
  expect(seen.size).toBeGreaterThan(1);
});
