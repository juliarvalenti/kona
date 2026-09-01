import { test, expect } from "bun:test";
import type { AppletCtx } from "../sdk/index.ts";
import workflows from "../applets/workflows/index.ts";
import {
  evalWhen,
  fromMarkdown,
  parseStep,
  resolve,
  runWorkflow,
  stepLine,
  toMarkdown,
  type Scope,
  type Workflow,
} from "../server/workflows.ts";

/**
 * Two levels, tested apart:
 *   - the engine (server/workflows.ts): sequencing, templating, conditionals,
 *     and the portable document — all against a fake `call`, no daemon needed.
 *   - the applet: the verbs an agent fires and the TUI form fills in, which are
 *     the same verbs, plus the cron jobs it hands the daemon.
 */

type WorkflowsState = typeof workflows.initialState;

/** A daemon stand-in: records every verb call and answers from a script. */
function harness(replies: Record<string, unknown> = {}) {
  const state: WorkflowsState = structuredClone(workflows.initialState);
  const calls: Array<{ applet: string; verb: string; args: Record<string, unknown> }> = [];
  let emits = 0;
  const ctx: AppletCtx<WorkflowsState> = {
    state,
    emit: () => void emits++,
    call: async (applet, verb, args = {}) => {
      calls.push({ applet, verb, args });
      const key = `${applet}.${verb}`;
      if (replies[key] instanceof Error) throw replies[key];
      return replies[key];
    },
  };
  return {
    state,
    calls,
    emits: () => emits,
    ctx,
    call: (verb: string, args: Record<string, unknown> = {}) => workflows.verbs[verb]!(args, ctx),
  };
}

const scope = (over: Partial<Scope> = {}): Scope => ({
  params: {},
  steps: {},
  last: undefined,
  now: "2026-09-01T08:30:00.000Z",
  ...over,
});

// --- the engine ------------------------------------------------------------

test("a reference on its own keeps its type; one in prose is interpolated", () => {
  const s = scope({ params: { room: "ship-kona" }, steps: { "0": { unread: 3 } } });
  expect(resolve("{{steps.0.unread}}", s)).toBe(3);
  expect(resolve("inbox: {{steps.0.unread}} unread in {{params.room}}", s)).toBe("inbox: 3 unread in ship-kona");
  expect(resolve({ text: "at {{now}}", n: "{{steps.0.unread}}" }, s)).toEqual({
    text: "at 2026-09-01T08:30:00.000Z",
    n: 3,
  });
  expect(resolve("{{steps.9.nope}}", s)).toBeUndefined();
});

test("`when` reads truthiness, negation and comparisons over the same scope", () => {
  const s = scope({ steps: { "0": { count: 0, status: "done", items: ["a"] } }, last: { ok: true } });
  expect(evalWhen("{{last.ok}}", s)).toBe(true);
  expect(evalWhen("!{{steps.0.count}}", s)).toBe(true); // 0 is falsy
  expect(evalWhen("steps.0.items", s)).toBe(true); // braces optional in a when
  expect(evalWhen('steps.0.status == "done"', s)).toBe(true);
  expect(evalWhen("steps.0.count > 0", s)).toBe(false);
  expect(evalWhen("steps.0.count >= 0", s)).toBe(true);
});

