import { test, expect } from "bun:test";
import {
  progress,
  keyValue,
  list,
  badge,
  gauge,
  divider,
  spinner,
  table,
  recordRow,
  field,
  sparkline,
  sparkText,
  tabs,
  toast,
  card,
  modal,
} from "../sdk/components.ts";
import { input, text, type ViewNode } from "../sdk/index.ts";

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

test("recordRow spans the full width and marks selection", () => {
  const plain = recordRow([{ text: "GitHub", width: 10 }, { text: "hi", grow: true }], { width: 40 });
  if (typeof plain !== "string" && plain.kind === "text") {
    expect(plain.text.length).toBe(40); // fills the full width exactly
    expect(plain.focus).toBeFalsy(); // not selected
  }
  const sel = recordRow([{ text: "GitHub", width: 10 }], { width: 40, selected: true, accent: "#abc" });
  expect(sel).toMatchObject({ kind: "text", bg: "#abc", focus: true });
});

test("recordRow right-aligns a column and truncates overflow", () => {
  const r = recordRow(
    [
      { text: "a very long sender name that overflows", width: 10 },
      { text: "31 Aug", width: 8, align: "right" },
    ],
    { width: 40 },
  );
  if (typeof r !== "string" && r.kind === "text") {
    expect(r.text).toContain("…"); // long cell truncated
    expect(r.text.trimEnd()).toMatch(/31 Aug$/); // right-aligned date at the end
  }
});

test("table aligns columns and dims the header", () => {
  const nodes = table(["k", "label"], [["space", "x"]]);
  expect(nodes[0]).toMatchObject({ dim: true });
  // header 'k' padded to width of 'space' (5) + 2-space gap
  if (typeof nodes[0] !== "string" && nodes[0]!.kind === "text") {
    expect(nodes[0]!.text).toBe("k      label");
  }
});

test("input names the field and carries its verbs", () => {
  const n = input("subject", "hi", { submit: "send", cancel: "discard", width: 20 });
  expect(n).toMatchObject({
    kind: "input",
    id: "subject",
    value: "hi",
    submit: "send",
    cancel: "discard",
    width: 20,
  });
});

test("field pads its caption so a stack of them lines up", () => {
  const captions = ["to", "subject"].map((label) => {
    const n = field(label, input(label, ""), { labelWidth: 8 });
    if (typeof n === "string" || n.kind !== "row") throw new Error("field should be a row");
    const caption = n.children[0];
    expect(caption).toMatchObject({ kind: "text", dim: true });
    return (caption as { text: string }).text;
  });
  expect(captions).toEqual(["to      ", "subject "]);
});

test("sparkline maps a series onto the block ramp, low to high", () => {
  const n = sparkline([0, 1, 2, 3]);
  if (typeof n !== "string" && n.kind === "text") {
    expect(n.text).toHaveLength(4);
    expect(n.text[0]).toBe("▁"); // min -> floor
    expect(n.text[3]).toBe("█"); // max -> ceiling
  }
});

test("sparkline draws a flat series mid-height, not on the floor", () => {
  const n = sparkline([5, 5, 5]);
  if (typeof n !== "string" && n.kind === "text") expect(n.text).toBe("▅▅▅");
});

test("sparkline keeps the last `width` samples", () => {
  const n = sparkline([0, 1, 2, 3, 4, 5], { width: 3 });
  if (typeof n !== "string" && n.kind === "text") {
    expect(n.text).toHaveLength(3);
    expect(n.text[0]).toBe("▁"); // the window rescales to 3..5
  }
});

test("sparkline honors a pinned min/max so charts stay comparable", () => {
  const n = sparkline([5, 5, 5], { min: 0, max: 10 });
  if (typeof n !== "string" && n.kind === "text") expect(n.text).toBe("▅▅▅"); // half of 0..10
});

test("sparkline renders gaps for non-finite samples and survives an empty series", () => {
  const n = sparkline([0, NaN, 10]);
  if (typeof n !== "string" && n.kind === "text") {
    expect(n.text).toBe("▁ █"); // hole keeps its column, scale ignores it
  }
  const empty = sparkline([]);
  expect(empty).toMatchObject({ kind: "text", text: "" });
});

