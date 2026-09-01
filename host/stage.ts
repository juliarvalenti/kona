import {
  TextRenderable,
  BoxRenderable,
  ASCIIFontRenderable,
  StyledText,
  fg,
  bold,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import type { AppletDef, AppletState, KeyBinding, ViewNode, LayoutOpts } from "../sdk/index.ts";

/**
 * The stage: everything that turns applet view-nodes into OpenTUI renderables —
 * the bordered frame, the keybind hint bar, and the node->widget mapping. It is
 * renderer-agnostic, so the live host drives it with a real CliRenderer and the
 * snapshot tool/tests drive it with a headless test renderer.
 */

export const COLORS = {
  DIM: "#6a6a6a",
  FG: "#d0d0d0",
  ACCENT: "#7aa2f7",
  RED: "#ff5c57",
  KEY: "#e6e6e6",
};

export interface Hint {
  key: string;
  label: string;
}

const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
} as const;

function layoutProps(o: LayoutOpts) {
  return {
    ...(o.align ? { alignItems: ALIGN[o.align] } : {}),
    ...(o.justify ? { justifyContent: JUSTIFY[o.justify] } : {}),
    ...(o.gap !== undefined ? { gap: o.gap } : {}),
    ...(o.padding !== undefined ? { padding: o.padding } : {}),
    ...(o.width !== undefined ? { width: o.width } : {}),
    ...(o.grow ? { flexGrow: 1 } : {}),
  };
}

function bindingLabel(b: KeyBinding): string {
  return typeof b === "string" ? b : (b.label ?? b.verb);
}

export interface Stage {
  renderApplet(def: AppletDef, state: AppletState): void;
  renderLauncher(applets: AppletDef[], cursor: number): void;
  footerNote(text: string, color?: string): void;
}

export function createStage(renderer: CliRenderer): Stage {
  const { DIM, FG, ACCENT, KEY } = COLORS;

  renderer.root.flexDirection = "column";
  const stage = new BoxRenderable(renderer, {
    id: "stage",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  });
  const frame = new BoxRenderable(renderer, {
    id: "frame",
    border: true,
    borderStyle: "rounded",
    borderColor: ACCENT,
    padding: 1,
    flexDirection: "column",
    alignItems: "stretch", // children fill width; applets align themselves
    minWidth: 44,
  });
  stage.add(frame);
  const footer = new TextRenderable(renderer, { id: "footer", content: "", paddingLeft: 1 });
  renderer.root.add(stage);
  renderer.root.add(footer);

  function setFooter(hints: Hint[]) {
    const chunks: TextChunk[] = [];
    hints.forEach((h, i) => {
      if (i) chunks.push(fg(DIM)("    "));
      chunks.push(fg(KEY)(bold(h.key)));
      chunks.push(fg(DIM)(` ${h.label}`));
    });
    footer.content = new StyledText(chunks);
    renderer.requestRender();
  }

  // Rebuild the frame's children each render; destroy old nodes so native
  // buffers (ASCII fonts) don't leak.
  let seq = 0;
  function setFrame(title: string, titleColor: string, nodes: ViewNode[]) {
    frame.title = ` ${title} `;
    frame.titleAlignment = "center";
    frame.borderColor = titleColor;
    for (const child of [...frame.getChildren()]) {
      frame.remove(child);
      (child as { destroy?: () => void }).destroy?.();
    }
    const gen = seq++;
    nodes.forEach((node, i) => frame.add(nodeToRenderable(node, `n${gen}-${i}`)));
    renderer.requestRender();
  }

  function nodeToRenderable(node: ViewNode, id: string): Renderable {
    if (typeof node === "string") return new TextRenderable(renderer, { id, content: node, fg: FG });
    switch (node.kind) {
      case "big":
        return new ASCIIFontRenderable(renderer, { id, text: node.text, font: node.font ?? "block", color: node.color ?? FG });
      case "text":
        return new TextRenderable(renderer, { id, content: node.text, fg: node.dim ? DIM : (node.color ?? FG) });
      case "spacer":
        return new TextRenderable(renderer, { id, content: " " });
      case "row":
      case "col": {
        const box = new BoxRenderable(renderer, {
          id,
          flexDirection: node.kind === "row" ? "row" : "column",
          ...layoutProps(node.opts),
        });
        node.children.forEach((child, i) => box.add(nodeToRenderable(child, `${id}.${i}`)));
        return box;
      }
      case "bar": {
        const width = node.width ?? 24;
        // Sub-cell resolution: full blocks + one fractional block = 8x smoother,
        // so slow bars visibly move instead of looking frozen.
        const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
        const eighths = Math.round(node.value * width * 8);
        const full = Math.floor(eighths / 8);
        const partial = PARTIALS[eighths % 8]!;
        const content = ("█".repeat(full) + partial).padEnd(width, "░");
        return new TextRenderable(renderer, { id, content, fg: node.color ?? FG });
      }
    }
  }

  return {
    renderApplet(def, state) {
      const body = def.view(state);
      const nodes: ViewNode[] = Array.isArray(body) ? (body as ViewNode[]) : [body as ViewNode];
      const accent = def.accent?.(state) ?? ACCENT;
      setFrame(def.title, accent, nodes);
      const hints: Hint[] = Object.entries(def.keymap ?? {}).map(([key, b]) => ({ key, label: bindingLabel(b) }));
      hints.push({ key: "esc", label: "back" }, { key: "ctrl+c", label: "quit" });
      setFooter(hints);
    },
    renderLauncher(applets, cursor) {
      const nodes: ViewNode[] = [{ kind: "text", text: "pick an app", dim: true }, { kind: "spacer" }];
      applets.forEach((a, i) => {
        const sel = i === cursor;
        nodes.push({ kind: "text", text: `${sel ? "▸" : " "} ${a.title}`, color: sel ? ACCENT : FG });
      });
      setFrame("kona", ACCENT, nodes);
      setFooter([
        { key: "↑/↓", label: "move" },
        { key: "enter", label: "open" },
        { key: "ctrl+c", label: "quit" },
      ]);
    },
    footerNote(text, color = COLORS.RED) {
      footer.content = new StyledText([fg(color)(text)]);
      renderer.requestRender();
    },
  };
}
