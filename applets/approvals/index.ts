import {
  defineApplet,
  text,
  spacer,
  row,
  theme,
  type AppletCtx,
  type ViewNode,
  type DashCard,
} from "../../sdk/index.ts";
import { divider, recordRow, heading, badge } from "../../sdk/components.ts";
import { notify } from "../../server/notify.ts";
import { approvals, type AuditEntry, type PendingAction } from "../../server/approvals.ts";
import { securityConfig } from "../../core/config.ts";

/**
 * approvals — the human half of an agent's side effects.
 *
 * kona's whole thesis is that a keypress and an agent's POST fire the same verb
 * over the same state. The gap that opens up is consent: you pressed the key,
 * so the key is its own confirmation; nothing confirms the POST. So the daemon
 * holds an untrusted caller's far-reaching verbs (`high`, `critical` priority —
 * see `Priority` in the SDK) instead of running them, and parks them here.
 *
 * This applet is the tray. It shows what is queued WITH ITS EXACT ARGS — the
 * mail body, the room, the id being deleted — because "approve email.send" is
 * not a decision anybody can actually make. `a` runs it, `d` drops it, and
 * anything nobody comes back for expires on its own.
 *
 * The second tab is the audit trail: every agent-fired verb, held or not, with
 * who asked and what came back. The tray is the gate; the log is the receipt.
 *
 * State is a MIRROR, not a source: the queue lives in `server/approvals.ts`
 * (the daemon has to hold the promise a parked call is waiting on), and this
 * applet syncs from it whenever it changes. That is also why it is ephemeral —
 * a restart drops the queue, which is the right memory for "someone asked to
 * send this ten minutes ago".
 */

interface ApprovalsState {
  /** Waiting on you, oldest first. */
  pending: PendingAction[];
  /** What your agents did, newest first. */
  log: AuditEntry[];
  cursor: number;
  tab: Tab;
  /** Clock for the countdowns, refreshed by the tick. */
  now: number;
  /** What the last verb had to say — a denial, a failed run. */
  note: string | null;
}

type Tab = "pending" | "activity";
type Ctx = AppletCtx<ApprovalsState>;
type Args = Record<string, unknown>;

const TINT = "#f7768e";
/** Lines of the selected action's arguments the detail block shows. */
const DETAIL_LINES = 8;

const palette = () => {
  const t = theme();
  return { FG: t.fg, DIM: t.dim, MUTED: t.muted, OK: t.ok, WARN: t.warn, ERR: t.error, ACCENT: t.accent };
};

/** The color a priority level earns: how loud the row should be. */
function priorityColor(priority: string): string {
  const t = palette();
  return priority === "critical" ? t.ERR : priority === "high" ? t.WARN : t.DIM;
}

/** "4m", "38s", "now" — a countdown a human can act on. */
function left(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

/** "just now", "4m ago" — when the agent asked. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

/** The args as one line — enough to recognise the call in a list. */
function argLine(args: Args, max = 40): string {
  const keys = Object.keys(args ?? {});
  if (!keys.length) return "";
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The args in full, one `key: value` per line — the thing you are consenting to. */
function argLines(args: Args): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    const value = typeof v === "string" ? v : JSON.stringify(v);
    for (const line of String(value ?? "").split("\n")) out.push(`${k}: ${line}`);
  }
  return out;
}

/** Rows the current tab shows. */
const rowsOf = (s: ApprovalsState): Array<PendingAction | AuditEntry> =>
  s.tab === "pending" ? s.pending : s.log;

/** Keep the cursor on a real row after the list moves under it. */
function clamp(s: ApprovalsState): void {
  const n = rowsOf(s).length;
  s.cursor = n === 0 ? 0 : Math.max(0, Math.min(s.cursor, n - 1));
}

/** The pending action a verb acts on: `{id}` or `{index}` from an agent, else the cursor. */
function target(s: ApprovalsState, args: Args = {}): PendingAction | undefined {
  if (typeof args.id === "string") return s.pending.find((p) => p.id === args.id);
  if (typeof args.index === "number") return s.pending[args.index];
  return s.tab === "pending" ? s.pending[s.cursor] : undefined;
}

