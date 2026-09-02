import type { Priority } from "../sdk/index.ts";

/**
 * The pending tray: agent proposes, human disposes.
 *
 * When an untrusted caller fires a guarded verb (core/guard.ts said `hold`),
 * the daemon does not run it. It parks the call here — applet, verb, the exact
 * args — and hands the caller back an id. A human sees the queue (the
 * `approvals` applet, a dash card, a desktop banner), reads what was asked for,
 * and approves or denies it. Approving is what finally runs the verb, through
 * the same `invoke` every other caller uses.
 *
 * Two shapes come out of one park, which is what lets both callers be served
 * honestly:
 *   - the ENTRY, plain data, mirrored into applet state and the audit log;
 *   - a PROMISE that settles when a human decides, so a caller that can wait
 *     (a workflow step, `ctx.call`) simply pauses mid-run and resumes on
 *     approve, while HTTP returns `{ pending: id }` and moves on.
 *
 * Everything is in memory and daemon-lifetime: a restart drops the queue, which
 * is the correct amount of memory for "someone asked to send this mail ten
 * minutes ago". The audit log is the same — a small window on what your agents
 * did, not a compliance archive.
 */

/** What a parked action is waiting on, or what became of it. */
export type Outcome = "pending" | "ran" | "denied" | "expired" | "failed";

/** One action waiting for a human. Plain data — it crosses into applet state. */
export interface PendingAction {
  id: string;
  applet: string;
  verb: string;
  args: Record<string, unknown>;
  priority: Priority;
  /** Epoch ms the agent asked. */
  requestedAt: number;
  /** Who asked, as they named themselves (the `x-kona-caller` header). */
  requestedBy: string;
  /** Why it is being held, in one phrase — see core/guard.ts. */
  reason: string;
  /** Epoch ms after which it is dropped unasked. */
  expiresAt: number;
}

/** A decided (or allowed-through) call, for the activity log. */
export interface AuditEntry {
  id: string;
  applet: string;
  verb: string;
  args: Record<string, unknown>;
  priority: Priority;
  at: number;
  by: string;
  outcome: Outcome;
  /** Epoch ms a human (or the sweeper) decided. Absent for a straight-through call. */
  decidedAt?: number;
  /** True when the call ran without ever being held — the audit half. */
  allowed?: boolean;
  /** A short receipt of what the verb returned, when it ran. */
  result?: string;
  /** Why it failed, when it did. */
  error?: string;
}

/** What changed, so a listener can both repaint and decide whether to banner. */
export type ApprovalEvent =
  | { type: "parked"; action: PendingAction }
  | { type: "decided"; entry: AuditEntry }
  | { type: "logged"; entry: AuditEntry };

export interface ParkRequest {
  applet: string;
  verb: string;
  args: Record<string, unknown>;
  priority: Priority;
  requestedBy: string;
  reason: string;
  /** How long it waits. The daemon passes `[security] expire`. */
  expiresMs: number;
}

/** A parked call: what to show, and what to await. */
export interface Parked {
  action: PendingAction;
  /** Settles with the verb's result on approve; rejects on deny or expiry. */
  settled: Promise<unknown>;
}

/**
 * What an HTTP caller gets instead of a result: the call is parked, here is its
 * id. A caller that can wait (a workflow step) awaits `Parked.settled` instead
 * and never sees one of these.
 */
export class PendingResult {
  constructor(public readonly action: PendingAction) {}
}

/** How many decided calls the activity log keeps. */
const LOG_MAX = 50;
/** A logged result is a receipt, not a payload. */
const RESULT_MAX = 200;

