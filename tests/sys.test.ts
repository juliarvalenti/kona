import { test, expect } from "bun:test";
import { parseDf, parseMeminfo, parsePmset, parseVmStat, resetCpuBaseline, sampleCpu, sample } from "../server/sys.ts";
import { sparkline, meter } from "../sdk/components.ts";

/** Pure parsing of the OS's own output — no subprocess, no machine assumptions. */

test("parseMeminfo uses MemAvailable, not MemFree, for what's actually free", () => {
  const { mem, swap } = parseMeminfo(
    [
      "MemTotal:       16384000 kB",
      "MemFree:          512000 kB",
      "MemAvailable:    8192000 kB",
      "Cached:          6000000 kB",
      "SwapTotal:       2048000 kB",
      "SwapFree:        1024000 kB",
    ].join("\n"),
  );
  expect(mem.total).toBe(16384000 * 1024);
  // used = total - available: page cache is reclaimable, so it isn't "used"
  expect(mem.used).toBe((16384000 - 8192000) * 1024);
  expect(swap).toEqual({ used: 1024000 * 1024, total: 2048000 * 1024 });
});

test("parseMeminfo reports no swap when the machine has none", () => {
  const { swap } = parseMeminfo("MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB");
  expect(swap).toBeNull();
});

test("parseVmStat counts active + wired + compressed as used", () => {
  const out = [
    "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
    "Pages free:                              100000.",
    "Pages active:                            500000.",
    "Pages inactive:                          200000.",
    "Pages wired down:                        300000.",
    "Pages occupied by compressor:            100000.",
  ].join("\n");
  const mem = parseVmStat(out, 16 * 1024 ** 3);
  expect(mem.used).toBe((500000 + 300000 + 100000) * 4096);
  expect(mem.total).toBe(16 * 1024 ** 3);
});

test("parseDf totals used + available, so the bar can reach 100%", () => {
  const out = [
    "Filesystem 1024-blocks      Used Available Capacity Mounted on",
    "/dev/disk3s5  482797652 193000000 289797652      40% /",
  ].join("\n");
  const disk = parseDf(out)!;
  expect(disk.mount).toBe("/");
  expect(disk.used).toBe(193000000 * 1024);
  // NOT the 1024-blocks column: that includes the root reserve you can't spend
  expect(disk.total).toBe((193000000 + 289797652) * 1024);
});

test("parseDf returns null when df printed nothing usable", () => {
  expect(parseDf("")).toBeNull();
  expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
});

test("parsePmset reads level, charge state, and time remaining", () => {
  const discharging = parsePmset(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t87%; discharging; 3:12 remaining present: true",
  )!;
  expect(discharging.level).toBeCloseTo(0.87);
  expect(discharging.charging).toBe(false);
  expect(discharging.plugged).toBe(false);
  expect(discharging.remaining).toBe("3:12");

  const charging = parsePmset(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t42%; charging; 1:05 remaining present: true",
  )!;
  expect(charging.charging).toBe(true);
  expect(charging.plugged).toBe(true);

  const charged = parsePmset(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true",
  )!;
  expect(charged.charging).toBe(false);
  expect(charged.plugged).toBe(true);
});

test("parsePmset returns null on a machine with no battery", () => {
  expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull();
});

test("sampleCpu needs a baseline, then reports a real 0..1 interval", async () => {
  resetCpuBaseline();
  expect(sampleCpu()).toBe(0); // first read only establishes the baseline
  const t = Date.now();
  while (Date.now() - t < 120) Math.sqrt(Math.random()); // give it something to measure
  const busy = sampleCpu();
  expect(busy).toBeGreaterThan(0);
  expect(busy).toBeLessThanOrEqual(1);
  // A second read in the same instant measures nothing — hold, don't dip to 0.
  expect(sampleCpu()).toBe(busy);
});

