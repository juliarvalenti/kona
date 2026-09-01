/**
 * cron — the daemon's clock for scheduled work.
 *
 * kona already had a per-applet heartbeat (`tick`/`tickMs`): "call me every N
 * ms while you're loaded". That is the wrong shape for "run this at 08:30 on
 * weekdays", so this module generalizes it: an applet declares CRON JOBS
 * (`cron(state) -> CronJob[]`) and the daemon fires the named verb when each is
 * due — the same internal-caller seam a tick uses, just on a calendar.
 *
 * The parser takes standard 5-field expressions (`m h dom mon dow`, with stars,
 * step syntax, ranges, lists and three-letter names), the usual `@hourly`/`@daily`
 * shorthands, and `@every <duration>` for plain intervals. No dependency: the
 * whole grammar kona needs is a hundred lines, and a cron expression in state
 * must stay something a human can read and an agent can write.
 */

/** A parsed 5-field expression: the allowed values per field. */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when the field was `*` — cron's dom/dow OR rule needs to know. */
  domAny: boolean;
  dowAny: boolean;
}

/** A fixed interval (`@every 30s`) rather than a calendar expression. */
export interface CronInterval {
  everyMs: number;
}

export type CronSpec = { kind: "fields"; fields: CronFields } | { kind: "interval"; everyMs: number };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** "30s", "5m", "2h", "1d", "1h30m", or a bare number of seconds. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const parts = s.match(/\d+(\.\d+)?\s*[smhd]/g);
  if (!parts || parts.join("").replace(/\s/g, "") !== s.replace(/\s/g, "")) return null;
  let ms = 0;
  for (const p of parts) {
    const n = Number(p.replace(/[^\d.]/g, ""));
    ms += n * unit[p.trim().slice(-1)!]!;
  }
  return ms > 0 ? Math.round(ms) : null;
}

/** Expand one field (a star, a step, "1-4", "mon,wed") into the values it allows. */
function parseField(raw: string, min: number, max: number, names: string[]): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim().toLowerCase();
    if (!piece) throw new Error(`empty field in "${raw}"`);
    const [spec, stepRaw] = piece.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${stepRaw}"`);

    const named = (v: string): number => {
      const i = names.indexOf(v);
      if (i >= 0) return i + (names === MONTHS ? 1 : 0);
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error(`bad value "${v}"`);
      return n;
    };

    let lo: number;
    let hi: number;
    if (spec === "*" || spec === "") {
      [lo, hi] = [min, max];
    } else if (spec!.includes("-")) {
      const [a, b] = spec!.split("-");
      [lo, hi] = [named(a!), named(b!)];
    } else {
      lo = named(spec!);
      hi = stepRaw === undefined ? lo : max; // "5/10" means "from 5, every 10"
    }
    if (lo > hi || lo < min || hi > max) throw new Error(`"${piece}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Parse an expression into the values each field allows. Throws on anything it
 * doesn't understand — callers validate a user's or agent's string by calling
 * this (see `validateCron`) rather than discovering the problem at fire time.
 */
export function parseCron(expr: string): CronSpec {
  const raw = expr.trim().toLowerCase();
  if (!raw) throw new Error("empty cron expression");

  if (raw.startsWith("@every")) {
    const ms = parseDuration(raw.slice("@every".length));
    if (!ms) throw new Error(`bad interval in "${expr}"`);
    if (ms < 1000) throw new Error("interval must be at least 1s");
    return { kind: "interval", everyMs: ms };
  }

  const text = ALIASES[raw] ?? raw;
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5 fields (m h dom mon dow), got ${parts.length}: "${expr}"`);
  }
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const dowSet = parseField(dow, 0, 7, DAYS);
  if (dowSet.has(7)) dowSet.add(0); // both 0 and 7 mean Sunday
  return {
    kind: "fields",
    fields: {
      minute: parseField(m, 0, 59, []),
      hour: parseField(h, 0, 23, []),
      dom: parseField(dom, 1, 31, []),
      month: parseField(mon, 1, 12, MONTHS),
      dow: dowSet,
      domAny: dom.trim() === "*",
      dowAny: dow.trim() === "*",
    },
  };
}

/** The error message for a bad expression, or null when it parses. */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Does this instant satisfy the expression? (Interval specs never match a wall clock.) */
export function matches(spec: CronSpec, at: Date): boolean {
  if (spec.kind !== "fields") return false;
  const f = spec.fields;
  if (!f.minute.has(at.getMinutes()) || !f.hour.has(at.getHours())) return false;
  if (!f.month.has(at.getMonth() + 1)) return false;
  // Standard cron: with BOTH day fields restricted, either one matching is enough.
  const domHit = f.dom.has(at.getDate());
  const dowHit = f.dow.has(at.getDay());
  if (f.domAny && f.dowAny) return true;
  if (f.domAny) return dowHit;
  if (f.dowAny) return domHit;
  return domHit || dowHit;
}