/** A short, readable receipt of whatever a verb handed back. */
function receipt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined || s === "") return undefined;
  return s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…` : s;
}

interface Slot {
  action: PendingAction;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * The registry. One per daemon process — `approvals` below is that one; the
 * class is exported so a test can drive an isolated tray.
 */
export class Approvals {
  private slots = new Map<string, Slot>();
  private entries: AuditEntry[] = [];
  private listeners = new Set<(e: ApprovalEvent) => void>();
  private seq = 0;

  /** Subscribe to changes; returns the unsubscribe. */
  onChange(fn: (e: ApprovalEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private announce(e: ApprovalEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a listener's problem is never the tray's */
      }
    }
  }

  /** Actions still waiting, oldest first (the order a human works through). */
  list(): PendingAction[] {
    return [...this.slots.values()].map((s) => s.action).sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** What your agents did, newest first. */
  log(): AuditEntry[] {
    return this.entries;
  }

  get pendingCount(): number {
    return this.slots.size;
  }

  find(id: string): PendingAction | undefined {
    return this.slots.get(id)?.action;
  }

  private push(entry: AuditEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > LOG_MAX) this.entries.length = LOG_MAX;
  }

  /**
   * Record a call that was NOT held — the audit half of the feature. Every
   * agent-fired verb ends up in the log; only the guarded ones stop first.
   */
  record(call: {
    applet: string;
    verb: string;
    args: Record<string, unknown>;
    priority: Priority;
    by: string;
    result?: unknown;
    error?: string;
  }): AuditEntry {
    const entry: AuditEntry = {
      id: `a${++this.seq}`,
      applet: call.applet,
      verb: call.verb,
      args: call.args,
      priority: call.priority,
      at: Date.now(),
      by: call.by,
      outcome: call.error ? "failed" : "ran",
      allowed: true,
    };
    const r = receipt(call.result);
    if (r !== undefined) entry.result = r;
    if (call.error) entry.error = call.error;
    this.push(entry);
    this.announce({ type: "logged", entry });
    return entry;
  }

  /**
   * Hold a call. `run` is what approving will actually do — the daemon's own
   * `invoke`, already bound to the applet, verb and args — so the tray never
   * learns what a verb is.
   */
  park(req: ParkRequest, run: () => Promise<unknown>): Parked {
    const now = Date.now();
    const action: PendingAction = {
      id: `p${++this.seq}`,
      applet: req.applet,
      verb: req.verb,
      args: req.args,
      priority: req.priority,
      requestedAt: now,
      requestedBy: req.requestedBy,
      reason: req.reason,
      expiresAt: now + req.expiresMs,
    };
    let resolve!: (value: unknown) => void;
    let reject!: (err: Error) => void;
    const settled = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // The HTTP caller gets an id and walks away, so nobody may be holding this
    // promise when a human denies it. Keep a handler on it so a denial is a
    // decision, not an unhandled rejection.
    settled.catch(() => {});
    this.slots.set(action.id, { action, run, resolve, reject });
    this.announce({ type: "parked", action });
    return { action, settled };
  }

  /** Run a parked action. Resolves with the verb's result. */
  async approve(id: string): Promise<AuditEntry> {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`no pending action ${id}`);
    this.slots.delete(id);
    const entry: AuditEntry = {
      ...base(slot.action),
      outcome: "ran",
      decidedAt: Date.now(),
    };
    try {
      const result = await slot.run();
      const r = receipt(result);
      if (r !== undefined) entry.result = r;
      slot.resolve(result);
    } catch (e) {
      entry.outcome = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
      slot.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this.push(entry);
    this.announce({ type: "decided", entry });
    return entry;
  }

  /** Drop a parked action. The waiting caller (if any) sees a rejection. */
  deny(id: string, why = "denied"): AuditEntry {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`no pending action ${id}`);
    this.slots.delete(id);
    const entry: AuditEntry = { ...base(slot.action), outcome: "denied", decidedAt: Date.now(), error: why };
    slot.reject(new Error(`${slot.action.applet}.${slot.action.verb}: ${why}`));
    this.push(entry);
    this.announce({ type: "decided", entry });
    return entry;
  }

  /**
   * Drop everything past its expiry. Called from the applet's tick, so an
   * unattended machine forgets what nobody came back for. Returns what went.
   */
  sweep(now = Date.now()): AuditEntry[] {
    const gone: AuditEntry[] = [];
    for (const [id, slot] of [...this.slots]) {
      if (slot.action.expiresAt > now) continue;
      this.slots.delete(id);
      const entry: AuditEntry = { ...base(slot.action), outcome: "expired", decidedAt: now };
      slot.reject(new Error(`${slot.action.applet}.${slot.action.verb}: approval expired`));
      this.push(entry);
      gone.push(entry);
      this.announce({ type: "decided", entry });
    }
    return gone;
  }

  /** Empty the activity log. The queue is untouched — that is `deny`'s job. */
  clearLog(): number {
    const n = this.entries.length;
    this.entries = [];
    return n;
  }

  /** Test seam: forget the queue and the log. */
  reset(): void {
    for (const [id] of [...this.slots]) this.deny(id, "reset");
    this.slots.clear();
    this.entries = [];
    this.seq = 0;
  }
}

/** The audit fields a pending action carries into the log unchanged. */
function base(a: PendingAction): Omit<AuditEntry, "outcome"> {
  return { id: a.id, applet: a.applet, verb: a.verb, args: a.args, priority: a.priority, at: a.requestedAt, by: a.requestedBy };
}

/**
 * The process-wide tray. The daemon parks into it; the `approvals` applet reads
 * and decides through it. A module singleton is the same seam `server/notify.ts`
 * uses — verbs run in the daemon, so "the daemon's tray" and "the module's
 * tray" are the same object.
 */
export const approvals = new Approvals();
