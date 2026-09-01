import { createCliRenderer, type CliRenderer } from "@opentui/core";
import type { AppletDef, AppletState, KeyBinding, Overlay } from "../sdk/index.ts";
import { loadApplets } from "../core/load.ts";
import { base, callVerb, ensureDaemon } from "../core/client.ts";
import { createStage, type Draft } from "./stage.ts";
import { applyKey, edit as mkEdit, type Edit } from "./editor.ts";

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

// Canonical navigation intents, each matched by an arrow key AND a vim key.
const isUp = (n: string) => n === "up" || n === "k";
const isDown = (n: string) => n === "down" || n === "j";
const isSelect = (n: string) => n === "return" || n === "right" || n === "l";
const isBack = (n: string) => n === "escape" || n === "left" || n === "backspace" || n === "h";

/** What a keypress does while an overlay owns the keyboard. */
export type OverlayAction =
  | { kind: "verb"; verb: string; args: Record<string, unknown> }
  | { kind: "trap" } // swallowed: the body must not move behind a dialog
  | { kind: "pass" }; // handled as usual by the applet

/**
 * Resolve a keypress against an open overlay. Confirm/dismiss/keymap fire
 * verbs; everything else is trapped — EXCEPT back on an overlay with no
 * dismiss verb, which passes through so an applet can never strand you in a
 * dialog it forgot to give an exit.
 */
