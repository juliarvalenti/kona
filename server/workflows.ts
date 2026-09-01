/**
 * The workflow engine — kona's answer to Shortcuts, with applet verbs as the
 * steps.
 *
 * A workflow is a named, ordered list of verb calls. Nothing here knows about
 * HTTP, the daemon, or the TUI: `runWorkflow` takes a `call` function and does
 * the sequencing, the templating and the conditionals. That keeps the engine
 * testable on its own AND keeps the bimodal seam honest — the daemon hands it
 * the same `invoke` an agent's POST lands on, so a scheduled step and a typed
 * `kona call` are literally the same code path.
 *
 * Steps can talk to each other: any string in `args` may reference the run's
 * scope with `{{...}}` — `{{params.room}}`, `{{steps.0.id}}`, `{{last.id}}`.
 * A step may also carry `when`, a small truthiness/comparison test over the
 * same scope, which is enough for "only if something came back".
 *
 * Workflows import/export as a SKILL.md-shaped document (YAML frontmatter +
 * markdown, steps as literal `kona call` lines) so they are shareable text, not
 * a walled garden — see `toMarkdown`/`fromMarkdown`.
 */

/** One verb call in a workflow. */
export interface WorkflowStep {
  applet: string;
  verb: string;
  args?: Record<string, unknown>;
  /** Run the step only if this resolves truthy (see `evalWhen`). */
  when?: string;
  /** Name this step's result, so later steps can say `{{steps.<as>.…}}`. */
  as?: string;
}

/** A named sequence, optionally on a schedule. */
export interface Workflow {
  id: string;
  name: string;
  summary?: string;
  steps: WorkflowStep[];
  /** Cron expression (or `@every 10m`); null/undefined = manual only. */
  cron?: string | null;
  /** A scheduled workflow can be parked without losing its expression. */
  enabled: boolean;
  /** Default params, overridable per run. */
  params?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** What one step did. */
export interface StepRun {
  applet: string;
  verb: string;
  args: Record<string, unknown>;
  ok: boolean;
  skipped?: boolean;
  result?: unknown;
  error?: string;
  ms: number;
}

/** What one run of a workflow did. */
export interface Run {
  id: string;
  workflow: string; // workflow id
  name: string;
  at: number;
  ms: number;
  ok: boolean;
  trigger: RunTrigger;
  steps: StepRun[];
  error?: string;
}

export type RunTrigger = "manual" | "cron" | "agent";

/** Fire a verb — the daemon's `invoke`, or a fake in tests. */
export type CallVerb = (applet: string, verb: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

/** Everything a `{{…}}` reference can see. */
export interface Scope {
  params: Record<string, unknown>;
  /** By position (`steps.0`) and by `as` name (`steps.inbox`). */
  steps: Record<string, unknown>;
  /** The previous step's result. */
  last: unknown;
  /** ISO timestamp of the run, for stamping notes and messages. */
  now: string;
}

const REF = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE_REF = /^\{\{\s*([^}]+?)\s*\}\}$/;

/** Walk a dotted path (`steps.0.result.id`) through the scope. */
export function lookup(path: string, scope: Scope): unknown {
  let cur: unknown = scope;
  for (const key of path.split(".")) {
    const k = key.trim();
    if (!k) return undefined;
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(k);
      cur = Number.isInteger(i) ? cur[i < 0 ? cur.length + i : i] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** How a referenced value reads when spliced into a longer string. */
function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Substitute `{{…}}` references through any value. A string that is EXACTLY one
 * reference keeps the referenced value's type (so `{{steps.0.seconds}}` stays a
 * number); one embedded in prose is interpolated as text.
 */
export function resolve<T>(value: T, scope: Scope): T {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_REF);
    if (whole) return lookup(whole[1]!, scope) as T;
    return value.replace(REF, (_m, path: string) => stringify(lookup(path, scope))) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolve(v, scope);
    return out as T;
  }
  return value;
}

