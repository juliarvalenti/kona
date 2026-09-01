import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createStage } from "../host/stage.ts";
import { edit } from "../host/editor.ts";
import { defineApplet, col, input, text, type AppletState } from "../sdk/index.ts";

/**
 * The text-field primitive, driven through the real stage on OpenTUI's headless
 * renderer — the render path the host uses, minus the terminal.
 */

interface FormState {
  name: string;
  editing: boolean;
  mask?: boolean;
}

const form = defineApplet<FormState>({
  id: "form",
  title: "Form",
  initialState: { name: "", editing: false },
  verbs: {},
  view: (s) => [
    text("who?"),
    col(
      [
        input("name", s.name, {
          placeholder: "your name",
          width: 14,
          focus: s.editing,
          mask: s.mask,
          submit: "save",
          cancel: "cancel",
        }),
      ],
      {},
    ),
  ],
});

async function mount(state: FormState, width = 40, height = 12) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height });
  const stage = createStage(renderer);
  const draw = async () => {
    stage.renderApplet(form as never, state as unknown as AppletState);
    await renderOnce();
    return captureCharFrame();
  };
  return { stage, draw };
}

test("an unfocused field renders its state value; no field has the keyboard", async () => {
  const { stage, draw } = await mount({ name: "ada", editing: false });
  const frame = await draw();
  expect(frame).toContain("ada");
  expect(stage.focusedInput()).toBeNull();
});

test("focusing a field hands it the keyboard and re-labels the hint bar", async () => {
  const { stage, draw } = await mount({ name: "ada", editing: true });
  const frame = await draw();
  expect(stage.focusedInput()).toMatchObject({ id: "name", submit: "save", cancel: "cancel" });
  // While a field is focused the footer talks about the edit, not navigation.
  expect(frame).toContain("enter save");
  expect(frame).toContain("esc cancel");
});

test("a draft overrides state while typing, and the field survives a state push", async () => {
  const state: FormState = { name: "ada", editing: true };
  const { stage, draw } = await mount(state);
  await draw();

  stage.setDraft({ id: "name", edit: edit("ada lovelace") });
  expect(await draw()).toContain("ada lovelace");

  // A background state push (SSE) re-renders — the half-typed draft must win.
  state.name = "someone else";
  const after = await draw();
  expect(after).toContain("ada lovelace");
  expect(after).not.toContain("someone else");

  // Dropping the draft (submit/cancel) hands the field back to state.
  stage.setDraft(null);
  expect(await draw()).toContain("someone else");
});

test("a draft for a different field is ignored", async () => {
  const { stage, draw } = await mount({ name: "ada", editing: true });
  stage.setDraft({ id: "other", edit: edit("nope") });
  const frame = await draw();
  expect(frame).toContain("ada");
  expect(frame).not.toContain("nope");
});

test("text longer than the field scrolls so the caret stays visible", async () => {
  const { stage, draw } = await mount({ name: "", editing: true });
  // 14-wide field, 24 chars typed, caret at the end: the head scrolls away.
  stage.setDraft({ id: "name", edit: edit("abcdefghijklmnopqrstuvwx") });
  const frame = await draw();
  expect(frame).toContain("lmnopqrstuvwx");
  expect(frame).not.toContain("abcdefg");
});

test("an unfocused field truncates a value too long to fit", async () => {
  const { draw } = await mount({ name: "abcdefghijklmnopqrstuvwx", editing: false });
  const frame = await draw();
  expect(frame).toContain("abcdefghijklm…"); // 14 cells: 13 chars + ellipsis
});

test("a masked field hides the value behind dots", async () => {
  const { draw } = await mount({ name: "hunter2", editing: false, mask: true });
  const frame = await draw();
  expect(frame).not.toContain("hunter2");
  expect(frame).toContain("•".repeat(7));
});

test("an empty field shows its placeholder, focused or not", async () => {
  const blurred = await mount({ name: "", editing: false });
  expect(await blurred.draw()).toContain("your name");

  const focused = await mount({ name: "", editing: true });
  expect(await focused.draw()).toContain("your name");
});