const wf = (steps: Workflow["steps"], over: Partial<Workflow> = {}): Workflow => ({
  id: "w",
  name: "w",
  steps,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

test("steps run in order and each one's result feeds the next", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const run = await runWorkflow(
    wf([
      { applet: "email", verb: "refresh", as: "inbox" },
      { applet: "notes", verb: "add", args: { text: "{{steps.inbox.unread}} unread for {{params.who}}" } },
      { applet: "timer", verb: "start", args: { seconds: "{{last.id}}" } },
    ]),
    {
      params: { who: "ada" },
      call: async (applet, verb, args) => {
        seen.push({ applet, verb, ...args });
        if (verb === "refresh") return { unread: 4 };
        if (verb === "add") return { id: 300 };
        return { started: true };
      },
    },
  );

  expect(run.ok).toBe(true);
  expect(run.steps.map((s) => `${s.applet}.${s.verb}`)).toEqual(["email.refresh", "notes.add", "timer.start"]);
  expect(seen[1]).toMatchObject({ text: "4 unread for ada" });
  expect(seen[2]).toMatchObject({ seconds: 300 }); // a whole reference keeps its type
});

test("a false `when` skips the step without failing the run", async () => {
  const run = await runWorkflow(
    wf([
      { applet: "email", verb: "refresh" },
      { applet: "notes", verb: "add", args: { text: "you have mail" }, when: "{{steps.0.unread}}" },
    ]),
    { call: async () => ({ unread: 0 }) },
  );
  expect(run.ok).toBe(true);
  expect(run.steps[1]).toMatchObject({ skipped: true, applet: "notes" });
});

test("a failing step stops the run and says which one blew up", async () => {
  const fired: string[] = [];
  const run = await runWorkflow(
    wf([
      { applet: "timer", verb: "start" },
      { applet: "nope", verb: "boom" },
      { applet: "notes", verb: "add" },
    ]),
    {
      call: async (applet, verb) => {
        fired.push(`${applet}.${verb}`);
        if (applet === "nope") throw new Error("no such applet");
        return {};
      },
    },
  );
  expect(run.ok).toBe(false);
  expect(run.error).toContain("step 2 (nope.boom)");
  expect(run.error).toContain("no such applet");
  expect(fired).toEqual(["timer.start", "nope.boom"]); // the third never ran
});

test("a runaway workflow is refused rather than run half-way", async () => {
  const many = Array.from({ length: 5 }, () => ({ applet: "notes", verb: "add" }));
  const run = await runWorkflow(wf(many), { call: async () => ({}), maxSteps: 3 });
  expect(run.ok).toBe(false);
  expect(run.error).toContain("limit is 3");
  expect(run.steps).toHaveLength(0);
});

test("a step is written the way an agent types it, and reads back the same", () => {
  expect(parseStep('timer.start {"seconds":300}')).toEqual({ applet: "timer", verb: "start", args: { seconds: 300 } });
  expect(parseStep(`kona call timer start '{"seconds":300}'`)).toEqual({
    applet: "timer",
    verb: "start",
    args: { seconds: 300 },
  });
  expect(parseStep("email.refresh  # as=inbox when={{params.mail}}")).toEqual({
    applet: "email",
    verb: "refresh",
    as: "inbox",
    when: "{{params.mail}}",
  });
  // A verb may carry a dot of its own (timer's `pomodoro.start`); an applet id may not.
  expect(parseStep("timer.pomodoro.start")).toEqual({ applet: "timer", verb: "pomodoro.start" });
  expect(parseStep("nonsense")).toMatchObject({ error: expect.stringContaining("<applet>.<verb>") });
  expect(parseStep("timer.start {oops}")).toMatchObject({ error: expect.stringContaining("bad JSON") });

  const step = { applet: "notes", verb: "add", args: { text: "hi # not a comment" }, as: "note" };
  expect(parseStep(stepLine(step))).toEqual(step); // the CLI line is the wire format
});

test("a workflow exports as a SKILL.md-shaped document and imports back", () => {
  const source = wf(
    [
      { applet: "email", verb: "refresh", as: "inbox" },
      { applet: "notes", verb: "add", args: { text: "{{steps.inbox.unread}} unread" }, when: "{{steps.inbox.unread}}" },
    ],
    { id: "morning", name: "morning", summary: "Start the day", cron: "30 8 * * 1-5", params: { who: "ada" } },
  );
  const md = toMarkdown(source);
  expect(md.startsWith("---\nname: morning\n")).toBe(true);
  expect(md).toContain("schedule: 30 8 * * 1-5");
  expect(md).toContain("kona call email refresh  # as=inbox");

  const back = fromMarkdown(md);
  if ("error" in back) throw new Error(back.error);
  expect(back.name).toBe("morning");
  expect(back.cron).toBe("30 8 * * 1-5");
  expect(back.params).toEqual({ who: "ada" });
  expect(back.steps).toEqual(source.steps);
});

test("a hand-written skill imports too — frontmatter optional, `kona call` lines are the steps", () => {
  const doc = fromMarkdown(
    ["# Focus block", "", "Whatever prose the author wanted.", "", "```sh", `kona call timer start '{"seconds":1500}'`, "```"].join("\n"),
  );
  if ("error" in doc) throw new Error(doc.error);
  expect(doc.name).toBe("Focus block");
  expect(doc.steps).toEqual([{ applet: "timer", verb: "start", args: { seconds: 1500 } }]);
  expect(fromMarkdown("# Empty\n\nnothing here")).toMatchObject({ error: expect.stringContaining("no steps") });
});

// --- the applet ------------------------------------------------------------

test("define takes step lines or step objects, and replaces by name", () => {
  const h = harness();
  const made = h.call("define", {
    name: "Morning",
    summary: "Start the day",
    steps: ['timer.start {"seconds":1500}', { applet: "notes", verb: "add", args: { text: "focus" } }],
  }) as { id: string; steps: number };
  expect(made).toMatchObject({ id: "morning", steps: 2, replaced: false });
  expect(h.state.workflows[0]!.steps[0]).toEqual({ applet: "timer", verb: "start", args: { seconds: 1500 } });

  const again = h.call("define", { name: "morning", steps: ["notes.add"] }) as { replaced: boolean };
  expect(again.replaced).toBe(true);
  expect(h.state.workflows).toHaveLength(1);
  expect(h.state.workflows[0]!.summary).toBe("Start the day"); // kept
});

test("a bad step line is refused with a reason, and nothing is defined", () => {
  const h = harness();
  const res = h.call("define", { name: "broken", steps: ["not a verb call at all !!"] }) as { error: string };
  expect(res.error).toContain("<applet>.<verb>");
  expect(h.state.workflows).toHaveLength(0);
  expect(h.state.error).toBe(res.error);
});

test("run fires every step through ctx.call and files a run", async () => {
  const h = harness({ "timer.start": { id: "t1" }, "notes.add": { added: true } });
  h.call("define", { name: "focus", steps: ['timer.start {"seconds":1500}', 'notes.add {"text":"started {{steps.0.id}}"}'] });

  const res = (await h.call("run", { name: "focus" })) as { ok: boolean; steps: unknown[] };
  expect(res.ok).toBe(true);
  expect(h.calls.map((c) => `${c.applet}.${c.verb}`)).toEqual(["timer.start", "notes.add"]);
  expect(h.calls[1]!.args).toEqual({ text: "started t1" });

  expect(h.state.runs).toHaveLength(1);
  expect(h.state.runs[0]).toMatchObject({ ok: true, trigger: "manual", name: "focus" });
  expect(h.state.running).toEqual([]); // the guard is released
});

test("a failed run is remembered, with the error on the applet", async () => {
  const h = harness({ "timer.start": new Error("no such verb") });
  h.call("define", { name: "focus", steps: ["timer.start"] });
  const res = (await h.call("run", { name: "focus" })) as { ok: boolean; error: string };
  expect(res.ok).toBe(false);
  expect(h.state.runs[0]!.ok).toBe(false);
  expect(h.state.error).toContain("no such verb");
});

test("run refuses a name that doesn't exist rather than running the selected one", async () => {
  const h = harness();
  h.call("define", { name: "focus", steps: ["notes.add"] });
  expect(await h.call("run", { name: "nope" })).toEqual({ error: "no such workflow" });
  expect(h.calls).toHaveLength(0);
});

test("schedule validates the expression and hands the daemon a cron job", () => {
  const h = harness();
  h.call("define", { name: "focus", steps: ["notes.add"] });

  expect(h.call("schedule", { name: "focus", cron: "not a cron" })).toMatchObject({ error: expect.any(String) });
  expect(workflows.cron!(h.state)).toEqual([]);

  const set = h.call("schedule", { name: "focus", cron: "30 8 * * 1-5" }) as { cron: string; next: number };
  expect(set.cron).toBe("30 8 * * 1-5");
  expect(set.next).toBeGreaterThan(Date.now());
  expect(workflows.cron!(h.state)).toEqual([
    { id: "focus", cron: "30 8 * * 1-5", verb: "run", args: { id: "focus", trigger: "cron" } },
  ]);

  // Paused: the expression stays, the job leaves the daemon's clock.
  h.call("toggle", { name: "focus", enabled: false });
  expect(h.state.workflows[0]!.cron).toBe("30 8 * * 1-5");
  expect(workflows.cron!(h.state)).toEqual([]);

  // Cleared entirely.
  h.call("toggle", { name: "focus", enabled: true });
  h.call("schedule", { name: "focus", cron: null });
  expect(h.state.workflows[0]!.cron).toBeNull();
  expect(workflows.cron!(h.state)).toEqual([]);
});

test("steps can be appended, inserted and dropped", () => {
  const h = harness();
  h.call("define", { name: "focus", steps: ["timer.start"] });
  h.call("addStep", { name: "focus", step: 'notes.add {"text":"go"}' });
  h.call("addStep", { name: "focus", step: "email.refresh", index: 0 });
  expect(h.state.workflows[0]!.steps.map((s) => `${s.applet}.${s.verb}`)).toEqual([
    "email.refresh",
    "timer.start",
    "notes.add",
  ]);
  h.call("removeStep", { name: "focus", index: 1 });
  expect(h.state.workflows[0]!.steps.map((s) => s.applet)).toEqual(["email", "notes"]);
});

test("the TUI form fills in the same verbs an agent calls", () => {
  const h = harness();
  // n -> the name dialog; typing and enter commit through `define`.
  expect(h.call("define")).toEqual({ dialog: "name" });
  expect(h.state.dialog).toMatchObject({ kind: "name", value: "" });
  h.call("field", { id: "workflows.name", value: "Morning" });
  h.call("form", { id: "workflows.name", value: "Morning" });
  expect(h.state.dialog).toBeNull();
  expect(h.state.workflows[0]).toMatchObject({ id: "morning", name: "Morning" });

  // a -> the step dialog, on the selected workflow.
  expect(h.call("addStep")).toEqual({ dialog: "step" });
  h.call("form", { id: "workflows.step", value: 'timer.start {"seconds":300}' });
  expect(h.state.workflows[0]!.steps).toEqual([{ applet: "timer", verb: "start", args: { seconds: 300 } }]);

  // c -> the cron dialog, pre-filled with whatever is set.
  expect(h.call("schedule")).toEqual({ dialog: "cron" });
  h.call("form", { id: "workflows.cron", value: "@every 10m" });
  expect(h.state.workflows[0]!.cron).toBe("@every 10m");
  expect(h.state.dialog).toBeNull();
});

test("a keypress delete asks first; a named delete just does it", () => {
  const h = harness();
  h.call("define", { name: "focus", steps: ["notes.add"] });
  expect(h.call("remove")).toMatchObject({ dialog: "remove", workflow: "focus" });
  expect(h.state.workflows).toHaveLength(1);
  h.call("dismiss");
  expect(h.state.dialog).toBeNull();
  expect(h.state.workflows).toHaveLength(1);

  expect(h.call("remove")).toMatchObject({ dialog: "remove" });
  h.call("confirm");
  expect(h.state.workflows).toHaveLength(0);

  h.call("define", { name: "again", steps: ["notes.add"] });
  expect(h.call("remove", { name: "again" })).toMatchObject({ removed: "again" });
  expect(h.state.workflows).toHaveLength(0);
});

test("export and import move a workflow between machines", () => {
  const h = harness();
  h.call("define", { name: "focus", cron: "@every 30m", steps: ['timer.start {"seconds":1500}'] });
  const doc = h.call("export", { name: "focus" }) as { markdown: string };
  expect(doc.markdown).toContain("schedule: @every 30m");

  const other = harness();
  const landed = other.call("import", { markdown: doc.markdown }) as { id: string; steps: number; cron: string };
  expect(landed).toMatchObject({ id: "focus", steps: 1, cron: "@every 30m" });
  expect(other.state.workflows[0]!.steps).toEqual([{ applet: "timer", verb: "start", args: { seconds: 1500 } }]);
  expect(other.call("import", { markdown: "not a workflow" })).toMatchObject({ error: expect.any(String) });
});

test("run history is bounded and its results stay small", async () => {
  const big = { blob: "x".repeat(5_000) };
  const h = harness({ "notes.add": big });
  h.call("define", { name: "loop", steps: ["notes.add"] });
  for (let i = 0; i < 25; i++) await h.call("run", { name: "loop" });
  expect(h.state.runs).toHaveLength(20);
  expect(JSON.stringify(h.state.runs[0]!.steps[0]!.result)).toContain("elided");
});

test("a daemon that died mid-run doesn't wedge a workflow as running", () => {
  const h = harness();
  h.state.running = ["focus"];
  h.state.dialog = { kind: "name", target: null, value: "half typed" };
  workflows.init!(h.ctx);
  expect(h.state.running).toEqual([]);
  expect(h.state.dialog).toBeNull();
});

test("a workflow can't re-enter itself while it is running", async () => {
  const h = harness();
  h.call("define", { name: "focus", steps: ["notes.add"] });
  h.state.running = ["focus"];
  expect(await h.call("run", { name: "focus" })).toMatchObject({ error: expect.stringContaining("already running") });
  expect(h.calls).toHaveLength(0);
});
