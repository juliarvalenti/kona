import {
  defineApplet,
  big,
  text,
  spacer,
  col,
  row,
  theme,
  bigSize,
  fitBigFont,
  type ViewNode,
  type DashCard,
  type Color,
} from "../../sdk/index.ts";
import { meter, sparkText } from "../../sdk/components.ts";
import { sample, type Battery, type DiskUsage, type Usage } from "../../server/sys.ts";

/**
 * sys — a cockpit gauge for the machine. CPU, memory, disk, battery, live.
 *
 * The bimodal payoff: the same sample that draws these bars is what an agent
 * reads with `kona state sys` (or fires fresh with `sys.refresh`) before it
 * decides whether to kick off that build. One sampler, two audiences.
 *
 * Sampling is deliberately cheap. CPU/memory come from tick counters and a
 * single file read every 2s; disk and battery shell out, so they run on a
 * 10s cadence, never concurrently with themselves, and never block a repaint.
 *
 * The view is built to be left on screen: a figlet CPU readout, a thermal
 * area graph of the last few minutes that scrolls in from the right edge, and
 * the gauge stack beneath — the shape of a hardware monitor rather than a
 * table of numbers. Everything is painted from the theme, so it retints with
 * the rest of kona.
 */

interface SysState {
  host: string;
  platform: string;
  uptime: number;
  cpu: number; // 0..1
  cores: number;
  load: [number, number, number];
  history: number[]; // recent cpu fractions, oldest first
  mem: Usage | null;
  swap: Usage | null;
  disk: DiskUsage | null;
  battery: Battery | null;
  mount: string;
  sampledAt: number;
  error: string | null;
}

const HISTORY = 240; // 8 minutes at one sample per 2s
const TICK_MS = 2000;
const SLOW_MS = 10_000; // disk + battery cadence (they shell out)

/** Utilization color: calm until it isn't. */
function heat(frac: number): Color {
  const t = theme();
  return frac >= 0.9 ? t.error : frac >= 0.7 ? t.warn : t.ok;
}

/** Battery reads the other way round — low is the alarming end. */
function charge(b: Battery): Color {
  const t = theme();
  if (b.plugged) return t.ok;
  return b.level <= 0.1 ? t.error : b.level <= 0.25 ? t.warn : t.ok;
}

