import { defineApplet, text, spacer, col, input, theme, type AppletCtx, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow, modal, field as labelled, heading } from "../../sdk/components.ts";
import { describeCron, nextRun, validateCron } from "../../server/cron.ts";
import {
  runWorkflow,
  parseStep,
  stepText,
  toMarkdown,
  fromMarkdown,
  type Run,
  type Workflow,
  type WorkflowStep,
} from "../../server/workflows.ts";

/**
 * workflows — Shortcuts for applets.
 *
 * A workflow is a named, ordered list of verb calls across applets. It is the
 * bimodal thesis applied to itself: the SAME workflow can be built with a text
 * field in the TUI, defined by an agent with `kona call workflows define`, and
 * fired by the daemon on a cron expression — and the steps it runs are ordinary
 * verb calls, indistinguishable from an agent's POST or a human's keypress.
 *
 * Three seams make that work and none of them live here:
 *   - `ctx.call` (sdk) — an applet fires another applet's verb.
 *   - `cron(state)` (sdk + daemon) — the daemon schedules verbs off live state,
 *     so a workflow scheduled a second ago is on the calendar immediately.
 *   - `server/workflows.ts` — the engine: sequencing, `{{…}}` templating
 *     between steps, `when` conditionals, and the SKILL.md import/export that
 *     keeps a workflow shareable text rather than a row in someone's database.
 */

interface Dialog {
  kind: "name" | "step" | "cron" | "remove";
  /** The workflow the dialog is about (id), or null for "new". */
  target: string | null;
  value: string;
}

interface WorkflowsState {
  workflows: Workflow[];
  /** Newest first, bounded. One history across every workflow. */
  runs: Run[];
  /** Row cursor: a workflow in the list, a step in the detail view. */
  cursor: number;
  /** Workflow id being viewed, or null for the list. */
  open: string | null;
  dialog: Dialog | null;
  /** Workflow ids with a run in flight — also the re-entrancy guard. */
  running: string[];
  error: string | null;
}

type Ctx = AppletCtx<WorkflowsState>;
type Result = Record<string, unknown>;

const RUNS_MAX = 20;
/** A step's stored result is a receipt, not a payload: keep it small. */
const RESULT_MAX = 400;

const palette = () => {
  const t = theme();
  return { ACCENT: t.alt, OK: t.ok, WARN: t.warn, ERR: t.error, FG: t.fg, DIM: t.dim, MUTED: t.muted };
};

// --- helpers ---------------------------------------------------------------

const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workflow";

/** A unique id from the name, so `{{…}}` refs and CLI calls stay readable. */
function freshId(state: WorkflowsState, name: string): string {
  const base = slug(name);
  if (!state.workflows.some((w) => w.id === base)) return base;
  for (let i = 2; ; i++) if (!state.workflows.some((w) => w.id === `${base}-${i}`)) return `${base}-${i}`;
}

/** Resolve `{id}`/`{name}`/`{index}` (an agent) or the open view / cursor (a keypress). */
function target(state: WorkflowsState, args: Result = {}): Workflow | undefined {
  if (typeof args.id === "string") return state.workflows.find((w) => w.id === args.id);
  const name = args.name ?? args.workflow;
  if (typeof name === "string" && name) {
    const s = slug(name);
    // A named workflow that doesn't exist is a miss, never "whatever is selected".
    return state.workflows.find((w) => w.id === name || w.id === s || w.name.toLowerCase() === name.toLowerCase());
  }
  if (typeof args.index === "number" && !state.open) return state.workflows[args.index];
  if (state.open) return state.workflows.find((w) => w.id === state.open);
  return state.workflows[state.cursor];
}

/** Accept steps as objects or as the `applet.verb {args}` lines a human types. */
function parseSteps(raw: unknown): WorkflowStep[] | { error: string } {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const steps: WorkflowStep[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const parsed = parseStep(item);
      if ("error" in parsed) return parsed;
      steps.push(parsed);
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Result;
      if (typeof o.applet === "string" && typeof o.verb === "string") {
        const step: WorkflowStep = { applet: o.applet, verb: o.verb };
        if (o.args && typeof o.args === "object" && !Array.isArray(o.args)) step.args = o.args as Result;
        if (typeof o.when === "string") step.when = o.when;
        if (typeof o.as === "string") step.as = o.as;
        steps.push(step);
        continue;
      }
      if (typeof o.step === "string") {
        const parsed = parseStep(o.step);
        if ("error" in parsed) return parsed;
        steps.push(parsed);
        continue;
      }
    }
    return { error: `a step is "<applet>.<verb> {args}" or { applet, verb, args }` };
  }
  return steps;
}