/** kona's truthiness: empty string, empty array, 0, null and "false" are false. */
export function truthy(v: unknown): boolean {
  if (v == null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "false" && v !== "0";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** A bare literal on the right of a comparison: `"5"` -> 5, `"true"` -> true. */
function literal(raw: string): unknown {
  const s = raw.trim();
  if (/^["'].*["']$/.test(s)) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

/**
 * A step's `when`: a reference on its own (truthy), negated with `!`, or
 * compared against a literal — `{{steps.0.count}} > 0`, `{{last.status}} ==
 * "done"`. Deliberately not an expression language; anything richer belongs in
 * a verb, where it can be tested.
 */
export function evalWhen(when: string, scope: Scope): boolean {
  const s = when.trim();
  if (!s) return true;
  // Braces are optional in a `when`: `steps.0.count > 0` reads better than the
  // same thing wrapped, and there is nothing else a bare path could mean here.
  const side = (raw: string): unknown =>
    raw.includes("{{") ? resolve(raw, scope) : /^[\w$][\w.$-]*$/.test(raw) ? lookup(raw, scope) : literal(raw);

  const cmp = s.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmp) {
    const [, lhs, op, rhs] = cmp as unknown as [string, string, string, string];
    const a = side(lhs.trim());
    const b = WHOLE_REF.test(rhs.trim()) ? (resolve(rhs.trim(), scope) as unknown) : literal(rhs);
    switch (op) {
      case "==":
        return a === b || String(a) === String(b);
      case "!=":
        return !(a === b || String(a) === String(b));
      case ">":
        return Number(a) > Number(b);
      case "<":
        return Number(a) < Number(b);
      case ">=":
        return Number(a) >= Number(b);
      case "<=":
        return Number(a) <= Number(b);
    }
  }
  const negated = s.startsWith("!");
  return truthy(side(negated ? s.slice(1).trim() : s)) !== negated;
}

export interface RunOpts {
  call: CallVerb;
  params?: Record<string, unknown>;
  trigger?: RunTrigger;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Refuse to run more than this many steps (a runaway guard). */
  maxSteps?: number;
}

export const MAX_STEPS = 32;

/**
 * Run a workflow start to finish. Steps run in order and the run STOPS at the
 * first failure: a workflow is a script, and a script that keeps going after a
 * step blew up leaves state nobody can reason about. A skipped step (`when`
 * false) is not a failure — it is recorded and the run continues.
 */
export async function runWorkflow(wf: Workflow, opts: RunOpts): Promise<Run> {
  const clock = opts.now ?? Date.now;
  const started = clock();
  const scope: Scope = {
    params: { ...(wf.params ?? {}), ...(opts.params ?? {}) },
    steps: {},
    last: undefined,
    now: new Date(started).toISOString(),
  };
  const run: Run = {
    id: crypto.randomUUID().slice(0, 8),
    workflow: wf.id,
    name: wf.name,
    at: started,
    ms: 0,
    ok: true,
    trigger: opts.trigger ?? "manual",
    steps: [],
  };

  const steps = wf.steps.slice(0, opts.maxSteps ?? MAX_STEPS);
  if (wf.steps.length > steps.length) {
    run.ok = false;
    run.error = `workflow has ${wf.steps.length} steps; the limit is ${opts.maxSteps ?? MAX_STEPS}`;
    run.ms = clock() - started;
    return run;
  }

  for (const [i, step] of steps.entries()) {
    const at = clock();
    const record = (extra: Partial<StepRun>, args: Record<string, unknown> = {}): StepRun => ({
      applet: step.applet,
      verb: step.verb,
      args,
      ok: true,
      ms: clock() - at,
      ...extra,
    });

    if (step.when && !evalWhen(step.when, scope)) {
      run.steps.push(record({ skipped: true }));
      continue;
    }

    let args: Record<string, unknown> = {};
    try {
      args = resolve(step.args ?? {}, scope);
      const result = await opts.call(step.applet, step.verb, args);
      run.steps.push(record({ result }, args));
      scope.steps[String(i)] = result;
      if (step.as) scope.steps[step.as] = result;
      scope.last = result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      run.steps.push(record({ ok: false, error }, args));
      run.ok = false;
      run.error = `step ${i + 1} (${step.applet}.${step.verb}): ${error}`;
      break;
    }
  }

  run.ms = clock() - started;
  return run;
}

// --- steps as text ---------------------------------------------------------

/**
 * A step written the way an agent would type it: `timer.start {"seconds":300}`
 * or the full `kona call timer start '{"seconds":300}'`. This is what the TUI
 * builder's one text field accepts, and what an import parses — a workflow you
 * can read out loud is a workflow you can share.
 *
 * Trailing `# as=<name> when=<test>` carries the two optional fields.
 */
export function parseStep(line: string): WorkflowStep | { error: string } {
  const raw = line.trim().replace(/^kona\s+call\s+/, "");
  if (!raw) return { error: "empty step" };

  // Split off a trailing `# …` comment that is not inside the JSON blob.
  let body = raw;
  let meta = "";
  const hash = outsideQuotes(raw, "#");
  if (hash >= 0) {
    body = raw.slice(0, hash).trim();
    meta = raw.slice(hash + 1).trim();
  }

  // The applet id has no dot; a VERB may (timer's `pomodoro.start`), so the
  // first dot or space splits and everything up to the args is the verb.
  const head = body.match(/^([A-Za-z_][\w-]*)[.\s]+([A-Za-z_][\w.-]*)\s*([\s\S]*)$/);
  if (!head) return { error: `expected "<applet>.<verb> {args}", got "${line.trim()}"` };
  const [, applet, verb, argsRaw] = head as unknown as [string, string, string, string];

  const step: WorkflowStep = { applet, verb };
  const json = argsRaw.trim().replace(/^'([\s\S]*)'$/, "$1");
  if (json && !json.startsWith("{")) {
    return { error: `expected "<applet>.<verb> {args}", got "${line.trim()}"` };
  }
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "step args must be a JSON object" };
      }
      step.args = parsed as Record<string, unknown>;
    } catch {
      return { error: `bad JSON args: ${json}` };
    }
  }
  const as = meta.match(/\bas=(\S+)/);
  if (as) step.as = as[1]!;
  const when = meta.match(/\bwhen=(.+)$/);
  if (when) step.when = when[1]!.trim();
  return step;
}

