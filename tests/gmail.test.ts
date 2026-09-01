import { test, expect } from "bun:test";
import { header, displayName, extractBody } from "../server/gmail.ts";

/** Pure Gmail-payload parsing — no network, no auth. */

test("header lookup is case-insensitive", () => {
  const h = [{ name: "From", value: "a@x.com" }, { name: "Subject", value: "hi" }];
  expect(header(h, "from")).toBe("a@x.com");
  expect(header(h, "SUBJECT")).toBe("hi");
  expect(header(h, "missing")).toBe("");
});

test("displayName prefers the name, falls back to the address", () => {
  expect(displayName("Ada Lovelace <ada@x.com>")).toBe("Ada Lovelace");
  expect(displayName('"Grace Hopper" <grace@x.com>')).toBe("Grace Hopper");
  expect(displayName("bare@x.com")).toBe("bare@x.com");
  expect(displayName("<only@x.com>")).toBe("only@x.com");
});

test("extractBody finds the first text/plain part and base64url-decodes it", () => {
  const data = Buffer.from("hello\nworld", "utf8").toString("base64url");
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: Buffer.from("<b>hi</b>").toString("base64url") } },
      { mimeType: "text/plain", body: { data } },
    ],
  };
  expect(extractBody(payload)).toBe("hello\nworld");
});

test("extractBody returns empty when there is no text part", () => {
  expect(extractBody({ mimeType: "image/png", body: { data: "x" } })).toBe("");
  expect(extractBody(undefined)).toBe("");
});

test("extractBody falls back to HTML->text when there is no plain part", () => {
  const html = "<h1>Hi</h1><p>Your order is <b>ready</b>.</p>";
  const payload = {
    mimeType: "text/html",
    body: { data: Buffer.from(html, "utf8").toString("base64url") },
  };
  const out = extractBody(payload);
  expect(out).toMatch(/hi/i); // heading text present (html-to-text upcases h1)
  expect(out).toContain("Your order is ready.");
  expect(out).not.toContain("<"); // tags stripped
});
