import {
  createCliRenderer,
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

/** A key + what it does, for the hint bar. */
interface Hint {
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

/** Translate our LayoutOpts into OpenTUI/yoga box props. */
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
import { loadApplets } from "../core/load.ts";
import { base, callVerb, ensureDaemon } from "../core/client.ts";

/**
 * The host is a THIN client. It never owns state — it loads applet modules only
 * for their `view` and `keymap`, subscribes to the daemon's SSE stream for
 * state, and turns your keypresses into verb calls (the same calls an agent
 * makes). Two consumers, one truth.
 */

// NOTE: do NOT put raw ANSI escapes (\x1b[..m) in TextRenderable content —
// OpenTUI renders through its own cell buffer and miscounts their width, which
// corrupts layout when line counts change (e.g. switching launcher<->applet).
// Style via OpenTUI's API instead; here we keep it plain and use glyphs/markers.

type States = Record<string, AppletState>;

function resolveBinding(b: KeyBinding): { verb: string; args: Record<string, unknown> } {
  return typeof b === "string" ? { verb: b, args: {} } : { verb: b.verb, args: b.args ?? {} };
}

/** Human label for a binding in the hint bar (explicit label, else the verb). */
function bindingLabel(b: KeyBinding): string {
  return typeof b === "string" ? b : (b.label ?? b.verb);
}

/** Stream the daemon's SSE, invoking onState for every state change. */
async function readStream(
  onSnapshot: (s: States) => void,
  onState: (id: string, s: AppletState) => void,
) {
  const res = await fetch(`${base()}/events`);
  if (!res.body) throw new Error("no event stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "snapshot") onSnapshot(parsed as States);
      else if (event === "state") onState(parsed.applet, parsed.state);
    }
  }
}

/**
 * Subscribe with auto-reconnect. A dropped stream (idle timeout, daemon blip,
 * transient socket error) reconnects with backoff instead of killing the UI —
 * so a paused applet or a hiccup no longer shows "lost daemon". onDrop reports
 * transient state; a fresh snapshot re-syncs on reconnect.
 */
async function subscribe(
  onSnapshot: (s: States) => void,
  onState: (id: string, s: AppletState) => void,
  onDrop: (attempt: number) => void,
) {
  let attempt = 0;
  for (;;) {
    try {
      await readStream(onSnapshot, onState);
      attempt = 0; // clean end (rare) — reconnect immediately
    } catch {
      attempt++;
      onDrop(attempt);
      // If the daemon itself died (not just a socket blip), bring it back.
      if (attempt >= 2) await ensureDaemon().catch(() => {});
    }
    await Bun.sleep(Math.min(2000, 150 * 2 ** Math.min(attempt, 4)));
  }
}

export async function runHost(startAppletId: string | null) {
  const applets = await loadApplets();
  const byId = new Map<string, AppletDef>(applets.map((a) => [a.id, a]));
  const states: States = {};

  const DIM = "#6a6a6a";
  const FG = "#d0d0d0";
  const ACCENT = "#7aa2f7";
  const DONE_RED = "#ff5c57";

  const KEY = "#e6e6e6"; // hint-bar key: bright. label stays DIM (opencode-style)

  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });

  // Layout: a stage that centers the frame, with a keybind hint bar pinned below.
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

  // null = launcher; otherwise the applet id currently open
  let current: string | null = startAppletId;
  let cursor = 0; // launcher selection

  // opencode-style hint bar: each key bright+bold, its label dim, gap between.
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

  // Rebuild the frame's children from scratch each render. Cheap at our cadence
  // (~1Hz); destroy old nodes so native buffers (ASCII fonts) don't leak.
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
    nodes.forEach((node, i) => {
      const id = `n${gen}-${i}`;
      frame.add(nodeToRenderable(node, id));
    });
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

  function renderLauncher() {
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
  }

  function renderApplet() {
    const def = current ? byId.get(current) : null;
    if (!def) return renderLauncher();
    const state = (states[def.id] ?? def.initialState) as AppletState;
    const body = def.view(state);
    const nodes: ViewNode[] = Array.isArray(body) ? (body as ViewNode[]) : [body as ViewNode];
    const accent = def.accent?.(state) ?? ACCENT;
    setFrame(def.title, accent, nodes);

    // The keybind hint bar IS the keymap — keys are first-class, self-documenting.
    const hints: Hint[] = Object.entries(def.keymap ?? {}).map(([key, b]) => ({
      key,
      label: bindingLabel(b),
    }));
    hints.push({ key: "esc", label: "back" }, { key: "ctrl+c", label: "quit" });
    setFooter(hints);
  }

  function render() {
    if (current) renderApplet();
    else renderLauncher();
  }

  // Subscribe in the background; re-render whenever our applet's state moves.
  // Auto-reconnects, so a dropped stream just shows a brief footer note.
  subscribe(
    (snap) => {
      Object.assign(states, snap);
      render();
    },
    (id, s) => {
      states[id] = s;
      if (id === current) renderApplet();
    },
    (attempt) => {
      footer.content = new StyledText([fg(DONE_RED)(`reconnecting… (${attempt})`)]);
      renderer.requestRender();
    },
  );

  renderer.keyInput.on("keypress", async (k: { name: string; ctrl: boolean }) => {
    // ctrl+c is handled by exitOnCtrlC.
    if (current === null) {
      // launcher navigation
      if (k.name === "up" || k.name === "k") cursor = (cursor - 1 + applets.length) % applets.length;
      else if (k.name === "down" || k.name === "j") cursor = (cursor + 1) % applets.length;
      else if (k.name === "return" || k.name === "right" || k.name === "l") {
        current = applets[cursor]?.id ?? null;
      }
      render();
      return;
    }

    // inside an applet
    if (k.name === "escape" || k.name === "q") {
      current = null;
      render();
      return;
    }
    const def = byId.get(current);
    const binding = def?.keymap?.[k.name];
    if (def && binding) {
      const { verb, args } = resolveBinding(binding);
      // Fire the verb at the daemon — identical to what the agent does.
      await callVerb(def.id, verb, args).catch(() => {});
      // state update arrives via SSE and repaints; no local mutation.
    }
  });

  render();

  // hold the process open; ctrl+c exits via exitOnCtrlC
  await new Promise(() => {});
}
