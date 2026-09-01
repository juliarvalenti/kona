import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { expiringToken, freshToken, pkce, readJson } from "../server/provider.ts";

/**
 * The primitives every provider server shares. They are small, which is
 * exactly why each provider used to carry its own copy — and why a token
 * expiry could quietly differ between mail and music.
 */

test("readJson parses a config file and treats anything unreadable as absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kona-provider-"));
  const good = join(dir, "creds.json");
  await Bun.write(good, JSON.stringify({ client_id: "abc" }));
  expect(await readJson<{ client_id: string }>(good)).toEqual({ client_id: "abc" });

  const broken = join(dir, "broken.json");
  await Bun.write(broken, "{not json");
  expect(await readJson(broken)).toBeNull();
  expect(await readJson(join(dir, "missing.json"))).toBeNull();
});

test("pkce makes a verifier and its S256 challenge, fresh each time", () => {
  const a = pkce();
  const b = pkce();
  expect(a.verifier).not.toBe(b.verifier);
  expect(a.challenge).not.toBe(a.verifier);
  // base64url: no padding, no + or /
  expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("a token is fresh until it is within the refresh skew of expiring", () => {
  expect(freshToken(null)).toBeNull();
  expect(freshToken({ token: "t", exp: Date.now() + 60_000 })).toBe("t");
  // Inside the skew it is treated as gone — better a refresh than a token
  // that dies mid-request.
  expect(freshToken({ token: "t", exp: Date.now() + 5_000 })).toBeNull();
  expect(freshToken({ token: "t", exp: Date.now() - 1 })).toBeNull();
});

test("expiringToken stamps the provider's expires_in, or an hour by default", () => {
  const now = Date.now();
  expect(expiringToken("t", 120).exp).toBeGreaterThanOrEqual(now + 120_000);
  const fallback = expiringToken("t").exp - now;
  expect(fallback).toBeGreaterThan(3_500_000);
  expect(fallback).toBeLessThanOrEqual(3_600_000);
  expect(freshToken(expiringToken("t", 120))).toBe("t");
});
