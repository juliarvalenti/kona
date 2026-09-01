import { createCliRenderer, TextRenderable, type CliRenderer } from "@opentui/core";
import type { AppletDef, AppletState, KeyBinding } from "../sdk/index.ts";
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

  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });
  const screen = new TextRenderable(renderer, { id: "screen", content: "" });
  renderer.root.add(screen);

  // null = launcher; otherwise the applet id currently open
  let current: string | null = startAppletId;
  let cursor = 0; // launcher selection

  function paint(lines: string[]) {
    screen.content = lines.join("\n");
    renderer.requestRender();
  }

  function renderLauncher() {
    const lines: string[] = ["kona — pick an app", ""];
    applets.forEach((a, i) => {
      const mark = i === cursor ? "▸" : " ";
      lines.push(`  ${mark} ${a.title.padEnd(14)} ${a.summary ?? ""}`);
    });
    lines.push("", "  ↑/↓ move · enter open · ctrl+c quit");
    paint(lines);
  }

  function renderApplet() {
    const def = current ? byId.get(current) : null;
    if (!def) return renderLauncher();
    const state = states[def.id] ?? def.initialState;
    const body = def.view(state as AppletState);
    const lines = Array.isArray(body) ? body : [body];
    const keys = Object.keys(def.keymap ?? {});
    const help = keys.length ? `${keys.join(" · ")}  ·  ` : "";
    paint([`${def.title}  (${def.id})`, ...lines, "", `  ${help}esc back · ctrl+c quit`]);
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
    screen.content = `lost daemon: ${String(e)}`;
    renderer.requestRender();
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