const MINUTE = 60_000;

/**
 * The next time the expression fires strictly after `from` (local time, minute
 * granularity — the same resolution crontab has). Days that can't match are
 * skipped whole, so a "29 Feb" expression costs a few thousand cheap checks
 * rather than half a million.
 */
export function nextRun(expr: string, from: number = Date.now()): number {
  const spec = parseCron(expr);
  if (spec.kind === "interval") return from + spec.everyMs;

  const f = spec.fields;
  const dayMatches = (d: Date): boolean => {
    if (!f.month.has(d.getMonth() + 1)) return false;
    const domHit = f.dom.has(d.getDate());
    const dowHit = f.dow.has(d.getDay());
    if (f.domAny && f.dowAny) return true;
    if (f.domAny) return dowHit;
    if (f.dowAny) return domHit;
    return domHit || dowHit;
  };

  const cursor = new Date(from + MINUTE);
  cursor.setSeconds(0, 0);
  // 4 years covers every leap-year case; past that the expression can't fire.
  const limit = from + 4 * 366 * 86_400_000;
  while (cursor.getTime() <= limit) {
    if (!dayMatches(cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (f.minute.has(cursor.getMinutes())) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
  }
  throw new Error(`"${expr}" never fires`);
}

/** A plain-English gloss for the TUI. Falls back to the expression itself. */
export function describeCron(expr: string): string {
  const raw = expr.trim().toLowerCase();
  if (raw.startsWith("@every")) return `every ${raw.slice("@every".length).trim()}`;
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return expr;
  }
  if (spec.kind === "interval") return expr;
  const f = spec.fields;
  const text = ALIASES[raw] ?? raw;
  const [, , dom, mon, dow] = text.split(/\s+/) as [string, string, string, string, string];
  const at = f.hour.size === 1 && f.minute.size === 1
    ? `${String([...f.hour][0]).padStart(2, "0")}:${String([...f.minute][0]).padStart(2, "0")}`
    : null;

  const everyMinutes = f.minute.size > 1 && f.hour.size === 24;
  if (everyMinutes) {
    const step = [...f.minute].sort((a, b) => a - b)[1]! - [...f.minute].sort((a, b) => a - b)[0]!;
    if (f.minute.size === 60) return "every minute";
    return `every ${step}m`;
  }
  const when = at ? `at ${at}` : `${f.minute.size} × per hour`;
  if (dom === "*" && dow === "*" && mon === "*") return `daily ${when}`;
  if (dom === "*" && mon === "*") return `${days(f.dow)} ${when}`;
  return `${expr} (${when})`;
}

/** The day set as a person would say it: "weekdays", "mondays", "mon-thu". */
function days(dow: Set<number>): string {
  const set = [...dow].filter((d) => d !== 7).sort((a, b) => a - b);
  const key = set.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  if (set.length === 1) return `${DAYS[set[0]!]!}days`;
  const contiguous = set.every((d, i) => i === 0 || d === set[i - 1]! + 1);
  return contiguous ? `${DAYS[set[0]!]!}-${DAYS[set[set.length - 1]!]!}` : set.map((d) => DAYS[d]!).join("/");
}

/**
 * Fires jobs when they come due, and nothing else — no timers, no I/O. The
 * daemon owns the interval and the invoking; this owns "what is due now", which
 * is the part worth testing with a fake clock.
 *
 * Jobs are identified by key. A job whose key disappears is forgotten; a job
 * whose expression changes gets a fresh schedule (the key carries the
 * expression, so an edit reschedules by construction).
 */
export class CronScheduler {
  private next = new Map<string, number>();

  /**
   * Reconcile against the live job list and return the keys that are due now.
   * A job is never fired on the tick it is first seen — scheduling starts from
   * the moment it appears, so defining a `* * * * *` workflow doesn't fire it
   * a millisecond later.
   */
  due(jobs: Array<{ key: string; cron: string }>, now: number = Date.now()): string[] {
    const live = new Set(jobs.map((j) => j.key));
    for (const key of [...this.next.keys()]) if (!live.has(key)) this.next.delete(key);

    const fired: string[] = [];
    for (const job of jobs) {
      const at = this.next.get(job.key);
      if (at === undefined) {
        this.next.set(job.key, this.safeNext(job.cron, now));
        continue;
      }
      if (now >= at) {
        fired.push(job.key);
        this.next.set(job.key, this.safeNext(job.cron, now));
      }
    }
    return fired;
  }

  /** When a job is next due, if it is scheduled. */
  nextAt(key: string): number | undefined {
    return this.next.get(key);
  }

  /** A bad expression parks the job an hour out instead of throwing every tick. */
  private safeNext(expr: string, now: number): number {
    try {
      return nextRun(expr, now);
    } catch {
      return now + 3_600_000;
    }
  }
}