/**
 * Pull the tray into state and repaint. Called from the registry's change
 * listener, from the tick, and after every verb — one function, so the screen
 * and the queue can never disagree.
 */
function sync(ctx: Ctx): void {
  ctx.state.pending = approvals.list();
  ctx.state.log = approvals.log();
  ctx.state.now = Date.now();
  clamp(ctx.state);
  ctx.emit();
}

export default defineApplet<ApprovalsState>({
  id: "approvals",
  title: "Approvals",
  summary: "Agent-proposed actions waiting on you, and what your agents did",
  icon: "!",
  tint: TINT,
  labels: ["security", "agents"],
  // The queue lives in the daemon's memory and the promises inside it cannot
  // survive a restart, so persisting the mirror would only ever show ghosts.
  ephemeral: true,

  initialState: {
    pending: [],
    log: [],
    cursor: 0,
    tab: "pending",
    now: 0,
    note: null,
  },

  /**
   * Approving RUNS the held verb, so both of these are as far-reaching as
   * whatever they release. Declaring that is mostly bookkeeping — the daemon
   * refuses an untrusted caller on this applet outright, because an approval an
   * agent could approve is not an approval.
   */
  priority: {
    approve: "high",
    approveAll: "high",
    deny: "critical",
    denyAll: "critical",
    clear: "critical",
    refresh: "low",
  },

  docs: {
    approve: {
      doc: "Run a held action. The human's verb: an agent calling it is refused, not queued.",
      args: { id: "p1" },
    },
    deny: { doc: "Drop a held action. The caller waiting on it sees a rejection.", args: { id: "p1" } },
    approveAll: "Run everything in the queue.",
    denyAll: "Drop everything in the queue.",
    clear: "Empty the activity log.",
    refresh: "Re-read the queue and the log.",
    tab: { doc: "Switch between the pending queue and the activity log.", args: { to: "activity" } },
    select: "Move the human's selection to a row.",
  },

  notifications: {
    "approvals.pending": {
      summary: "an agent asks to run a guarded verb",
      // The whole point is reaching you when you are not looking at the tray.
      default: true,
    },
  },

  verbs: {
    async approve(args, ctx) {
      const action = target(ctx.state, args);
      if (!action) {
        ctx.state.note = "nothing to approve";
        ctx.emit();
        return { error: "no such pending action" };
      }
      const entry = await approvals.approve(action.id);
      ctx.state.note =
        entry.outcome === "failed"
          ? `${action.applet}.${action.verb} failed: ${entry.error}`
          : `ran ${action.applet}.${action.verb}`;
      sync(ctx);
      return { id: action.id, outcome: entry.outcome, result: entry.result, error: entry.error };
    },

    deny(args, ctx) {
      const action = target(ctx.state, args);
      if (!action) {
        ctx.state.note = "nothing to deny";
        ctx.emit();
        return { error: "no such pending action" };
      }
      const why = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "denied";
      approvals.deny(action.id, why);
      ctx.state.note = `denied ${action.applet}.${action.verb}`;
      sync(ctx);
      return { id: action.id, outcome: "denied" as const };
    },

    async approveAll(_args, ctx) {
      const ids = ctx.state.pending.map((p) => p.id);
      const outcomes: Array<{ id: string; outcome: string }> = [];
      for (const id of ids) {
        try {
          const entry = await approvals.approve(id);
          outcomes.push({ id, outcome: entry.outcome });
        } catch {
          /* decided under us — the sync below has the truth */
        }
      }
      ctx.state.note = ids.length ? `ran ${ids.length} action${ids.length === 1 ? "" : "s"}` : "nothing waiting";
      sync(ctx);
      return { approved: outcomes };
    },

    denyAll(_args, ctx) {
      const ids = ctx.state.pending.map((p) => p.id);
      for (const id of ids) {
        try {
          approvals.deny(id, "denied");
        } catch {
          /* already gone */
        }
      }
      ctx.state.note = ids.length ? `denied ${ids.length}` : "nothing waiting";
      sync(ctx);
      return { denied: ids };
    },

    clear(_args, ctx) {
      const n = approvals.clearLog();
      ctx.state.note = n ? `cleared ${n} from the activity log` : "activity log was already empty";
      sync(ctx);
      return { cleared: n };
    },

    refresh(_args, ctx) {
      approvals.sweep();
      ctx.state.note = null;
      sync(ctx);
      return { pending: ctx.state.pending.length };
    },

    tab(args, ctx) {
      const to = typeof args.to === "string" ? args.to : null;
      ctx.state.tab = to === "pending" || to === "activity" ? to : ctx.state.tab === "pending" ? "activity" : "pending";
      ctx.state.cursor = 0;
      ctx.emit();
      return { tab: ctx.state.tab };
    },

    up(_args, ctx) {
      ctx.state.cursor = Math.max(0, ctx.state.cursor - 1);
      ctx.emit();
    },

    down(_args, ctx) {
      ctx.state.cursor = Math.min(Math.max(0, rowsOf(ctx.state).length - 1), ctx.state.cursor + 1);
      ctx.emit();
    },

    select(args, ctx) {
      if (typeof args.index === "number") ctx.state.cursor = args.index;
      clamp(ctx.state);
      ctx.emit();
      return { cursor: ctx.state.cursor };
    },
  },

  /**
   * The registry is the source; this is the subscription that keeps the mirror
   * honest — and the one place a new pending action becomes a desktop banner,
   * since "an agent is waiting on you" is exactly the thing you are not looking
   * at the terminal for.
   */
  init(ctx) {
    approvals.onChange((e) => {
      if (e.type === "parked") {
        const { action } = e;
        void notify({
          event: "approvals.pending",
          title: "kona — approval needed",
          subtitle: `${action.applet}.${action.verb}`,
          body: `${action.requestedBy} wants to run it${argLine(action.args, 60) ? ` — ${argLine(action.args, 60)}` : ""}`,
          key: `approvals.pending:${action.id}`,
        });
      }
      sync(ctx);
    });
    sync(ctx);
  },

  /** Expire what nobody came back for, and keep the countdowns moving. */
  tickMs: 1_000,
  tick(ctx) {
    const gone = approvals.sweep();
    ctx.state.now = Date.now();
    if (gone.length) ctx.state.note = `${gone.length} expired unanswered`;
    sync(ctx);
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(36, (ctx?.width ?? 62) - 4);
    const t = palette();
    const out: ViewNode[] = [];
    const waiting = state.pending.length;
    const policy = securityConfig();

    out.push(
      row([
        text(state.tab === "pending" ? "▸ pending" : "  pending", {
          color: state.tab === "pending" ? t.ACCENT : t.MUTED,
        }),
        text("   "),
        text(state.tab === "activity" ? "▸ activity" : "  activity", {
          color: state.tab === "activity" ? t.ACCENT : t.MUTED,
        }),
        text("   "),
        waiting ? badge(`${waiting} waiting`, t.WARN) : text("clear", { color: t.MUTED }),
      ]),
      divider(Math.min(W, 46), { color: t.MUTED }),
    );

    if (state.tab === "pending") {
      if (!waiting) {
        out.push(
          spacer(),
          text("Nothing waiting on you.", { color: t.DIM }),
          spacer(),
          text(
            policy.hold === "none"
              ? `hold = "none" — agents fire everything without asking.`
              : `Held for you: ${policy.hold === "all-writes" ? "every write an agent makes" : "high and critical priority verbs"}.`,
            { color: t.MUTED },
          ),
          text("An agent's guarded verb parks here instead of running.", { color: t.MUTED }),
        );
      } else {
        state.pending.forEach((p, i) => {
          out.push(
            recordRow(
              [
                { text: `${p.applet}.${p.verb}`, width: Math.max(16, Math.floor(W * 0.34)) },
                { text: argLine(p.args, W), grow: true },
                { text: left(p.expiresAt - state.now), width: 8, align: "right" },
              ],
              { width: W, selected: i === state.cursor, accent: TINT, color: priorityColor(p.priority), index: i },
            ),
          );
        });
        const sel = state.pending[state.cursor];
        if (sel) {
          out.push(spacer(), heading("what it would do", t.DIM));
          out.push(
            text(`${sel.applet}.${sel.verb}`, { color: priorityColor(sel.priority) }),
            text(`${sel.priority} · asked by ${sel.requestedBy} ${ago(sel.requestedAt, state.now)}`, { color: t.MUTED }),
          );
          const lines = argLines(sel.args);
          if (lines.length) for (const line of lines.slice(0, DETAIL_LINES)) out.push(text(`  ${line}`, { color: t.FG }));
          else out.push(text("  (no arguments)", { color: t.MUTED }));
          out.push(text(`held because ${sel.reason}`, { color: t.MUTED }));
        }
      }
    } else if (!state.log.length) {
      out.push(spacer(), text("No agent has fired a verb yet.", { color: t.DIM }));
    } else {
      state.log.forEach((e, i) => {
        const mark = e.outcome === "ran" ? "✓" : e.outcome === "denied" ? "✕" : e.outcome === "expired" ? "⧗" : "!";
        const color = e.outcome === "ran" ? (e.allowed ? t.DIM : t.OK) : e.outcome === "denied" ? t.MUTED : t.WARN;
        out.push(
          recordRow(
            [
              { text: `${mark} ${e.applet}.${e.verb}`, width: Math.max(18, Math.floor(W * 0.36)) },
              { text: e.error ?? e.result ?? argLine(e.args, W), grow: true },
              { text: `${e.by} ${ago(e.at, state.now)}`, width: 16, align: "right" },
            ],
            { width: W, selected: i === state.cursor, accent: TINT, color, index: i },
          ),
        );
      });
    }

    if (state.note) out.push(spacer(), text(state.note, { color: t.DIM }));
    return out;
  },

  accent: (s) => (s.pending.length ? TINT : theme().muted),

  crumb: (s) => (s.tab === "activity" ? "activity" : null),

  /**
   * One card, and it is loud: something is waiting on a human and nothing else
   * on the machine can move it along.
   */
  dash: (s): DashCard | null => {
    const n = s.pending.length;
    if (!n) return null;
    const first = s.pending[0]!;
    return {
      id: "pending",
      priority: 90,
      text: `! ${n} pending approval${n === 1 ? "" : "s"}  ·  ${first.applet}.${first.verb}`,
      note: left(first.expiresAt - (s.now || Date.now())),
      color: TINT,
    };
  },

  keymap: {
    a: { verb: "approve", label: "approve", when: (s) => s.tab === "pending" && s.pending.length > 0 },
    d: { verb: "deny", label: "deny", when: (s) => s.tab === "pending" && s.pending.length > 0 },
    A: { verb: "approveAll", label: "approve all", when: (s) => s.pending.length > 1 },
    D: { verb: "denyAll", label: "deny all", when: (s) => s.pending.length > 1 },
    tab: { verb: "tab", label: "pending/activity" },
    c: { verb: "clear", label: "clear log", when: (s) => s.tab === "activity" && s.log.length > 0 },
    r: { verb: "refresh", label: "refresh" },
  },

  nav: { up: "up", down: "down", select: "select" },

  recipes: [
    {
      title: "Propose a guarded action and wait for the human",
      steps: [
        `kona tools --json | grep guarded            # which verbs park instead of running`,
        `kona call email send '{"to":"ada@example.com","subject":"ship it","body":"rc1 is up"}'`,
        `#   -> { "ok": false, "pending": "p3", "hint": "held for a human: high-priority verbs need a human" }`,
        `curl -s localhost:4177/approvals/p3          # "pending" until they decide, then the result`,
      ],
      note: "A held call is not a failure — it is a proposal. Watch `GET /approvals/<id>` (or the `approval` SSE event) rather than re-firing it, and never try to approve your own: `approvals.approve` refuses any caller but the human.",
    },
  ],
});