test("sample() reads this machine and degrades per-metric, never wholesale", async () => {
  const s = await sample();
  expect(s.cores).toBeGreaterThan(0);
  expect(s.mem.total).toBeGreaterThan(0);
  expect(s.mem.used).toBeLessThanOrEqual(s.mem.total);
  expect(s.load).toHaveLength(3);
  // battery/disk are per-machine: present or null, but never a thrown sample
  expect(s.battery === null || typeof s.battery.level === "number").toBe(true);

  // skipSlow reuses what the caller already has instead of shelling out again
  const cached = await sample({ skipSlow: true, disk: { used: 1, total: 2, mount: "/x" }, battery: null });
  expect(cached.disk).toEqual({ used: 1, total: 2, mount: "/x" });
});

test("sparkline scales pinned 0..1 samples to block heights, keeping the last `width`", () => {
  const node = sparkline([0, 0.5, 1], { width: 6, min: 0, max: 1 }) as { text: string };
  expect(node.text).toBe("▁▅█");
  const full = sparkline([0, 0.25, 0.5, 0.75, 1, 1, 1, 1], { width: 4, min: 0, max: 1 }) as { text: string };
  expect(full.text).toBe("████"); // only the last `width` samples
});

test("meter is a padded label, a bar, its own percentage, and a note", () => {
  const node = meter("CPU", 0.42, { width: 10, note: "8 cores" }) as {
    children: Array<{ kind: string; text?: string; value?: number; width?: number }>;
  };
  const [label, gauge, pct, note] = node.children;
  expect(label!.text).toBe("CPU   ");
  expect(gauge!.kind).toBe("bar");
  expect(gauge!.value).toBeCloseTo(0.42);
  expect(gauge!.width).toBe(10);
  expect(pct!.text).toBe("   42%"); // right-aligned so a stack of meters lines up
  expect(note!.text).toBe("  8 cores");
});

/**
 * The applet driven exactly as the daemon drives it — verbs and tick over one
 * state object, no HTTP. These touch the real machine (that IS the applet), but
 * only assert on things every machine has.
 */
import sys from "../applets/sys/index.ts";
import type { AppletCtx } from "../sdk/index.ts";

type SysState = typeof sys.initialState;

function harness() {
  const state: SysState = structuredClone(sys.initialState);
  let emits = 0;
  const ctx: AppletCtx<SysState> = { state, emit: () => void emits++ };
  return {
    state,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => sys.verbs[verb]!(args, ctx),
    tick: () => sys.tick!(ctx),
  };
}

test("refresh fills the state and answers the agent with the same numbers", async () => {
  const h = harness();
  const result = (await h.call("refresh")) as { cpu: number; mem: number; uptime: number };
  expect(h.state.host.length).toBeGreaterThan(0);
  expect(h.state.cores).toBeGreaterThan(0);
  expect(h.state.mem!.total).toBeGreaterThan(0);
  expect(h.state.sampledAt).toBeGreaterThan(0);
  expect(result.cpu).toBe(h.state.cpu);
  expect(result.mem).toBeCloseTo(h.state.mem!.used / h.state.mem!.total);
  expect(result.uptime).toBe(h.state.uptime);
  expect(h.emits()).toBeGreaterThan(0);
});

test("history skips the baseline sample, then grows one point per reading", async () => {
  const h = harness();
  await h.call("refresh");
  expect(h.state.history).toEqual([]); // the first read has no interval to graph
  await h.call("refresh");
  expect(h.state.history).toHaveLength(1);
  await h.call("refresh");
  expect(h.state.history).toHaveLength(2);
  for (const v of h.state.history) expect(v).toBeGreaterThanOrEqual(0);
});

test("a bad mount reverts to the last one that worked, and says so", async () => {
  const h = harness();
  await h.call("refresh");
  const result = (await h.call("mount", { path: "/definitely/not/a/mount" })) as { mount: string; error: string };
  expect(result.mount).toBe("/");
  expect(result.error).toContain("/definitely/not/a/mount");
  expect(h.state.mount).toBe("/");
  expect(h.state.disk).not.toBeNull(); // the gauge is still live on `/`
});

test("overlapping samples serialize instead of piling up", async () => {
  const h = harness();
  await Promise.all([h.call("refresh"), h.call("refresh"), h.call("refresh")]);
  sys.tick!({ state: h.state, emit: () => {} }); // fire-and-forget, like the daemon
  expect(h.state.sampledAt).toBeGreaterThan(0);
  expect(h.state.error).toBeNull();
});
