import { test, expect, beforeEach } from "bun:test";
import def from "./index.ts";
import { approvals } from "../../server/approvals.ts";
import type { AppletCtx, DashCard } from "../../sdk/index.ts";

/**
 * The tray, driven the way both callers drive it: something parks an action,
 * and a verb decides it. The registry is the shared object the daemon parks
 * into, so a test can park directly and still be testing the real seam.
 */

type State = typeof def.initialState;

function ctxOf(state: State = structuredClone(def.initialState)): AppletCtx<State> & { emits: number } {
  let emits = 0;
  const ctx = {
    state,
    emit: () => {
      emits++;
    },
    get emits() {
      return emits;
    },
  } as AppletCtx<State> & { emits: number };
  return ctx;
}

const fire = (verb: string, args: Record<string, unknown>, ctx: AppletCtx<State>) =>
  def.verbs[verb]!(args, ctx);

/** Park one, the way the daemon does: the call, and what approving would run. */
function park(
  applet: string,
  verb: string,
  args: Record<string, unknown> = {},
  run: () => Promise<unknown> = async () => "done",
) {
  return approvals.park(
    { applet, verb, args, priority: "high", requestedBy: "claude", reason: "high-priority verbs need a human", expiresMs: 60_000 },
    run,
  );
}

beforeEach(() => approvals.reset());

test("a parked action is visible, with the args it would run with", async () => {
  park("email", "send", { to: "ada@example.com", body: "hi" });
  const ctx = ctxOf();
  await fire("refresh", {}, ctx);

  expect(ctx.state.pending).toHaveLength(1);
  expect(ctx.state.pending[0]).toMatchObject({
    applet: "email",
    verb: "send",
    // The exact args, not a summary: this is what the human is consenting to.
    args: { to: "ada@example.com", body: "hi" },
    requestedBy: "claude",
  });
});

test("approving runs the held verb and hands its result back to the waiting caller", async () => {
  let ran = 0;
  const { action, settled } = park("email", "send", { to: "ada" }, async () => {
    ran++;
    return { sent: true };
  });
  expect(ran).toBe(0); // parked, not run — the whole point

  const ctx = ctxOf();
  await fire("refresh", {}, ctx);
  const out = (await fire("approve", { id: action.id }, ctx)) as { outcome: string };

  expect(ran).toBe(1);
  expect(out.outcome).toBe("ran");
  // The agent (or the workflow step) that was waiting gets the real result.
  await expect(settled).resolves.toEqual({ sent: true });
  expect(ctx.state.pending).toHaveLength(0);
  expect(ctx.state.log[0]).toMatchObject({ applet: "email", verb: "send", outcome: "ran" });
});

test("denying drops it and rejects the caller — the verb never runs", async () => {
  let ran = 0;
  const { action, settled } = park("email", "trash", { id: "m9" }, async () => {
    ran++;
    return null;
  });

  const ctx = ctxOf();
  await fire("refresh", {}, ctx);
  await fire("deny", { id: action.id }, ctx);

  expect(ran).toBe(0);
  await expect(settled).rejects.toThrow(/denied/);
  expect(ctx.state.pending).toHaveLength(0);
  expect(ctx.state.log[0]).toMatchObject({ outcome: "denied" });
});

test("an unanswered action expires instead of waiting forever", async () => {
  const { settled } = approvals.park(
    { applet: "email", verb: "send", args: {}, priority: "high", requestedBy: "claude", reason: "x", expiresMs: -1 },
    async () => "sent",
  );
  const ctx = ctxOf();
  await fire("refresh", {}, ctx); // refresh sweeps

  expect(ctx.state.pending).toHaveLength(0);
  expect(ctx.state.log[0]).toMatchObject({ outcome: "expired" });
  await expect(settled).rejects.toThrow(/expired/);
});

test("the keyboard decides whatever is selected, no ids required", async () => {
  park("mycelium", "post", { room: "ship-kona", text: "one" });
  park("mycelium", "post", { room: "ship-kona", text: "two" });
  const ctx = ctxOf();
  await fire("refresh", {}, ctx);

  await fire("down", {}, ctx); // onto the second
  await fire("deny", {}, ctx); // `d`, no arguments — the human's affordance

  expect(ctx.state.pending).toHaveLength(1);
  expect(ctx.state.pending[0]!.args).toMatchObject({ text: "one" });
  // ...and the cursor stayed on a real row.
  expect(ctx.state.cursor).toBe(0);
});

test("approveAll / denyAll empty the queue", async () => {
  const runs: string[] = [];
  park("mycelium", "post", { text: "a" }, async () => (runs.push("a"), "ok"));
  park("mycelium", "post", { text: "b" }, async () => (runs.push("b"), "ok"));
  const ctx = ctxOf();
  await fire("refresh", {}, ctx);
  await fire("approveAll", {}, ctx);
  expect(runs).toEqual(["a", "b"]);
  expect(ctx.state.pending).toHaveLength(0);

  park("email", "trash", {}, async () => "gone");
  await fire("refresh", {}, ctx);
  await fire("denyAll", {}, ctx);
  expect(ctx.state.pending).toHaveLength(0);
});

test("the dash gets a loud card only while something is waiting", async () => {
  const ctx = ctxOf();
  await fire("refresh", {}, ctx);
  expect(def.dash!(ctx.state)).toBeNull();

  park("email", "send", { to: "ada" });
  await fire("refresh", {}, ctx);
  const card = def.dash!(ctx.state) as DashCard;
  expect(card).toMatchObject({ id: "pending" });
  expect(card.text).toContain("1 pending approval");
  expect(card.text).toContain("email.send");
  // Something is blocked on a human: nothing on the board outranks that.
  expect(card.priority).toBeGreaterThan(80);
});

test("the activity log records what ran without ever being held", async () => {
  approvals.record({ applet: "timer", verb: "start", args: { seconds: 300 }, priority: "low", by: "claude", result: { id: "t1" } });
  const ctx = ctxOf();
  await fire("refresh", {}, ctx);
  expect(ctx.state.log[0]).toMatchObject({ applet: "timer", verb: "start", outcome: "ran", allowed: true });
  // ...and clearing it is a separate act from deciding the queue.
  await fire("clear", {}, ctx);
  expect(ctx.state.log).toHaveLength(0);
});
