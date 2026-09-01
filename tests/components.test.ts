import { test, expect } from "bun:test";
import { progress, keyValue, list, badge } from "../sdk/components.ts";
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
