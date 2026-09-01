/**
 * System sampling — CPU, memory, disk, battery.
 *
 * Cheap by construction: CPU comes from `os.cpus()` tick counters (a delta
 * between two reads, no subprocess at all), memory from /proc/meminfo or
 * `vm_stat`, and the slow-moving metrics (disk, battery) are sampled on their
 * own longer cadence by the caller. Every probe is async and independently
 * fallible: a machine with no battery, or a `df` that fails, degrades to a
 * `null` for that metric instead of losing the whole sample.
 *
 * macOS and Linux are both first class — kona runs on the laptop, but the
 * daemon (and its tests) also run on Linux boxes and in CI.
 */
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from "node:os";

/** Bytes used out of bytes total. */
export interface Usage {
  used: number;
  total: number;
}

export interface DiskUsage extends Usage {
  mount: string;
}

export interface Battery {
  /** 0..1 charge level. */
  level: number;
  charging: boolean;
  /** On wall power (may be charging or already full). */
  plugged: boolean;
  /** Free-form remaining-time note when the OS offers one, e.g. "3:12". */
  remaining: string;
}

export interface SysSample {
  host: string;
  platform: string;
  /** Seconds since boot. */
  uptime: number;
  /** 0..1 across all cores, averaged since the previous sample. */
  cpu: number;
  cores: number;
  load: [number, number, number];
  mem: Usage;
  swap: Usage | null;
  disk: DiskUsage | null;
  battery: Battery | null;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Run a command, capped by a timeout so a wedged probe can't stall the tick. */
async function run(cmd: string[], timeoutMs = 2000): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const kill = setTimeout(() => proc.kill(), timeoutMs);
  kill.unref?.();
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`${cmd[0]} exited ${proc.exitCode}`);
    return out;
  } finally {
    clearTimeout(kill);
  }
}

async function readFile(path: string): Promise<string> {
  return await Bun.file(path).text();
}

// --- CPU ---------------------------------------------------------------------
// os.cpus() reports cumulative jiffies per core. Utilization is only meaningful
// between two reads, so we keep the previous totals in module scope: the first
// call establishes the baseline and every later one reports the interval since.

let prevTicks: { idle: number; total: number } | null = null;
let lastCpu = 0;
/** Aggregate core-milliseconds below which an interval is noise, not a reading. */
const MIN_WINDOW_MS = 50;

/** Fraction of CPU time spent non-idle since the previous call (0..1). */
export function sampleCpu(): number {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  const prev = prevTicks;
  prevTicks = { idle, total };
  if (!prev) return 0; // no baseline yet — the next call has one
  const dTotal = total - prev.total;
  const dIdle = idle - prev.idle;
  // Back-to-back reads span a window too short to mean anything (the counters
  // are in ms, summed over every core). Report the last real figure rather than
  // a phantom 0% dip in the history graph.
  if (dTotal < MIN_WINDOW_MS) return lastCpu;
  lastCpu = clamp01(1 - dIdle / dTotal);
  return lastCpu;
}

/** Drop the CPU baseline (tests; also after a long daemon pause). */
export function resetCpuBaseline(): void {
  prevTicks = null;
  lastCpu = 0;
}

// --- memory ------------------------------------------------------------------

/** Parse /proc/meminfo (Linux). Values are in kB. */
export function parseMeminfo(out: string): { mem: Usage; swap: Usage | null } {
  const kv = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv.set(m[1]!, parseInt(m[2]!, 10) * 1024);
  }
  const total = kv.get("MemTotal") ?? 0;
  // MemAvailable is the kernel's own estimate of what a workload could claim —
  // a much truer "free" than MemFree, which ignores reclaimable cache.
  const available = kv.get("MemAvailable") ?? (kv.get("MemFree") ?? 0) + (kv.get("Cached") ?? 0);
  const swapTotal = kv.get("SwapTotal") ?? 0;
  const swapFree = kv.get("SwapFree") ?? 0;
  return {
    mem: { used: Math.max(0, total - available), total },
    swap: swapTotal > 0 ? { used: Math.max(0, swapTotal - swapFree), total: swapTotal } : null,
  };
}

/**
 * Parse `vm_stat` (macOS). "Used" mirrors what Activity Monitor calls memory
 * pressure's numerator: active + wired + compressed pages. Free/inactive pages
 * are reclaimable, so counting them as used would show a permanently full bar.
 */
