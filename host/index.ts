import { createCliRenderer, type CliRenderer } from "@opentui/core";
import type { AppletDef, AppletState, KeyBinding } from "../sdk/index.ts";
import { loadApplets } from "../core/load.ts";
import { base, callVerb, ensureDaemon } from "../core/client.ts";
import { createStage } from "./stage.ts";

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

  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });
  const stage = createStage(renderer);

  // null = launcher; otherwise the applet id currently open
  let current: string | null = startAppletId;
  let cursor = 0; // launcher selection

  function render() {
    const def = current ? byId.get(current) : null;
    if (def) stage.renderApplet(def, (states[def.id] ?? def.initialState) as AppletState);
    else {
      current = null;
      stage.renderLauncher(applets, cursor);
    }
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
      if (id === current) render();
    },
    (attempt) => stage.footerNote(`reconnecting… (${attempt})`),
  );

  // Canonical navigation intents, each matched by an arrow key AND a vim key.
  const isUp = (n: string) => n === "up" || n === "k";
  const isDown = (n: string) => n === "down" || n === "j";
  const isSelect = (n: string) => n === "return" || n === "right" || n === "l";
  const isBack = (n: string) => n === "escape" || n === "left" || n === "backspace" || n === "h";

  renderer.keyInput.on("keypress", async (k: { name: string; ctrl: boolean }) => {
    const n = k.name;
    // ctrl+c is handled by exitOnCtrlC.

    if (current === null) {
      // launcher navigation
      if (isUp(n)) cursor = (cursor - 1 + applets.length) % applets.length;
      else if (isDown(n)) cursor = (cursor + 1) % applets.length;
      else if (isSelect(n)) current = applets[cursor]?.id ?? null;
      render();
      return;
    }

    const def = byId.get(current);
    if (!def) {
      current = null;
      render();
      return;
    }
    const state = (states[def.id] ?? def.initialState) as AppletState;
    const nav = def.nav;

    // Back is browser-like: pop an internal view if the applet has one,
    // otherwise return to the launcher. Either way, reset scroll.
    if (isBack(n)) {
      stage.resetScroll();
      if (nav?.back && nav.canBack?.(state)) await callVerb(def.id, nav.back).catch(() => {});
      else {
        current = null;
        render();
      }
      return;
    }

    // Up/Down scroll the viewport (for long content like an email body) and
    // also drive the applet's list cursor if it has one.
    if (isUp(n) || isDown(n)) {
      stage.scrollBy(isUp(n) ? -3 : 3);
      const intent = isUp(n) ? nav?.up : nav?.down;
      if (intent) await callVerb(def.id, intent).catch(() => {});
      return;
    }

    // Select drills in (e.g. open an email); start it at the top.
    if (isSelect(n) && nav?.select) {
      stage.resetScroll();
      await callVerb(def.id, nav.select).catch(() => {});
      return;
    }

    // Non-nav actions from the keymap (letters like r).
    const binding = def.keymap?.[n];
    if (binding) {
      const { verb, args } = resolveBinding(binding);
      await callVerb(def.id, verb, args).catch(() => {});
    }
  });

  render();

  // hold the process open; ctrl+c exits via exitOnCtrlC
  await new Promise(() => {});
}