test("sparkText fits a long series by bucketing or by keeping the tail", () => {
  const series = [0, 100, 0, 100, 1, 2, 3, 4];
  // bucket keeps the whole session's shape (the spikes average out high);
  // tail keeps only what just happened, rescaled to itself.
  expect(sparkText(series, { width: 4, fit: "bucket" })).toBe("██▁▁");
  expect(sparkText(series, { width: 4, fit: "tail" })).toBe("▁▃▆█");
  // No width means every sample; a short series is never padded or clipped.
  expect(sparkText([1, 2, 3, 4])).toBe("▁▃▆█");
  expect(sparkText([])).toBe("");
});

test("sparkText widens each sample by `cell` so labels can sit underneath", () => {
  expect(sparkText([1, 5], { cell: 3 })).toBe("▁▁▁███");
  expect(sparkText([1, NaN, 5], { cell: 2 })).toBe("▁▁  ██"); // a hole keeps its columns
});

test("sparkline and sparkText draw the same series the same way", () => {
  const series = [3, 1, 4, 1, 5, 9, 2, 6];
  const n = sparkline(series, { width: 4 });
  if (typeof n !== "string" && n.kind === "text") {
    expect(n.text).toBe(sparkText(series, { width: 4 }));
  }
});

test("tabs fills the active tab and dims the rest", () => {
  const n = tabs(["inbox", "sent"], 0, { accent: "#abc" });
  expect(kind(n)).toBe("row");
  if (typeof n !== "string" && n.kind === "row") {
    expect(n.children[0]).toMatchObject({ kind: "text", text: " inbox ", bg: "#abc" });
    expect(n.children[1]).toMatchObject({ kind: "text", text: " sent ", dim: true });
  }
});

test("tabs with an out-of-range active index highlights nothing", () => {
  const n = tabs(["a", "b"], -1);
  if (typeof n !== "string" && n.kind === "row") {
    expect(n.children.every((c) => typeof c !== "string" && c.kind === "text" && c.dim)).toBe(true);
  }
});

test("toast is a filled banner whose color tracks the kind", () => {
  const info = toast("saved");
  const err = toast("boom", "error");
  expect(info).toMatchObject({ kind: "text", bg: "#7aa2f7" });
  if (typeof info !== "string" && info.kind === "text") expect(info.text).toContain("saved");
  if (typeof err !== "string" && err.kind === "text") {
    expect(err.bg).toBe("#ff5c57");
    expect(err.text).toContain("✖");
  }
});

test("toast pads to the requested width and truncates past it", () => {
  const padded = toast("hi", "warn", { width: 20 });
  if (typeof padded !== "string" && padded.kind === "text") expect(padded.text).toHaveLength(20);
  const clipped = toast("a very long notification indeed", "warn", { width: 10 });
  if (typeof clipped !== "string" && clipped.kind === "text") expect(clipped.text).toHaveLength(10);
});

test("card is a titled bordered box wrapping its children", () => {
  const n = card("cpu", [text("42%")], { color: "#0f0", width: 24 });
  expect(kind(n)).toBe("box");
  if (typeof n !== "string" && n.kind === "box") {
    expect(n.opts).toMatchObject({ title: "cpu", borderColor: "#0f0", width: 24, padding: 1 });
    expect(n.children).toHaveLength(1);
  }
});

test("modal centers a double-bordered card and appends the footer hint", () => {
  const n = modal("delete?", [text("sure?")], { footer: "enter ok · esc cancel" });
  expect(kind(n)).toBe("row");
  if (typeof n !== "string" && n.kind === "row") {
    expect(n.opts.justify).toBe("center");
    const panel = n.children[0]!;
    expect(kind(panel)).toBe("box");
    if (typeof panel !== "string" && panel.kind === "box") {
      expect(panel.opts).toMatchObject({ title: "delete?", borderStyle: "double", titleAlign: "center" });
      expect(panel.children.at(-1)).toMatchObject({ kind: "text", dim: true, text: "enter ok · esc cancel" });
    }
  }
});