/** The first occurrence of `ch` outside single/double quotes, or -1. */
function outsideQuotes(s: string, ch: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ch) {
      return i;
    }
  }
  return -1;
}

/** A step as the pasteable CLI line it is — the inverse of `parseStep`. */
export function stepLine(step: WorkflowStep): string {
  const args = step.args && Object.keys(step.args).length ? ` '${JSON.stringify(step.args)}'` : "";
  const meta = [step.as ? `as=${step.as}` : "", step.when ? `when=${step.when}` : ""].filter(Boolean).join(" ");
  return `kona call ${step.applet} ${step.verb}${args}${meta ? `  # ${meta}` : ""}`;
}

/** A step in the compact form the TUI shows and the builder accepts. */
export function stepText(step: WorkflowStep): string {
  const args = step.args && Object.keys(step.args).length ? ` ${JSON.stringify(step.args)}` : "";
  return `${step.applet}.${step.verb}${args}`;
}

// --- SKILL.md import/export ------------------------------------------------

/**
 * A workflow as a portable document: YAML-ish frontmatter + a markdown body
 * whose steps are literal `kona call` lines. The shape is deliberately the one
 * agent skills already use (`SKILL.md`: frontmatter + prose + commands), so a
 * workflow drops into a skills directory as-is and a skill written by hand
 * imports back with `workflows.import`.
 */
export function toMarkdown(wf: Workflow): string {
  const front = [
    "---",
    `name: ${wf.name}`,
    `description: ${wf.summary ?? `Run ${wf.steps.length} kona verbs in order.`}`,
    ...(wf.cron ? [`schedule: ${wf.cron}`] : []),
    ...(wf.params && Object.keys(wf.params).length ? [`params: ${JSON.stringify(wf.params)}`] : []),
    "---",
  ];
  return [
    ...front,
    "",
    `# ${wf.name}`,
    "",
    wf.summary ?? `A kona workflow: ${wf.steps.length} verb${wf.steps.length === 1 ? "" : "s"}, in order.`,
    "",
    ...(wf.cron ? [`Runs on \`${wf.cron}\`${wf.enabled ? "" : " (paused)"}.`, ""] : []),
    "## Steps",
    "",
    "```sh",
    ...wf.steps.map(stepLine),
    "```",
    "",
  ].join("\n");
}

export interface ParsedDoc {
  name: string;
  summary?: string;
  cron?: string;
  params?: Record<string, unknown>;
  steps: WorkflowStep[];
}

/**
 * Read a workflow back out of that document. Tolerant on purpose: the
 * frontmatter is optional (a `# Title` will do), and any `kona call` line in
 * the body counts as a step, so a skill someone wrote by hand imports too.
 */
export function fromMarkdown(md: string): ParsedDoc | { error: string } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const front: Record<string, string> = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    for (; i < lines.length && lines[i]?.trim() !== "---"; i++) {
      const m = lines[i]!.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (m) front[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^["'](.*)["']$/, "$1");
    }
    i++; // past the closing fence
  }

  const body = lines.slice(i);
  const heading = body.find((l) => /^#\s+\S/.test(l.trim()));
  const name = front.name ?? heading?.replace(/^#\s+/, "").trim() ?? "";
  if (!name) return { error: "no name: add frontmatter `name:` or a `# Title`" };

  const steps: WorkflowStep[] = [];
  for (const line of body) {
    const t = line.trim();
    if (!/^(kona\s+call|\$\s*kona\s+call)/.test(t)) continue;
    const step = parseStep(t.replace(/^\$\s*/, ""));
    if ("error" in step) return { error: `${step.error}` };
    steps.push(step);
  }
  if (!steps.length) return { error: "no steps: the body needs `kona call <applet> <verb>` lines" };

  const doc: ParsedDoc = { name, steps };
  const summary = front.description ?? front.summary;
  if (summary) doc.summary = summary;
  const cron = front.schedule ?? front.cron;
  if (cron) doc.cron = cron;
  if (front.params) {
    try {
      const parsed = JSON.parse(front.params) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc.params = parsed as Record<string, unknown>;
      }
    } catch {
      /* params are a convenience; a malformed line shouldn't sink the import */
    }
  }
  return doc;
}
