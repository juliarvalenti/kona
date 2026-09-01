import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  ASCIIFontRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import type { AppletDef, AppletState, KeyBinding, ViewNode } from "../sdk/index.ts";
import { loadApplets } from "../core/load.ts";
import { base, callVerb } from "../core/client.ts";

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
  return typeof b === "string" ? { verb: b, args: {} } : b;
}

/** Stream the daemon's SSE, invoking onState for every state change. */
async function subscribe(onSnapshot: (s: States) => void, onState: (id: string, s: AppletState) => void) {
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

export async function runHost(startAppletId: string | null) {
  const applets = await loadApplets();
  const byId = new Map<string, AppletDef>(applets.map((a) => [a.id, a]));
  const states: States = {};

  const DIM = "#6a6a6a";
  const FG = "#d0d0d0";
  const ACCENT = "#7aa2f7";
  const DONE_RED = "#ff5c57";

  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });

  // Center a single bordered frame on screen; its children are rebuilt per view.
  renderer.root.alignItems = "center";
  renderer.root.justifyContent = "center";
  const frame = new BoxRenderable(renderer, {
    id: "frame",
    border: true,
    borderStyle: "rounded",
    borderColor: ACCENT,
    padding: 1,
    flexDirection: "column",
    alignItems: "center",
    minWidth: 40,
  });
  renderer.root.add(frame);

  // null = launcher; otherwise the applet id currently open
  let current: string | null = startAppletId;
  let cursor = 0; // launcher selection

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
    }
  }

  function renderLauncher() {
    const nodes: ViewNode[] = [{ kind: "text", text: "pick an app", dim: true }, { kind: "spacer" }];
    applets.forEach((a, i) => {
      const sel = i === cursor;
      nodes.push({ kind: "text", text: `${sel ? "▸" : " "} ${a.title}`, color: sel ? ACCENT : FG });
    });
    nodes.push({ kind: "spacer" }, { kind: "text", text: "↑/↓ move · enter open · ctrl+c quit", dim: true });
    setFrame("kona", ACCENT, nodes);
  }

  function renderApplet() {
    const def = current ? byId.get(current) : null;
    if (!def) return renderLauncher();
    const state = (states[def.id] ?? def.initialState) as AppletState;
    const body = def.view(state);
    const nodes: ViewNode[] = Array.isArray(body) ? (body as ViewNode[]) : [body as ViewNode];
    const accent = def.accent?.(state) ?? ACCENT;
    setFrame(def.title, accent, [...nodes, { kind: "spacer" }, { kind: "text", text: "esc back · ctrl+c quit", dim: true }]);
  }

  function render() {
    if (current) renderApplet();
    else renderLauncher();
  }

  // Subscribe in the background; re-render whenever our applet's state moves.
  subscribe(
    (snap) => {
      Object.assign(states, snap);
      render();
    },
    (id, s) => {
      states[id] = s;
      if (id === current) renderApplet();
    },
  ).catch((e) => {
    setFrame("kona", DONE_RED, [{ kind: "text", text: `lost daemon: ${String(e)}`, color: DONE_RED }]);
  });

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
