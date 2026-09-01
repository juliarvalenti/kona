import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
import { overlayAction } from "../host/input.ts";
import { defineApplet, text, col, input, type AppletDef, type AppletState, type Overlay } from "../sdk/index.ts";
import { modal, list } from "../sdk/components.ts";

/**
 * The overlay seam: a floating layer that draws OVER the body instead of in it,
 * and takes the keyboard while it's up. The render half is checked against real
 * on-screen output; the input half against the key resolver the host uses.
 */

const ROWS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

const demo = defineApplet<{ open: boolean; scrim: boolean }>({
  id: "demo",
  title: "Demo",
  initialState: { open: false, scrim: false },
  verbs: {},
  view: () => [col(list(ROWS, { cursor: 1 }), { gap: 0 })],
  keymap: { r: "refresh" },
  overlay: (s) =>
    s.open
      ? {
          node: modal("confirm?", [text("delete 'two'")], { width: 28 }),
          scrim: s.scrim,
          confirm: "ok",
          confirmLabel: "delete",
          dismiss: "cancel",
        }
      : null,
});

async function frameOf(state: Record<string, unknown>, width = 54, height = 18): Promise<string> {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height });
  createStage(renderer).renderApplet(demo as unknown as AppletDef, state as AppletState);
  await renderOnce();
  return captureCharFrame();
}

test("with no overlay the body renders alone", async () => {
  const frame = await frameOf({ open: false });
  expect(frame).toContain("one");
  expect(frame).toContain("eight");
  expect(frame).not.toContain("confirm?");
});

test("an overlay floats over the body without displacing it", async () => {
  const frame = await frameOf({ open: true, scrim: false });
  expect(frame).toContain("confirm?"); // the dialog is drawn
  // Every body row is still on screen: the layer is absolutely positioned, so
  // it covers content rather than pushing it down (the inline-modal bug).
  for (const rowLabel of ROWS) expect(frame).toContain(rowLabel);
});

test("a scrim covers the body behind the overlay", async () => {
  const frame = await frameOf({ open: true, scrim: true });
  expect(frame).toContain("delete 'two'");
  expect(frame).not.toContain("seven"); // body hidden, not merely overdrawn
});

test("an open overlay owns the hint bar", async () => {
  const frame = await frameOf({ open: true, scrim: true });
  expect(frame).toContain("enter delete");
  expect(frame).toContain("esc cancel");
  expect(frame).not.toContain("r refresh"); // the body's keys are inert under it
});

test("returning to the launcher clears a live overlay", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 54, height: 18 });
  const stage = createStage(renderer);
  stage.renderApplet(demo as unknown as AppletDef, { open: true, scrim: true } as AppletState);
  await renderOnce();
  expect(captureCharFrame()).toContain("confirm?");
  stage.renderLauncher([demo as unknown as AppletDef], 0);
  await renderOnce();
  expect(captureCharFrame()).not.toContain("confirm?");
});

const overlay: Overlay = {
  node: text("x"),
  confirm: "ok",
  dismiss: "cancel",
  keymap: { d: { verb: "delete", args: { force: true } } },
};

test("overlay keys fire confirm, dismiss, and its own keymap", () => {
  expect(overlayAction(overlay, "return")).toMatchObject({ kind: "verb", verb: "ok" });
  expect(overlayAction(overlay, "escape")).toMatchObject({ kind: "verb", verb: "cancel" });
  expect(overlayAction(overlay, "d")).toMatchObject({ kind: "verb", verb: "delete", args: { force: true } });
});

test("overlay traps keys that would move the body behind it", () => {
  for (const key of ["down", "j", "up", "/", "r"]) {
    expect(overlayAction(overlay, key)).toEqual({ kind: "trap" });
  }
});

test("back falls through when an overlay declares no dismiss verb", () => {
  // Otherwise an applet could strand you in a dialog with no exit.
  const noExit: Overlay = { node: text("x"), confirm: "ok" };
  expect(overlayAction(noExit, "escape")).toEqual({ kind: "pass" });
  expect(overlayAction(noExit, "down")).toEqual({ kind: "trap" });
});

/**
 * A form inside a dialog. The overlay owns the keyboard, but a field inside it
 * owns it one level further down — otherwise a modal could never take text,
 * which is what a "new room" or "rename" dialog is entirely made of.
 */
const form = defineApplet<{ open: boolean; name: string; field: string }>({
  id: "form",
  title: "Form",
  initialState: { open: false, name: "", field: "name" },
  verbs: {},
  view: (s) => [col(list(ROWS, { cursor: 1 }), { gap: 0 }), input("body", s.name, { focus: !s.open })],
  overlay: (s) =>
    s.open
      ? {
          node: modal("new room", [
            input("room.name", s.name, { focus: s.field === "name", submit: "create", submitLabel: "create", cancel: "dismiss", width: 20 }),
          ]),
          scrim: true,
          dismiss: "dismiss",
          keymap: { tab: { verb: "next", label: "next field" } },
        }
      : null,
});

async function mountForm(state: Record<string, unknown>) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 54, height: 18 });
  const stage = createStage(renderer);
  stage.renderApplet(form as unknown as AppletDef, state as AppletState);
  await renderOnce();
  return { stage, frame: captureCharFrame() };
}

test("a field inside a dialog takes the keyboard", async () => {
  const { stage, frame } = await mountForm({ open: true, name: "ship-kona", field: "name" });
  expect(frame).toContain("new room");
  expect(stage.focusedInput()?.id).toBe("room.name");
});

test("a field behind a dialog does not", async () => {
  // The body's own field is focused, but a dialog is up: keys belong to the
  // dialog, not to whatever was being typed into underneath it.
  const { stage } = await mountForm({ open: true, name: "", field: "topic" });
  expect(stage.focusedInput()).toBeNull();
  const closed = await mountForm({ open: false, name: "", field: "name" });
  expect(closed.stage.focusedInput()?.id).toBe("body");
});

test("a dialog with a focused field hands the hint bar to that field", async () => {
  const { frame } = await mountForm({ open: true, name: "ship-kona", field: "name" });
  const hints = frame.replace(/\s+/g, " "); // the legend wraps at this width
  expect(hints).toContain("enter create"); // the field's submit, named by the applet
  expect(hints).toContain("tab next field"); // ...and the dialog's own key survives
  expect(hints).toContain("esc cancel");
});