export function parseVmStat(out: string, totalBytes: number): Usage {
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  const pages = (label: string): number =>
    Number(out.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const used =
    (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
  return { used: Math.min(totalBytes, used), total: totalBytes };
}

async function sampleMem(): Promise<{ mem: Usage; swap: Usage | null }> {
  try {
    if (platform() === "linux") return parseMeminfo(await readFile("/proc/meminfo"));
    if (platform() === "darwin") return { mem: parseVmStat(await run(["vm_stat"]), totalmem()), swap: null };
  } catch {
    /* fall through to the portable approximation */
  }
  return { mem: { used: totalmem() - freemem(), total: totalmem() }, swap: null };
}

// --- disk --------------------------------------------------------------------

/** Parse `df -kP <mount>` — POSIX output, identical on macOS and Linux. */
export function parseDf(out: string): DiskUsage | null {
  const line = out.trim().split("\n")[1];
  if (!line) return null;
  // filesystem  1024-blocks  used  available  capacity  mounted-on
  const cols = line.trim().split(/\s+/);
  const used = Number(cols[2]);
  const avail = Number(cols[3]);
  const mount = cols[cols.length - 1] ?? "/";
  if (!Number.isFinite(used) || !Number.isFinite(avail)) return null;
  // total = used + available, NOT the "1024-blocks" column: that includes the
  // root reserve you can't actually spend, so the bar would never reach 100%.
  return { used: used * 1024, total: (used + avail) * 1024, mount };
}

async function sampleDisk(mount: string): Promise<DiskUsage | null> {
  try {
    return parseDf(await run(["df", "-kP", mount]));
  } catch {
    return null;
  }
}

// --- battery -----------------------------------------------------------------

/**
 * Parse `pmset -g batt` (macOS), e.g.
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=...)	87%; discharging; 3:12 remaining present: true
 */
export function parsePmset(out: string): Battery | null {
  const pct = out.match(/(\d+)%/);
  if (!pct) return null;
  const plugged = /'AC Power'/.test(out);
  const state = out.match(/%;\s*([a-z ]+);/)?.[1]?.trim() ?? "";
  const remaining = out.match(/(\d+:\d\d)\s+remaining/)?.[1] ?? "";
  return {
    level: clamp01(Number(pct[1]) / 100),
    charging: state === "charging",
    plugged,
    remaining,
  };
}

async function sampleBattery(): Promise<Battery | null> {
  if (platform() === "darwin") {
    try {
      return parsePmset(await run(["pmset", "-g", "batt"]));
    } catch {
      return null;
    }
  }
  if (platform() === "linux") {
    for (const bat of ["BAT0", "BAT1"]) {
      try {
        const dir = `/sys/class/power_supply/${bat}`;
        const level = clamp01(Number((await readFile(`${dir}/capacity`)).trim()) / 100);
        const status = (await readFile(`${dir}/status`)).trim();
        return {
          level,
          charging: status === "Charging",
          plugged: status !== "Discharging",
          remaining: "",
        };
      } catch {
        /* try the next battery, then give up — desktops have none */
      }
    }
  }
  return null;
}

// --- the sample --------------------------------------------------------------

export interface SampleOpts {
  /** Filesystem to report. Defaults to `/`. */
  mount?: string;
  /** Skip the subprocess-backed probes and reuse the caller's last values. */
  disk?: DiskUsage | null;
  battery?: Battery | null;
  skipSlow?: boolean;
}

/**
 * One full reading. CPU and memory every call; disk and battery only when the
 * caller asks (they shell out and barely move between ticks).
 */
export async function sample(opts: SampleOpts = {}): Promise<SysSample> {
  const mount = opts.mount ?? "/";
  const cpu = sampleCpu();
  const [{ mem, swap }, disk, battery] = await Promise.all([
    sampleMem(),
    opts.skipSlow ? Promise.resolve(opts.disk ?? null) : sampleDisk(mount),
    opts.skipSlow ? Promise.resolve(opts.battery ?? null) : sampleBattery(),
  ]);
  const [a, b, c] = loadavg();
  return {
    host: hostname().replace(/\.local$/, ""),
    platform: platform(),
    uptime: Math.round(uptime()),
    cpu,
    cores: cpus().length,
    load: [a ?? 0, b ?? 0, c ?? 0],
    mem,
    swap,
    disk,
    battery,
  };
}