/** Trim a step's result before it goes into persisted, streamed history. */
function compact(result: unknown): unknown {
  if (result === undefined) return undefined;
  const json = JSON.stringify(result);
  if (json === undefined) return String(result);
  if (json.length <= RESULT_MAX) return result;
  return { elided: `${json.length} bytes`, preview: `${json.slice(0, 120)}…` };
}

/** The run as it is recorded: same shape, smaller results. */
function record(run: Run): Run {
  return { ...run, steps: run.steps.map((s) => ({ ...s, result: compact(s.result) })) };
}

const relative = (at: number, now = Date.now()): string => {
  const d = Math.max(0, now - at);
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};

const until = (at: number, now = Date.now()): string => {
  const d = Math.max(0, at - now);
  if (d < 60_000) return `in ${Math.round(d / 1000)}s`;
  if (d < 3_600_000) return `in ${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `in ${Math.round(d / 3_600_000)}h`;
  return `in ${Math.round(d / 86_400_000)}d`;
};

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The last run of one workflow, if there is one. */
const lastRun = (state: WorkflowsState, id: string): Run | undefined => state.runs.find((r) => r.workflow === id);

/** nextRun, but a bad expression parked in state can't take the view down. */
function safeNext(expr: string): number | null {
  try {
    return nextRun(expr);
  } catch {
    return null;
  }
}

// --- the operations --------------------------------------------------------
// Each is one function, called BOTH by the verb an agent fires and by the TUI
// form that fills its arguments in. There is exactly one implementation of
// "define a workflow" and the keyboard doesn't get a private copy of it.

function doDefine(ctx: Ctx, args: Result): Result {
  const { state, emit } = ctx;
  const name = typeof args.name === "string" ? args.name.trim() : typeof args.q === "string" ? args.q.trim() : "";
  if (!name) {
    state.dialog = { kind: "name", target: null, value: "" };
    emit();
    return { dialog: "name" };
  }
  const steps = parseSteps(args.steps);
  if ("error" in steps) return fail(ctx, steps.error);
  const cron = typeof args.cron === "string" && args.cron.trim() ? args.cron.trim() : null;
  if (cron) {
    const bad = validateCron(cron);
    if (bad) return fail(ctx, bad);
  }

  const now = Date.now();
  const existing = state.workflows.find((w) => w.name.toLowerCase() === name.toLowerCase() || w.id === slug(name));
  const wf: Workflow = existing
    ? { ...existing, name, steps: steps.length ? steps : existing.steps, updatedAt: now }
    : { id: freshId(state, name), name, steps, enabled: true, createdAt: now, updatedAt: now };
  if (typeof args.summary === "string") wf.summary = args.summary;
  if ("cron" in args) wf.cron = cron;
  if (args.params && typeof args.params === "object" && !Array.isArray(args.params)) wf.params = args.params as Result;
  if (typeof args.enabled === "boolean") wf.enabled = args.enabled;

  state.workflows = existing ? state.workflows.map((w) => (w.id === existing.id ? wf : w)) : [...state.workflows, wf];
  if (!state.open) state.cursor = state.workflows.findIndex((w) => w.id === wf.id);
  state.dialog = null;
  state.error = null;
  emit();
  return { id: wf.id, name: wf.name, steps: wf.steps.length, cron: wf.cron ?? null, replaced: !!existing };
}

function doAddStep(ctx: Ctx, args: Result): Result {
  const { state, emit } = ctx;
  const wf = target(state, args);
  if (!wf) return { error: "no such workflow" };
  const raw = args.step ?? args.value ?? args.q;
  if (raw === undefined || raw === "") {
    state.dialog = { kind: "step", target: wf.id, value: "" };
    emit();
    return { dialog: "step" };
  }
  const steps = parseSteps(raw);
  if ("error" in steps) return fail(ctx, steps.error);
  const at = typeof args.index === "number" ? Math.max(0, Math.min(wf.steps.length, args.index)) : wf.steps.length;
  wf.steps.splice(at, 0, ...steps);
  wf.updatedAt = Date.now();
  state.dialog = null;
  state.error = null;
  if (state.open === wf.id) state.cursor = at;
  emit();
  return { id: wf.id, added: steps.map(stepText), steps: wf.steps.length };
}

function doSchedule(ctx: Ctx, args: Result): Result {
  const { state, emit } = ctx;
  const wf = target(state, args);
  if (!wf) return { error: "no such workflow" };
  // `?? ` would swallow an explicit null, and an explicit null is how a caller
  // says "take this off the clock" — so look for the KEY, not a truthy value.
  const key = ["cron", "schedule", "value", "q"].find((k) => k in args);
  const raw = key === undefined ? undefined : args[key];
  if (raw === undefined) {
    state.dialog = { kind: "cron", target: wf.id, value: wf.cron ?? "" };
    emit();
    return { dialog: "cron" };
  }
  if (raw === null || raw === "") {
    wf.cron = null;
    wf.updatedAt = Date.now();
    state.dialog = null;
    state.error = null;
    emit();
    return { id: wf.id, cron: null };
  }
  const expr = String(raw).trim();
  const bad = validateCron(expr);
  if (bad) return fail(ctx, bad);
  wf.cron = expr;
  wf.enabled = true;
  wf.updatedAt = Date.now();
  state.dialog = null;
  state.error = null;
  emit();
  return { id: wf.id, cron: expr, describes: describeCron(expr), next: nextRun(expr) };
}

function doRemove(ctx: Ctx, wf: Workflow): Result {
  const { state, emit } = ctx;
  state.workflows = state.workflows.filter((w) => w.id !== wf.id);
  state.runs = state.runs.filter((r) => r.workflow !== wf.id);
  if (state.open === wf.id) state.open = null;
  state.cursor = Math.max(0, Math.min(state.cursor, state.workflows.length - 1));
  state.dialog = null;
  emit();
  return { removed: wf.name, workflows: state.workflows.length };
}

/** Park an error where both the view and the caller can see it. */
function fail(ctx: Ctx, error: string): Result {
  ctx.state.error = error;
  ctx.emit();
  return { error };
}

/** Fire a workflow through the engine and file the result. */
async function execute(ctx: Ctx, wf: Workflow, args: Result): Promise<Result> {
  const { state, emit } = ctx;
  if (!ctx.call) return { error: "this daemon can't fire verbs (no call seam)" };
  if (state.running.includes(wf.id)) return { error: `${wf.name} is already running` };

  const trigger = args.trigger === "cron" || args.trigger === "agent" ? args.trigger : "manual";
  const params =
    args.params && typeof args.params === "object" && !Array.isArray(args.params) ? (args.params as Result) : {};

  state.running = [...state.running, wf.id];
  state.error = null;
  emit();
  try {
    const run = await runWorkflow(wf, { call: (a, v, x) => ctx.call!(a, v, x), params, trigger });
    state.runs = [record(run), ...state.runs].slice(0, RUNS_MAX);
    state.error = run.ok ? null : (run.error ?? "workflow failed");
    return {
      run: run.id,
      workflow: wf.id,
      ok: run.ok,
      ms: run.ms,
      ...(run.error ? { error: run.error } : {}),
      steps: run.steps.map((s) => ({
        step: `${s.applet}.${s.verb}`,
        ...(s.skipped ? { skipped: true } : { ok: s.ok }),
        ...(s.error ? { error: s.error } : {}),
        ...(s.result === undefined ? {} : { result: compact(s.result) }),
      })),
    };
  } finally {
    state.running = state.running.filter((id) => id !== wf.id);
    emit();
  }
}

export default defineApplet<WorkflowsState>({
  id: "workflows",
  title: "Workflows",
  summary: "Named sequences of applet verbs — run them by hand, or on a cron.",
  cli: {
    usage: "kona workflows <name>",
    // `kona workflows morning` opens straight into that workflow's steps.
    open: (args) => (args[0] ? { verb: "open", args: { name: args.join(" ") } } : null),
  },
  initialState: { workflows: [], runs: [], cursor: 0, open: null, dialog: null, running: [], error: null },

  docs: {
    define: {
      doc:
        "Create or replace a workflow. `steps` takes `\"applet.verb {json}\"` lines or `{applet,verb,args}` " +
        "objects; `cron` schedules it. With no `name` (a keypress) it opens the TUI's new-workflow form.",
      args: {
        name: "morning",
        summary: "Start the day",
        cron: "30 8 * * 1-5",
        steps: [
          'spotify.play {"uri":"spotify:playlist:37i9dQZF1DX0XUsuxWHRQd"}',
          'timer.start {"seconds":1500,"label":"focus"}',
          'notes.add {"text":"focus block started {{now}}"}',
        ],
      },
    },
    run: {
      doc: "Run a workflow now. `params` fills its `{{params.x}}` references; the result reports every step.",
      args: { name: "morning", params: { room: "ship-kona" } },
    },
    addStep: {
      doc: "Append a step (same line format as `define`); `index` inserts instead. No `step` opens the builder field.",
      args: { name: "morning", step: 'notes.add {"text":"stand-up in 10"}' },
    },
    removeStep: { doc: "Drop a step by position (0-based).", args: { name: "morning", index: 2 } },
    schedule: {
      doc:
        "Put a workflow on the daemon's clock: a 5-field cron expression, `@daily`, or `@every 10m`; " +
        "`null` clears it. The daemon then fires it exactly like an agent calling `workflows.run`.",
      args: { name: "morning", cron: "30 8 * * 1-5" },
    },
    toggle: { doc: "Pause or resume a schedule without losing the expression.", args: { name: "morning", enabled: false } },
    remove: { doc: "Delete a workflow. With no `name` (a keypress) it asks first.", args: { name: "morning" } },
    runStep: { doc: "Fire ONE step on its own — how you test a step while building.", args: { name: "morning", index: 0 } },
    open: { doc: "Show one workflow's steps (what `kona workflows <name>` opens into).", args: { name: "morning" } },
    field: "A keystroke in the open form's field. The TUI's business — pass whole arguments to define/addStep/schedule instead.",
    form: "Submit the open form, through the same verb the form is filling in.",
    confirm: "Answer the delete dialog's question.",
    dismiss: "Close the open form or dialog.",
    export: {
      doc: "Render a workflow as a portable SKILL.md-shaped document (frontmatter + `kona call` steps). `all` exports every one.",
      args: { name: "morning" },
    },
    import: {
      doc: "Define a workflow from that document — how one machine's workflow lands on another.",
      args: {
        markdown:
          "---\nname: morning\nschedule: 30 8 * * 1-5\n---\n\n## Steps\n\n```sh\nkona call timer start '{\"seconds\":1500}'\n```\n",
      },
    },
    clear: "Forget the run history (the workflows stay).",
  },

  recipes: [
    {
      title: "Define a workflow and run it",
      steps: [
        `kona call workflows define '{"name":"focus","steps":["timer.start {\\"seconds\\":1500,\\"label\\":\\"focus\\"}","notes.add {\\"text\\":\\"focus block at {{now}}\\"}"]}'`,
        `kona call workflows run '{"name":"focus"}'    # -> { ok: true, steps: [...] }`,
        `kona state workflows                          # the run history, newest first`,
      ],
      note: "Steps are ordinary verb calls — anything in `kona tools` can be one.",
    },
    {
      title: "Put a workflow on the daemon's clock",
      steps: [
        `kona call workflows schedule '{"name":"focus","cron":"30 8 * * 1-5"}'`,
        `kona call workflows toggle '{"name":"focus","enabled":false}'   # pause, keep the expression`,
      ],
      note: "The daemon fires scheduled workflows itself — no terminal has to be open.",
    },
    {
      title: "Feed one step's result to the next",
      steps: [
        `kona call workflows define '{"name":"triage","steps":["email.refresh","mycelium.post {\\"room\\":\\"{{params.room}}\\",\\"text\\":\\"inbox: {{steps.0.unread}} unread\\"}"]}'`,
        `kona call workflows run '{"name":"triage","params":{"room":"ship-kona"}}'`,
      ],
      note: "`{{steps.<n>.…}}`, `{{last.…}}`, `{{params.…}}` and `{{now}}` resolve per run; a step's `when` skips it.",
    },
    {
      title: "Move a workflow to another machine",
      steps: [
        `kona call workflows export '{"name":"focus"}'    # -> { markdown: "---\\nname: focus\\n..." }`,
        `kona call workflows import '{"markdown":"<that document>"}'`,
      ],
      note: "The document is SKILL.md-shaped: frontmatter plus literal `kona call` lines, so it reads as a skill.",
    },
  ],

  verbs: {
    /**
     * Create or replace a workflow. With no name this opens the TUI form — one
     * verb, and the keypress only fills the arguments in.
     */
    define: (args, ctx) => doDefine(ctx, args),

    /** Run a workflow now — by name, id, index, or whatever is selected. */
    async run(args, ctx) {
      const wf = target(ctx.state, args);
      if (!wf) return { error: "no such workflow" };
      if (!wf.steps.length) return { error: `${wf.name} has no steps yet` };
      return execute(ctx, wf, args);
    },

    /** Fire one step on its own, with an empty scope — the builder's test button. */
    async runStep(args, ctx) {
      const wf = target(ctx.state, args);
      if (!wf) return { error: "no such workflow" };
      const i = typeof args.index === "number" ? args.index : ctx.state.cursor;
      const step = wf.steps[i];
      if (!step) return { error: `no step ${i}` };
      if (!ctx.call) return { error: "this daemon can't fire verbs (no call seam)" };
      const run = await runWorkflow({ ...wf, steps: [step] }, { call: (a, v, x) => ctx.call!(a, v, x) });
      ctx.state.runs = [record({ ...run, name: `${wf.name} · step ${i + 1}` }), ...ctx.state.runs].slice(0, RUNS_MAX);
      ctx.state.error = run.ok ? null : (run.error ?? null);
      ctx.emit();
      return {
        ok: run.ok,
        step: stepText(step),
        ...(run.error ? { error: run.error } : {}),
        result: compact(run.steps[0]?.result),
      };
    },

    /** Append (or insert) a step. No `step` opens the TUI's builder field. */
    addStep: (args, ctx) => doAddStep(ctx, args),

    /** Drop a step by position (0-based); defaults to the selected row. */
    removeStep(args, { state, emit }) {
      const wf = target(state, args);
      if (!wf) return { error: "no such workflow" };
      const i = typeof args.index === "number" ? args.index : state.open === wf.id ? state.cursor : -1;
      if (!wf.steps[i]) return { error: `no step ${i}` };
      const [gone] = wf.steps.splice(i, 1);
      wf.updatedAt = Date.now();
      state.cursor = Math.max(0, Math.min(state.cursor, wf.steps.length - 1));
      emit();
      return { removed: stepText(gone!), steps: wf.steps.length };
    },

    /**
     * Put a workflow on the daemon's clock (or take it off with `null`). The
     * expression is validated here, so a bad string never reaches the scheduler.
     */
    schedule: (args, ctx) => doSchedule(ctx, args),

    /** Pause or resume a schedule without losing the expression. */
    toggle(args, { state, emit }) {
      const wf = target(state, args);
      if (!wf) return { error: "no such workflow" };
      if (!wf.cron) return { error: `${wf.name} has no schedule to pause` };
      wf.enabled = typeof args.enabled === "boolean" ? args.enabled : !wf.enabled;
      wf.updatedAt = Date.now();
      emit();
      return { id: wf.id, enabled: wf.enabled, cron: wf.cron };
    },

    /** Delete a workflow. A bare keypress asks first; a named call just does it. */
    remove(args, ctx) {
      const named = typeof args.name === "string" || typeof args.id === "string" || typeof args.index === "number";
      const wf = target(ctx.state, args);
      if (!wf) return { error: "no such workflow" };
      if (!named && args.confirm !== true) {
        ctx.state.dialog = { kind: "remove", target: wf.id, value: "" };
        ctx.emit();
        return { dialog: "remove", workflow: wf.id };
      }
      return doRemove(ctx, wf);
    },

    /** Enter on the confirm dialog. */
    confirm(_args, ctx) {
      const d = ctx.state.dialog;
      if (!d || d.kind !== "remove") return { error: "nothing to confirm" };
      const wf = ctx.state.workflows.find((w) => w.id === d.target);
      if (!wf) {
        ctx.state.dialog = null;
        ctx.emit();
        return { error: "no such workflow" };
      }
      return doRemove(ctx, wf);
    },

    /** A keystroke in the open dialog's field: `{ id, value }`. */
    field(args, { state, emit }) {
      if (!state.dialog) return { error: "no dialog open" };
      state.dialog.value = typeof args.value === "string" ? args.value : "";
      emit();
      return { value: state.dialog.value };
    },

    /**
     * Enter in the dialog's field. It commits through the very verb an agent
     * calls — the form only decides WHICH question it was asking.
     */
    form(args, ctx) {
      const d = ctx.state.dialog;
      if (!d) return { error: "no dialog open" };
      const value = (typeof args.value === "string" ? args.value : d.value).trim();
      if (d.kind === "name") {
        if (!value) {
          ctx.state.dialog = null;
          ctx.emit();
          return { created: false };
        }
        return doDefine(ctx, { name: value });
      }
      const wf = ctx.state.workflows.find((w) => w.id === d.target);
      if (!wf) {
        ctx.state.dialog = null;
        ctx.emit();
        return { error: "no such workflow" };
      }
      if (d.kind === "step") {
        if (!value) {
          ctx.state.dialog = null;
          ctx.emit();
          return { added: false };
        }
        return doAddStep(ctx, { id: wf.id, step: value });
      }
      if (d.kind === "cron") return doSchedule(ctx, { id: wf.id, cron: value || null });
      return { error: "nothing to submit" };
    },

    /** Close the dialog without doing anything. */
    dismiss(_args, { state, emit }) {
      state.dialog = null;
      emit();
    },

    /** Render a workflow as a portable SKILL.md-shaped document. */
    export(args, { state }) {
      if (args.all === true) {
        return { workflows: state.workflows.map((w) => ({ id: w.id, name: w.name, markdown: toMarkdown(w) })) };
      }
      const wf = target(state, args);
      if (!wf) return { error: "no such workflow" };
      return { id: wf.id, name: wf.name, markdown: toMarkdown(wf) };
    },

    /** Define a workflow from that document — import from another machine. */
    import(args, ctx) {
      const { state, emit } = ctx;
      const md = args.markdown ?? args.text ?? args.doc ?? args.q;
      if (typeof md !== "string" || !md.trim()) return { error: "pass the document as `markdown`" };
      const doc = fromMarkdown(md);
      if ("error" in doc) return fail(ctx, doc.error);
      if (doc.cron) {
        const bad = validateCron(doc.cron);
        if (bad) return fail(ctx, `schedule: ${bad}`);
      }
      const now = Date.now();
      const existing = state.workflows.find((w) => w.name.toLowerCase() === doc.name.toLowerCase());
      const wf: Workflow = {
        id: existing?.id ?? freshId(state, doc.name),
        name: doc.name,
        steps: doc.steps,
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        cron: doc.cron ?? null,
        ...(doc.summary ? { summary: doc.summary } : {}),
        ...(doc.params ? { params: doc.params } : {}),
      };
      state.workflows = existing ? state.workflows.map((w) => (w.id === existing.id ? wf : w)) : [...state.workflows, wf];
      state.error = null;
      emit();
      return { id: wf.id, name: wf.name, steps: wf.steps.length, cron: wf.cron ?? null, replaced: !!existing };
    },

    /** Forget the run history; the workflows stay. */
    clear(_args, { state, emit }) {
      const n = state.runs.length;
      state.runs = [];
      state.error = null;
      emit();
      return { cleared: n };
    },

    // --- cursor / navigation -------------------------------------------------

    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      const wf = state.open ? state.workflows.find((w) => w.id === state.open) : null;
      const max = (wf ? wf.steps.length : state.workflows.length) - 1;
      state.cursor = Math.min(Math.max(0, max), state.cursor + 1);
      emit();
    },
    /**
     * Open the selected workflow (a click passes the row's `{index}`). Inside a
     * workflow there is nothing left to open, so it just moves the cursor to
     * the clicked step — `enter` there tests that step (see the keymap).
     */
    open(args, { state, emit }) {
      const inside = state.workflows.find((w) => w.id === state.open);
      if (inside) {
        if (typeof args.index === "number") state.cursor = Math.max(0, Math.min(inside.steps.length - 1, args.index));
        emit();
        return { step: state.cursor };
      }
      // `kona workflows morning` (and any agent) can name one; a keypress or a
      // click just means "this row".
      const named = typeof args.name === "string" || typeof args.id === "string" ? target(state, args) : undefined;
      if (named) state.cursor = state.workflows.indexOf(named);
      else if (typeof args.index === "number") {
        state.cursor = Math.max(0, Math.min(state.workflows.length - 1, args.index));
      }
      const wf = state.workflows[state.cursor];
      if (!wf) return { error: "nothing to open" };
      state.open = wf.id;
      state.cursor = 0;
      emit();
      return { open: wf.id, steps: wf.steps.map(stepText) };
    },
    /** Back to the list. */
    back(_args, { state, emit }) {
      const was = state.open;
      state.open = null;
      state.cursor = Math.max(0, state.workflows.findIndex((w) => w.id === was));
      emit();
    },
  },

  /**
   * A daemon that died mid-run left its guard set (state is persisted); clear
   * it on boot so a workflow isn't wedged as "already running" forever. Same
   * for a dialog nobody is looking at any more.
   */
  init({ state, emit }) {
    if (!state.running.length && !state.dialog) return;
    state.running = [];
    state.dialog = null;
    emit();
  },

  /**
   * What the daemon should fire on a calendar. It is read from LIVE state on
   * every scheduler pass, so `workflows.schedule` puts a job on the clock the
   * instant it returns — no restart, no registration step.
   */
  cron: (state) =>
    state.workflows
      .filter((w) => w.cron && w.enabled)
      .map((w) => ({ id: w.id, cron: w.cron!, verb: "run", args: { id: w.id, trigger: "cron" } })),

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "steps",
    back: "back",
    backLabel: "workflows",
    canBack: (s) => !!s.open,
  },

  keymap: {
    n: { verb: "define", label: "new" },
    a: { verb: "addStep", label: "add step" },
    c: { verb: "schedule", label: "schedule" },
    r: { verb: "run", label: "run" },
    p: { verb: "toggle", label: "pause/resume" },
    d: { verb: "remove", label: "delete" },
    x: { verb: "removeStep", label: "drop step", when: (s) => !!s.open },
    // In the detail view enter has no room left to open, so it tests the step
    // under the cursor — the builder's "does this line actually work?" button.
    return: { verb: "runStep", label: "test step", when: (s) => !!s.open },
  },

  crumb: (s) => s.workflows.find((w) => w.id === s.open)?.name ?? null,

  accent: (s) => (s.error ? theme().error : theme().alt),

  // The builder's one text field, floating over the list: a name, a step line,
  // or a cron expression. Same field, three questions — and each commits
  // through the verb an agent calls directly.
  overlay: (state) => {
    const d = state.dialog;
    if (!d) return null;
    const { ACCENT, ERR } = palette();
    if (d.kind === "remove") {
      const wf = state.workflows.find((w) => w.id === d.target);
      return {
        node: modal(
          "delete workflow?",
          [text(wf?.name ?? "", { color: ERR }), text("Its run history goes with it.", { dim: true })],
          { width: 40, color: ERR },
        ),
        scrim: true,
        confirm: "confirm",
        confirmLabel: "delete",
        dismiss: "dismiss",
      };
    }
    const spec = {
      name: {
        title: "new workflow",
        label: "name",
        placeholder: "morning",
        submit: "create",
        footer: "then press a to add steps",
      },
      step: {
        title: "add step",
        label: "step",
        placeholder: 'timer.start {"seconds":300}',
        submit: "add",
        footer: "any verb kona tools lists · {{steps.0.x}} reads a prior result",
      },
      cron: {
        title: "schedule",
        label: "cron",
        placeholder: "30 8 * * 1-5",
        submit: "save",
        footer: cronFooter(d.value),
      },
    }[d.kind];
    return {
      node: modal(
        spec.title,
        [
          labelled(
            spec.label,
            input(`workflows.${d.kind}`, d.value, {
              placeholder: spec.placeholder,
              width: 44,
              focus: true,
              submit: "form",
              submitLabel: spec.submit,
              cancel: "dismiss",
              cancelLabel: "cancel",
              change: "field",
              color: ACCENT,
            }),
            { labelWidth: 5 },
          ),
        ],
        { width: 62, color: ACCENT, footer: spec.footer },
      ),
      scrim: true,
      dismiss: "dismiss",
    };
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const { ACCENT, OK, WARN, ERR, FG, DIM, MUTED } = palette();
    const now = Date.now();
    const open = state.workflows.find((w) => w.id === state.open);
    const nodes: ViewNode[] = [];

    if (!open) {
      const scheduled = state.workflows.filter((w) => w.cron && w.enabled).length;
      nodes.push(
        text(`WORKFLOWS  ·  ${state.workflows.length} defined${scheduled ? `  ·  ${scheduled} scheduled` : ""}`, {
          color: ACCENT,
        }),
        divider(W - 1),
      );

      if (!state.workflows.length) {
        nodes.push(
          spacer(),
          text("no workflows yet", { dim: true }),
          text("press n to name one, then a to add steps", { color: DIM }),
          spacer(),
          text(`kona call workflows define '{"name":"focus","steps":["timer.start {\\"seconds\\":1500}"]}'`, {
            color: MUTED,
          }),
        );
        return [col(nodes)];
      }

      state.workflows.forEach((w, i) => {
        const last = lastRun(state, w.id);
        const when = w.cron ? (w.enabled ? describeCron(w.cron) : `paused · ${describeCron(w.cron)}`) : "manual";
        const status = state.running.includes(w.id)
          ? "running…"
          : last
            ? `${last.ok ? "✓" : "✗"} ${relative(last.at, now)}`
            : "never run";
        nodes.push(
          recordRow(
            [
              { text: w.name, grow: true },
              { text: `${w.steps.length} step${w.steps.length === 1 ? "" : "s"}`, width: 8, align: "right" },
              { text: when, width: Math.min(24, Math.floor(W * 0.3)) },
              { text: status, width: 12, align: "right" },
            ],
            { width: W, selected: i === state.cursor, accent: ACCENT, color: FG, index: i },
          ),
        );
      });

      if (state.error) nodes.push(spacer(), text(state.error, { color: ERR }));

      const upcoming = state.workflows
        .filter((w) => w.cron && w.enabled)
        .map((w) => ({ w, at: safeNext(w.cron!) }))
        .filter((x): x is { w: Workflow; at: number } => x.at !== null)
        .sort((a, b) => a.at - b.at)[0];
      if (upcoming) {
        nodes.push(
          spacer(),
          text(`next: ${upcoming.w.name} ${until(upcoming.at, now)}  (${clock(upcoming.at)})`, { color: DIM }),
        );
      }
      return [col(nodes)];
    }

    // --- one workflow: its steps, its schedule, its last runs
    const next = open.cron && open.enabled ? safeNext(open.cron) : null;
    nodes.push(
      text(open.name.toUpperCase(), { color: ACCENT }),
      ...(open.summary ? [text(open.summary, { dim: true })] : []),
      text(
        open.cron
          ? open.enabled
            ? `${describeCron(open.cron)}${next ? `  ·  next ${until(next, now)} (${clock(next)})` : ""}`
            : `paused  ·  ${describeCron(open.cron)}`
          : "manual — press r to run",
        { color: open.cron && open.enabled ? OK : DIM },
      ),
      divider(W - 1),
      heading("STEPS", DIM),
    );

    if (!open.steps.length) {
      nodes.push(text("no steps yet — press a", { dim: true }));
    } else {
      open.steps.forEach((s, i) => {
        nodes.push(
          recordRow(
            [
              { text: `${String(i + 1).padStart(2)}  ${stepText(s)}`, grow: true },
              {
                text: s.when ? `when ${s.when}` : s.as ? `as ${s.as}` : "",
                width: Math.min(24, Math.floor(W * 0.25)),
                align: "right",
              },
            ],
            { width: W, selected: i === state.cursor, accent: ACCENT, color: FG, index: i },
          ),
        );
      });
    }

    if (state.running.includes(open.id)) nodes.push(spacer(), text("running…", { color: WARN }));
    if (state.error) nodes.push(spacer(), text(state.error, { color: ERR }));

    const runs = state.runs.filter((r) => r.workflow === open.id).slice(0, 5);
    if (runs.length) {
      nodes.push(spacer(), heading("RUNS", DIM));
      for (const r of runs) {
        const marks = r.steps.map((s) => (s.skipped ? "·" : s.ok ? "✓" : "✗")).join("");
        nodes.push(
          text(`${r.ok ? "✓" : "✗"} ${clock(r.at)}  ${marks}  ${r.ms}ms  ${r.trigger}${r.error ? `  ${r.error}` : ""}`, {
            color: r.ok ? OK : ERR,
          }),
        );
      }
    }

    return [col(nodes)];
  },
});

/** The cron dialog's live footer: what the typed expression actually means. */
function cronFooter(expr: string): string {
  const value = expr.trim();
  if (!value) return "5 fields (m h dom mon dow), @daily, or @every 10m";
  const bad = validateCron(value);
  if (bad) return bad;
  const at = safeNext(value);
  return `${describeCron(value)}${at ? ` · next ${until(at)}` : ""}`;
}