function bytes(n: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)}${units[u]}`;
}

function batteryNote(b: Battery): string {
  const status = b.charging ? "⚡ charging" : b.plugged ? "on AC" : "on battery";
  return b.remaining ? `${status} · ${b.remaining} left` : status;
}

/** "150" seconds -> "2m 30s"; the span a graph covers. */
function fmtSpan(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (!m) return `${s}s`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** The eight fill levels a graph cell can take, plus empty. */
const LEVELS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * A series as an area chart `rows` lines tall — the sparkline given height, so
 * a spike reads as a spike. Each cell resolves to eighths, so a two-row graph
 * has sixteen steps where the one-line sparkline has eight. The newest sample
 * is pinned to the right edge and the series grows in from there, the way a
 * hardware monitor scrolls. Lines come back top row first.
 */
export function areaChart(values: number[], width: number, rows: number): string[] {
  const tail = values.slice(-width);
  const lead = " ".repeat(Math.max(0, width - tail.length));
  const lines: string[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    let line = lead;
    for (const v of tail) {
      const eighths = Math.round(Math.max(0, Math.min(1, v)) * rows * 8) - r * 8;
      line += LEVELS[Math.max(0, Math.min(8, eighths))]!;
    }
    lines.push(line);
  }
  return lines;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const frac = (u: Usage | null): number => (u && u.total > 0 ? u.used / u.total : 0);
const amount = (u: Usage | null): string => (u ? `${bytes(u.used)} / ${bytes(u.total)}` : "—");

// One sampler for the whole daemon: the tick, `refresh`, and `init` all funnel
// through here. Samples are serialized, so a slow `df` can never stack up
// behind the next tick.
let queue: Promise<void> = Promise.resolve();
let sampling = false;
let nextSlowAt = 0;

/**
 * Take a sample. A tick skips when one is already running (no pileup); a
 * forced caller — a verb — queues behind it so it still gets a fresh reading.
 */
function refresh(state: SysState, emit: () => void, force = false): Promise<void> {
  if (sampling && !force) return queue;
  queue = queue.then(async () => {
    sampling = true;
    try {
      await takeSample(state, emit, force);
    } finally {
      sampling = false;
    }
  });
  return queue;
}

async function takeSample(state: SysState, emit: () => void, force: boolean): Promise<void> {
  // Disk and battery shell out and barely move; sample them on their own
  // slower cadence unless a verb explicitly asked for a full reading.
  const slow = force || Date.now() >= nextSlowAt;
  try {
    const s = await sample({
      mount: state.mount,
      skipSlow: !slow,
      disk: state.disk,
      battery: state.battery,
    });
    if (slow) nextSlowAt = Date.now() + SLOW_MS;
    state.host = s.host;
    state.platform = s.platform;
    state.uptime = s.uptime;
    state.cpu = s.cpu;
    state.cores = s.cores;
    state.load = s.load;
    state.mem = s.mem;
    state.swap = s.swap;
    state.disk = s.disk;
    state.battery = s.battery;
    // The very first sample has no interval to compare against, so its 0 is an
    // artifact — don't graph it.
    if (state.sampledAt) state.history = [...state.history, s.cpu].slice(-HISTORY);
    state.sampledAt = Date.now();
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    emit();
  }
}

export default defineApplet<SysState>({
  id: "sys",
  title: "System",
  summary: "Live CPU, memory, disk, and battery gauges.",
  icon: "◍",
  tint: theme().ok,
  labels: ["system"],
  // Every field is a reading of *now* — persisting it would only paint stale
  // bars for the first two seconds after a daemon restart.
  ephemeral: true,
  initialState: {
    host: "",
    platform: "",
    uptime: 0,
    cpu: 0,
    cores: 0,
    load: [0, 0, 0],
    history: [],
    mem: null,
    swap: null,
    disk: null,
    battery: null,
    mount: "/",
    sampledAt: 0,
    error: null,
  },

  docs: {
    refresh: "Take a full reading now — load, memory, disk, battery, network. This is the one you want.",
    mount: { doc: "Point the disk gauge at another filesystem.", args: { path: "/Volumes/ext" } },
  },

  verbs: {
    /** Take a full reading now (agents: this is the one you want). */
    async refresh(_args, { state, emit }) {
      await refresh(state, emit, true);
      return {
        cpu: state.cpu,
        mem: frac(state.mem),
        disk: frac(state.disk),
        battery: state.battery?.level ?? null,
        load: state.load,
        uptime: state.uptime,
      };
    },
    /** Point the disk gauge at another filesystem, e.g. `{"path":"/Volumes/ext"}`. */
    async mount(args, { state, emit }) {
      const path = typeof args.path === "string" && args.path ? args.path : "/";
      const prev = state.mount;
      state.mount = path;
      state.disk = null;
      await refresh(state, emit, true);
      if (!state.disk) {
        // df couldn't read it — keep the cockpit on the mount that works and
        // tell the caller, rather than leaving a permanently blank gauge.
        state.mount = prev;
        await refresh(state, emit, true);
        state.error = `can't read ${path}`;
        emit();
        return { mount: state.mount, error: state.error };
      }
      return { mount: state.mount, disk: state.disk };
    },
  },

  // Establish the CPU tick baseline immediately so the first visible sample is
  // a real interval, not a zero.
  init({ state, emit }) {
    void refresh(state, emit, true);
  },

  tickMs: TICK_MS,
  tick({ state, emit }) {
    void refresh(state, emit);
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
  },

  // The frame itself reports pressure: it goes amber, then red, with whichever
  // gauge is worst — you can read the machine from the border alone.
  accent(state) {
    const worst = Math.max(state.cpu, frac(state.mem), frac(state.disk));
    const low = state.battery && !state.battery.plugged && state.battery.level <= 0.1;
    return low ? theme().error : heat(worst);
  },

  /**
   * The machine only speaks up when something is wrong with it: a pegged CPU,
   * a battery about to die, a disk about to fill. A healthy box is silent.
   */
  dash: (s) => {
    const cards: DashCard[] = [];
    if (s.cpu >= 0.85) {
      cards.push({
        id: "cpu",
        priority: 70,
        text: `▲ CPU ${Math.round(s.cpu * 100)}%${s.load[0] ? `  ·  load ${s.load[0].toFixed(2)}` : ""}`,
        note: `${s.cores} cores`,
        color: heat(s.cpu),
      });
    }
    const b = s.battery;
    if (b && !b.plugged && b.level <= 0.2) {
      cards.push({
        id: "battery",
        priority: 85,
        text: `□ battery ${Math.round(b.level * 100)}%  ·  ${batteryNote(b)}`,
        note: "unplugged",
        color: charge(b),
      });
    }
    const d = s.disk;
    if (d && frac(d) >= 0.92) {
      cards.push({
        id: "disk",
        priority: 60,
        text: `■ ${d.mount} ${Math.round(frac(d) * 100)}% full  ·  ${amount(d)}`,
        note: "low space",
        color: heat(frac(d)),
      });
    }
    return cards;
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 72);
    const H = ctx?.height ?? 24;
    const t = theme();
    const nodes: ViewNode[] = [];

    const cpuPct = Math.round(state.cpu * 100);
    const cpuColor = heat(state.cpu);
    const headline = [
      state.host || "sampling…",
      state.platform,
      state.uptime ? `up ${fmtUptime(state.uptime)}` : "",
    ]
      .filter(Boolean)
      .join("  ·  ");

    // The three load averages as one tiny bar chart, scaled to the core count
    // so a full bar means every core busy — the shape says rising or falling
    // at a glance, the numbers say by how much.
    const loadSpark = state.cores
      ? sparkText(state.load.map((l) => Math.min(1, l / state.cores)), { min: 0, max: 1 })
      : "";
    const loadLine = state.cores
      ? `load  ${loadSpark}  ${state.load.map((l) => l.toFixed(2)).join("  ")}`
      : "";

    // --- hero: the CPU number in a figlet, the machine's identity beside it.
    // A pane too short or too narrow for that gets a one-line head instead —
    // the graph and gauges below are the part that must never be squeezed out.
    const figlet = `${cpuPct}%`;
    const font = fitBigFont(figlet, t.font, { width: Math.floor(W * 0.45) });
    const figW = bigSize(figlet, font).width;
    const figH = bigSize(figlet, font).height;
    const heroFits = H >= 16 && W >= 60 && figW + 2 + Math.max(headline.length, loadLine.length) <= W - 1;
    if (heroFits) {
      nodes.push(
        row(
          [
            big(figlet, cpuColor, font),
            col([
              text(headline, { color: t.accent }),
              spacer(),
              text(`CPU   ${state.cores ? `${state.cores} cores` : ""}`, { dim: true }),
              text(loadLine, { dim: true }),
            ]),
          ],
          { align: "center", gap: 2 },
        ),
      );
    } else {
      // Word-wrap would cost a row the graph needs; clip the detail instead.
      const detail = [
        state.cores ? `${state.cores} cores` : "",
        state.cores ? `load ${state.load.map((l) => l.toFixed(2)).join(" ")}` : "",
      ]
        .filter(Boolean)
        .join("  ·  ");
      nodes.push(
        text(headline.slice(0, W - 1), { color: t.accent }),
        row(
          [
            text("CPU ", { dim: true }),
            text(`${cpuPct}%`, { color: cpuColor }),
            text(`  ·  ${detail}`.slice(0, Math.max(0, W - 1 - 4 - `${cpuPct}%`.length)), { dim: true }),
          ],
          { align: "center" },
        ),
      );
    }
    if (state.error) nodes.push(text(state.error, { color: t.warn }));

    // --- gauges, sized first: the widest note decides how much room the bars
    // get, so no row ever overflows the frame and wraps mid-bar.
    const battery = state.battery;
    const gauges: Array<{ label: string; value: number; color: Color; note: string; muted?: boolean }> = [
      { label: "MEM", value: frac(state.mem), color: heat(frac(state.mem)), note: amount(state.mem) },
      ...(state.swap && state.swap.used > 0
        ? [{ label: "SWAP", value: frac(state.swap), color: heat(frac(state.swap)), note: amount(state.swap) }]
        : []),
      {
        label: "DISK",
        value: frac(state.disk),
        color: heat(frac(state.disk)),
        note: state.disk ? `${amount(state.disk)}  ${state.disk.mount}` : "unavailable",
        muted: !state.disk,
      },
      {
        label: "BATT",
        value: battery?.level ?? 0,
        color: battery ? charge(battery) : t.muted,
        note: battery ? batteryNote(battery) : "no battery",
        muted: !battery,
      },
    ];
    // label(6) + bar + "  " + pct(4) + "  " + note, all inside the frame.
    const widestNote = Math.max(...gauges.map((r) => r.note.length));
    const barW = Math.max(12, Math.min(48, W - 6 - 2 - 4 - 2 - widestNote - 1));

    // --- the CPU graph: whatever height is left after the hero, the gauges
    // and their breathing room, between two rows (a trend) and six (a wall).
    // The pane draws one row fewer than it reports, so budget for that too:
    // a gauge that scrolls off the bottom is worse than a graph a row shorter.
    const heroH = heroFits ? figH : 2;
    const used = heroH + (state.error ? 1 : 0) + 1 + 1 + 1 + gauges.length; // spacer, axis, spacer, gauges
    const graphRows = Math.max(2, Math.min(6, H - 1 - used));
    const graphW = W - 1;
    const shown = Math.min(state.history.length, graphW);
    // Rows are colored by the utilization they stand for — green at the
    // floor, amber, then red at the ceiling — so a spike turns hot on its way
    // up and the graph reads as a thermal picture, not a silhouette.
    const lines = areaChart(state.history, graphW, graphRows).map((line, i) =>
      text(line, { color: heat((graphRows - i) / graphRows) }),
    );
    // The axis carries the span; the graph itself has no scale to read.
    // One sample per tick, so the visible width is a length of time.
    const left = shown ? `${fmtSpan((shown * TICK_MS) / 1000)} ago ` : "";
    const right = " now";
    const axis = left + "─".repeat(Math.max(0, graphW - left.length - right.length)) + right;
    nodes.push(spacer(), ...lines, text(axis, { color: t.muted }), spacer());

    for (const r of gauges) {
      // A metric this machine doesn't have (no battery, an unreadable mount)
      // gets a dim line, not a bar reading zero — an empty gauge would lie.
      nodes.push(
        r.muted
          ? text(`${r.label.padEnd(6)}${r.note}`, { dim: true })
          : meter(r.label, r.value, { width: barW, color: r.color, note: r.note }),
      );
    }

    return [col(nodes)];
  },
});
