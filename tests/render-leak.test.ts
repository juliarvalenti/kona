import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { resolveRenderLib } from "@opentui/core";
import { clearChildren } from "../host/chrome.ts";
import { createStage } from "../host/stage.ts";
import {
  box,
  col,
  defineApplet,
  row,
  text,
  type AppletDef,
  type AppletState,
  type ViewNode,
} from "../sdk/index.ts";

/**
 * A repaint must cost nothing that lasts.
 *
 * The host rebuilds the frame from scratch every render, which is fine as long
 * as the frame it threw away is actually freed. It wasn't: `clearChildren`
 * called OpenTUI's `destroy()`, which frees a node's own buffers and then only
 * REMOVES its children — so every leaf of a nested view (and a view is all
 * nesting: cells in a row in a column) kept its native TextBuffer forever. One
 * repaint a second hid it; a game ticking several times a second exhausted the
 * allocator in seconds, and `new TextBuffer` threw "Failed to create TextBuffer"
 * from inside the render, taking the TUI down mid-game (#99).
 *
 * So this is the platform's own regression test, in two halves: the contract
 * (`clearChildren` reaches the whole subtree) and the symptom (native
 * allocations do not climb frame after frame).
 */

const lib = resolveRenderLib();
const active = () => Number(lib.getAllocatorStats().activeAllocations);

/** A view with the shape that made the leak fatal: many leaves, several deep. */
function board(frame: number): ViewNode[] {
  const rows: ViewNode[] = [];
  for (let y = 0; y < 12; y++) {
    const cells: ViewNode[] = [];
    for (let x = 0; x < 8; x++) {
      cells.push(text((x + y + frame) % 3 === 0 ? "██" : "· ", { color: "#7aa2f7" }));
    }
    rows.push(row(cells));
  }
  // A hero too: an ASCII font is the most expensive node an applet can draw,
  // and a score beside a board is the reason one gets rebuilt this often.
  return [row([box(rows, { border: true }), col([{ kind: "big", text: String(frame) }])], { gap: 2 })];
}

const game = defineApplet<{ frame: number }>({
  id: "leaky",
  title: "Leaky",
  initialState: { frame: 0 },
  verbs: {},
  view: (state) => board(state.frame),
});

test("a subtree is destroyed, not just detached", () => {
  // A stand-in for the renderable tree, with OpenTUI's own contract: `destroy`
  // frees this node and detaches its children, `destroyRecursively` reaches all
  // of them. Getting the two confused is the whole bug.
  const destroyed: string[] = [];
  const node = (id: string, children: Node[] = []): Node => {
    const self: Node = {
      id,
      children,
      getChildren: () => self.children,
      remove: (child: Node) => (self.children = self.children.filter((c) => c !== child)),
      destroy: () => {
        destroyed.push(id);
        self.children = [];
      },
      destroyRecursively: () => {
        for (const child of [...self.children]) child.destroyRecursively();
        self.destroy();
      },
    };
    return self;
  };
  interface Node {
    id: string;
    children: Node[];
    getChildren: () => Node[];
    remove: (child: Node) => void;
    destroy: () => void;
    destroyRecursively: () => void;
  }

  const parent = node("root", [
    node("col", [node("row", [node("cell-a"), node("cell-b")]), node("big")]),
  ]);
  clearChildren(parent as unknown as { getChildren(): unknown[]; remove(child: never): void });

  expect(parent.getChildren()).toEqual([]);
  expect(destroyed.sort()).toEqual(["big", "cell-a", "cell-b", "col", "row"]);
});

test("sixty repaints of a board leave the allocator where they found it", async () => {
  const cap = await createTestRenderer({ width: 80, height: 24 });
  const stage = createStage(cap.renderer);
  const state = { frame: 0 } as AppletState;
  const draw = async (frame: number) => {
    (state as { frame: number }).frame = frame;
    stage.renderApplet(game as unknown as AppletDef, state);
    await cap.renderOnce();
  };

  // Warm up first: the first frames allocate the chrome, the font atlas and
  // whatever else is built once, and none of that is a leak.
  for (let f = 0; f < 10; f++) await draw(f);
  const before = active();
  const frames = 60;
  for (let f = 10; f < 10 + frames; f++) await draw(f);
  const perFrame = (active() - before) / frames;

  // The leak was ~130 native allocations per frame. What a repaint is allowed
  // to leave behind is one frame's own working set, spread over sixty — so the
  // bar is generous and a regression still misses it by an order of magnitude.
  expect(perFrame).toBeLessThan(8);
  cap.renderer.destroy();
});