export function overlayAction(overlay: Overlay, key: string): OverlayAction {
  if (isSelect(key) && overlay.confirm) return { kind: "verb", verb: overlay.confirm, args: {} };
  if (isBack(key)) return overlay.dismiss ? { kind: "verb", verb: overlay.dismiss, args: {} } : { kind: "pass" };
  const b = overlay.keymap?.[key];
  if (b) return { kind: "verb", ...resolveBinding(b) };
  return { kind: "trap" };
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

  // Own ctrl+c so shutdown is clean and single-press. The default tears down
  // the renderer's buffers but leaves our async loops (SSE subscribe, pending
  // renders) running — they then write to a destroyed buffer ("TextBuffer is
  // destroyed") and the process lingers until a second ctrl+c.
  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: false });
  const stage = createStage(renderer);

  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    try {
      (renderer as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      /* already torn down */
    }
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // null = launcher; otherwise the applet id currently open
  let current: string | null = startAppletId;
  let cursor = 0; // launcher selection

  // Search input mode (first-class): `/` opens a footer line editor.
  // Text fields in the view tree get the same treatment, one level down: while
  // an `input` node has focus the host holds its keystrokes as a draft and only
  // the finished string goes to a verb.
  let search: Edit | null = null;
  let draft: Draft | null = null;

  let filling = false;
  function render() {
    if (!alive) return; // never touch renderables after teardown
    const def = current ? byId.get(current) : null;
    if (!def) {
      current = null;
      search = null; // no applet, no line editor
      stage.renderLauncher(applets, cursor);
    } else {
      const state = (states[def.id] ?? def.initialState) as AppletState;
      stage.renderApplet(def, state);

      // If a search is open, keep the footer showing it — otherwise a background
      // re-render (e.g. a 1s scrubber tick) would clobber the search line.
      if (search && def.search) stage.searchBar(search, def.search.placeholder);

      // Viewport auto-fill: keep loading pages until the list covers the visible
      // rows, so a tall terminal isn't half-empty. Converges as count grows.
      const pg = def.paginate;
      if (!filling && pg?.count && (pg.hasMore?.(state) ?? false)) {
        const rows = stage.viewportHeight();
        if (pg.count(state) < rows - 2) {
          filling = true;
          callVerb(def.id, pg.more)
            .catch(() => {})
            .finally(() => {
              filling = false;
              render(); // re-check: keep filling until the viewport is covered
            });
        }
      }
    }

    // The applet owns focus: the moment the freshly rendered view stops focusing
    // the field we were typing into (submitted, cancelled, navigated away), the
    // half-typed draft is dead.
    if (draft && stage.focusedInput()?.id !== draft.id) {
      draft = null;
      stage.setDraft(null);
    }
  }

  // Subscribe in the background; re-render whenever our applet's state moves.
  // Auto-reconnects, so a dropped stream just shows a brief footer note.
  subscribe(
    (snap) => {
      if (!alive) return;
      Object.assign(states, snap);
      render();
    },
    (id, s) => {
      if (!alive) return;
      states[id] = s;
      if (id === current) render();
    },
    (attempt) => {
      if (alive) stage.footerNote(`reconnecting… (${attempt})`);
    },
  );

  /** Browser-like back: pop the applet's internal view, else exit to the launcher. */
  async function goBack(def: AppletDef, state: AppletState) {
    stage.resetScroll();
    if (def.nav?.back && def.nav.canBack?.(state)) await callVerb(def.id, def.nav.back).catch(() => {});
    else current = null;
  }

  renderer.keyInput.on(
    "keypress",
    async (k: { name: string; ctrl: boolean; sequence?: string; meta?: boolean }) => {
      const n = k.name;

      // ctrl+c: exit cleanly on the first press.
      if (k.ctrl && n === "c") return shutdown();

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

      // --- Overlay input mode: a floating layer owns the keyboard. Everything
      // that would move or navigate the body behind it is trapped, so a dialog
      // can't be scrolled out from under you. The exception is back with no
      // dismiss verb: it falls through, so an applet can never strand you.
      const overlay = def.overlay?.(state) ?? null;
      if (overlay) {
        const action = overlayAction(overlay, n);
        if (action.kind === "verb") {
          await callVerb(def.id, action.verb, action.args).catch(() => {});
          return;
        }
        if (action.kind === "trap") return;
      }

      // --- Search input mode: the footer line editor owns the keyboard.
      if (search && def.search) {
        const { edit: next, action } = applyKey(search, k);
        if (action === "submit") {
          const q = search.value;
          search = null;
          stage.resetScroll();
          await callVerb(def.id, def.search.verb, { q }).catch(() => {});
          render();
        } else if (action === "cancel") {
          search = null;
          render();
        } else if (action === "edit") {
          search = next;
          stage.searchBar(search, def.search.placeholder);
        }
        return;
      }

      // --- Text field: an `input` node in the view tree has focus, so every
      // key is text (even `/` and the arrows) until enter or esc ends the edit.
      const field = stage.focusedInput();
      if (field) {
        if (draft?.id !== field.id) draft = { id: field.id, edit: mkEdit(field.value) };
        const { edit: next, action } = applyKey(draft.edit, k);
        if (action === "submit") {
          const value = draft.edit.value;
          draft = null;
          stage.setDraft(null);
          if (field.submit) await callVerb(def.id, field.submit, { id: field.id, value }).catch(() => {});
          render();
        } else if (action === "cancel") {
          draft = null;
          stage.setDraft(null);
          // No cancel verb? Then esc means what it always means.
          if (field.cancel) await callVerb(def.id, field.cancel, { id: field.id }).catch(() => {});
          else await goBack(def, state);
          render();
        } else if (action === "edit") {
          const changed = next.value !== draft.edit.value;
          draft = { id: field.id, edit: next };
          stage.setDraft(draft);
          render();
          // Opt-in live editing (filter-as-you-type). Off by default: a verb per
          // keystroke is a round-trip per keystroke.
          if (changed && field.change) {
            await callVerb(def.id, field.change, { id: field.id, value: next.value }).catch(() => {});
          }
        }
        return;
      }

      // `/` opens search on a searchable applet.
      if (def.search && k.sequence === "/") {
        search = mkEdit("");
        stage.searchBar(search, def.search.placeholder);
        return;
      }

    // Back is browser-like: pop an internal view if the applet has one,
    // otherwise return to the launcher. Either way, reset scroll.
    if (isBack(n)) {
      await goBack(def, state);
      render();
      return;
    }

    // Up/Down. In a cursored list, move the cursor — the stage scrolls to keep
    // the selection visible (never yanks the whole list). In a plain document
    // (no selection, e.g. an email body), scroll the viewport directly.
    if (isUp(n) || isDown(n)) {
      const intent = isUp(n) ? nav?.up : nav?.down;
      if (stage.hasFocusTarget() && intent) {
        await callVerb(def.id, intent).catch(() => {});
      } else {
        stage.scrollBy(isUp(n) ? -2 : 2);
      }
      // Infinite pagination: at the end of the list with more to load, append.
      const pg = def.paginate;
      if (isDown(n) && pg && (pg.atEnd?.(state) ?? true) && (pg.hasMore?.(state) ?? false)) {
        await callVerb(def.id, pg.more).catch(() => {});
      }
      return;
    }

    // Select drills in (e.g. open an email); start it at the top. A verb may
    // return {navigate:"<appletId>"} to hyperlink into another applet.
    if (isSelect(n) && nav?.select) {
      stage.resetScroll();
      const res = (await callVerb(def.id, nav.select).catch(() => null)) as { result?: { navigate?: string } } | null;
      const target = res?.result?.navigate;
      if (typeof target === "string" && byId.has(target)) {
        current = target;
        render();
      }
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
