import { defineApplet, text, spacer, col, row, type ViewNode } from "../../sdk/index.ts";
import { divider, meter, sparkline } from "../../sdk/components.ts";
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

const GREEN = "#00d488";
const AMBER = "#f0b000";
const RED = "#ff5c57";
const BLUE = "#7aa2f7";
const DIM = "#6a6a6a";

const HISTORY = 240; // 8 minutes at one sample per 2s
const SLOW_MS = 10_000; // disk + battery cadence (they shell out)

/** Utilization color: calm until it isn't. */
function heat(frac: number): string {
  return frac >= 0.9 ? RED : frac >= 0.7 ? AMBER : GREEN;
}

/** Battery reads the other way round — low is the alarming end. */
function charge(b: Battery): string {
  if (b.plugged) return GREEN;
  return b.level <= 0.1 ? RED : b.level <= 0.25 ? AMBER : GREEN;
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
  const status = b.charging ? "charging" : b.plugged ? "on AC" : "on battery";
  return b.remaining ? `${status} · ${b.remaining} left` : status;
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

  tickMs: 2000,
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
    return low ? RED : heat(worst);
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 72);
    const nodes: ViewNode[] = [];

    const head = [
      state.host || "sampling…",
      state.platform,
      state.uptime ? `up ${fmtUptime(state.uptime)}` : "",
    ]
      .filter(Boolean)
      .join("  ·  ");
    nodes.push(text(head, { color: BLUE }), divider(Math.min(W - 1, 64)), spacer());

    if (state.error) nodes.push(text(state.error, { color: AMBER }), spacer());

    // Gauges first, then size the bars: the widest note decides how much room
    // is left, so no row ever overflows the frame and wraps mid-bar.
    const battery = state.battery;
    const rows: Array<{ label: string; value: number; color: string; note: string; muted?: boolean }> = [
      {
        label: "CPU",
        value: state.cpu,
        color: heat(state.cpu),
        note: state.cores ? `${state.cores} cores · load ${state.load[0].toFixed(2)}` : "",
      },
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
        color: battery ? charge(battery) : DIM,
        note: battery ? batteryNote(battery) : "no battery",
        muted: !battery,
      },
    ];

    // label(6) + "  " + pct(4) + "  " + note, all inside the frame.
    const widestNote = Math.max(...rows.map((r) => r.note.length));
    const barW = Math.max(12, Math.min(40, W - 6 - 2 - 4 - 2 - widestNote - 1));

    for (const r of rows) {
      // A metric this machine doesn't have (no battery, an unreadable mount)
      // gets a dim line, not a bar reading zero — an empty gauge would lie.
      nodes.push(
        r.muted
          ? text(`${r.label.padEnd(6)}${r.note}`, { dim: true })
          : meter(r.label, r.value, { width: barW, color: r.color, note: r.note }),
      );
      // CPU is the metric that spikes, so it gets the history line — right
      // aligned under its own bar.
      if (r.label === "CPU") {
        // Pin 0..1 so the CPU trend is an absolute gauge, not auto-scaled to
        // its own recent min/max (which would make a calm machine look busy).
        nodes.push(row([text(" ".repeat(6)), sparkline(state.history, { width: barW, color: DIM, min: 0, max: 1 })]));
      }
      nodes.push(spacer());
    }

    return [col(nodes)];
  },
});
