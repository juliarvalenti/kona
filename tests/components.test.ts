import { test, expect } from "bun:test";
import { progress, keyValue, list, badge, gauge, divider, spinner, table } from "../sdk/components.ts";
import type { ViewNode } from "../sdk/index.ts";

// helper: narrow a node to an object kind
function kind(n: ViewNode): string {
  return typeof n === "string" ? "string" : n.kind;
}

test("progress without label is a bare bar, clamped to 0..1", () => {
  const n = progress(2.5); // over 1 -> clamp
  expect(kind(n)).toBe("bar");
  if (typeof n !== "string" && n.kind === "bar") expect(n.value).toBe(1);
});

test("progress with label wraps the bar and label in a row", () => {
  const n = progress(0.5, { label: "50%" });
  expect(kind(n)).toBe("row");
  if (typeof n !== "string" && n.kind === "row") {
    expect(n.children.map(kind)).toEqual(["bar", "text"]);
  }
});

test("keyValue is a row of a dim key and a value", () => {
  const n = keyValue("host", "localhost");
  expect(kind(n)).toBe("row");
  if (typeof n !== "string" && n.kind === "row") {
    const [k, v] = n.children;
    expect(k).toMatchObject({ kind: "text", dim: true });
    expect(v).toMatchObject({ kind: "text", text: "localhost" });
  }
});

test("list marks the cursor row and dims the rest", () => {
  const rows = list(["a", "b", "c"], { cursor: 1 });
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ text: "▸ b", dim: false });
  expect(rows[0]).toMatchObject({ dim: true });
});

test("badge brackets a colored label", () => {
  expect(badge("LIVE", "#0f0")).toMatchObject({ kind: "text", text: "[LIVE]", color: "#0f0" });
});

test("gauge appends a percentage label", () => {
  const n = gauge(0.42);
  expect(kind(n)).toBe("row");
  if (typeof n !== "string" && n.kind === "row") {
    expect(n.children[1]).toMatchObject({ text: expect.stringContaining("42%") });
  }
});

test("divider is a rule of the requested width", () => {
  const n = divider(10);
  expect(n).toMatchObject({ kind: "text", text: "──────────" });
});

test("spinner advances with frame and wraps", () => {
  const a = spinner(0);
  const b = spinner(1);
  if (typeof a !== "string" && a.kind === "text" && typeof b !== "string" && b.kind === "text") {
    expect(a.text).not.toBe(b.text);
  }
  // wraps cleanly and never throws on large / negative frames
  expect(() => spinner(9999)).not.toThrow();
});

test("table aligns columns and dims the header", () => {
  const nodes = table(["k", "label"], [["space", "x"]]);
  expect(nodes[0]).toMatchObject({ dim: true });
  // header 'k' padded to width of 'space' (5) + 2-space gap
  if (typeof nodes[0] !== "string" && nodes[0]!.kind === "text") {
    expect(nodes[0]!.text).toBe("k      label");
  }
});
