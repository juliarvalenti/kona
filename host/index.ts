import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { bindingFor, type AppletDef, type AppletState, type KeyBinding, type Overlay } from "../sdk/index.ts";
import { loadApplets } from "../core/load.ts";
import { filterApplets } from "../core/catalog.ts";
import { base, callVerb, ensureDaemon } from "../core/client.ts";
import { createStage, COPY_PROMPT_KEY, type Draft } from "./stage.ts";
import { applyKey, edit as mkEdit, type Edit } from "./editor.ts";
import { appletPrompt, surfacePrompt } from "../core/prompt.ts";
import { clipboardHelpers, copyToClipboard } from "../core/clipboard.ts";
import { theme } from "../core/config.ts";

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
/**
 * The name a keypress goes into a keymap under. A ctrl-held key is its own
 * binding (`ctrl+s`), so an applet can bind one without shadowing the plain
 * letter — and the hint bar shows it as the fingers press it.
 */
export function keyName(k: { name: string; ctrl?: boolean }): string {
  return k.ctrl ? `ctrl+${k.name}` : k.name;
}


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

/**
 * Does this keypress start a launcher filter? `/` always does; so does any
 * ordinary printable character — with 15+ apps, typing the name is the fast
 * path. The vim movement keys are the exception: they keep navigating, so
 * hjkl never becomes "type h". Press `/` first to filter for one of them.
 */
export function startsFilter(k: { name: string; ctrl?: boolean; meta?: boolean; sequence?: string }): boolean {
  if (k.ctrl || k.meta) return false;
  if (k.sequence === "/") return true;
  if (isUp(k.name) || isDown(k.name) || isSelect(k.name) || isBack(k.name)) return false;
  const s = k.sequence ?? "";
  // A bare space starts nothing — a query never begins with one, and the key is
  // too easy to hit by accident to hand the whole screen a mode change.
  return s.length === 1 && s > " " && s !== "\x7f";
}

/** What a keypress does on the launcher. */
export type LauncherAction =
  | { kind: "move"; cursor: number }
  | { kind: "open"; index: number }
  /** The filter changed (`edit: null` closes it); the cursor restarts on it. */
  | { kind: "filter"; edit: Edit | null; cursor: number }
  | { kind: "none" };

/**
 * The launcher's whole keyboard, as one pure step — the same shape as
 * `overlayAction`, so what a key does on the "pick an app" screen is testable
 * without a terminal.
 *
 * `count` is how many applets are LISTED (post-filter) and `cursor` indexes
 * those, because that is what is on screen and what enter opens. The filter is
 * a line editor like any other: while it is open the letters are text, but the
 * keys it has no use for (↑/↓) still move the selection, so narrowing the list
 * and picking from it is one gesture rather than two modes.
 */
export function launcherKey(
  view: { count: number; cursor: number; filter: Edit | null },
  k: { name: string; ctrl?: boolean; meta?: boolean; sequence?: string },
): LauncherAction {
  const { count, cursor, filter } = view;

  if (filter) {
    const { edit: next, action } = applyKey(filter, k);
    // esc, or backspacing out of an already-empty filter, puts the list back.
    if (action === "cancel" || (action === "edit" && !next.value && !filter.value)) {
      return { kind: "filter", edit: null, cursor: 0 };
    }
    if (action === "edit") return { kind: "filter", edit: next, cursor: 0 };
    if (action === "submit") return count ? { kind: "open", index: cursor } : { kind: "none" };
    // "ignore" — the editor doesn't want it, so it means what it always means.
  } else if (startsFilter(k)) {
    // `/` opens an empty filter; any other printable key opens one that already
    // holds it, so the first letter you type is never eaten.
    return { kind: "filter", edit: mkEdit(k.sequence === "/" ? "" : (k.sequence ?? "")), cursor: 0 };
  }

  if (!count) return { kind: "none" };
  if (isUp(k.name)) return { kind: "move", cursor: (cursor - 1 + count) % count };
  if (isDown(k.name)) return { kind: "move", cursor: (cursor + 1) % count };
  if (isSelect(k.name)) return { kind: "open", index: cursor };
  return { kind: "none" };
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
  // useMouse: the terminal reports clicks and the wheel; the stage resolves them
  // to rows and the handler below turns them into the same intents as the keys.
  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
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
  let cursor = 0; // launcher selection, indexing the FILTERED list

  // Search input mode (first-class): `/` opens a footer line editor.
  // Text fields in the view tree get the same treatment, one level down: while
  // an `input` node has focus the host holds its keystrokes as a draft and only
  // the finished string goes to a verb.
  let search: Edit | null = null;
  let draft: Draft | null = null;

  // The launcher's own line editor — the same one, one screen up. `/` (or just
  // typing) opens it and the list narrows as you type, which is the fast path
  // once there are more apps than fit on screen.
  let filter: Edit | null = null;
  /** The applets the launcher is showing right now. */
  const shown = () => filterApplets(applets, filter?.value ?? "");

  /**
   * Open an applet from the launcher. The filter has done its job, so it goes;
   * the cursor moves to that app in the FULL list, so coming back lands you
   * where you left rather than at the top.
   */
  function openFromLauncher(id: string) {
    filter = null;
    cursor = Math.max(0, applets.findIndex((a) => a.id === id));
    current = id;
    stage.resetScroll();
  }

  let filling = false;
  function render() {
    if (!alive) return; // never touch renderables after teardown
    const def = current ? byId.get(current) : null;
    if (!def) {
      current = null;
      search = null; // no applet, no applet-level line editor
      const list = shown();
      // A filter that just narrowed can leave the cursor past the end.
      cursor = list.length ? Math.min(cursor, list.length - 1) : 0;
      stage.renderLauncher(list, cursor, { query: filter?.value ?? "", total: applets.length });
      // Same rule as an applet's search line: while the filter is open it owns
      // the footer, so a background re-render can't clobber what you typed.
      if (filter) {
        stage.searchBar(filter, "type to narrow the list", {
          label: "filter",
          hint: "enter open · esc clear",
        });
      }
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

  /**
   * The select intent: fire the applet's select verb and follow a hyperlink if
   * the verb returns one. Shared by → / enter / l and by a mouse click, which
   * passes the clicked row's `{ index }` so the applet moves its cursor there.
   */
  async function select(def: AppletDef, args: Record<string, unknown> = {}) {
    if (!def.nav?.select) return;
    stage.resetScroll();
    const res = (await callVerb(def.id, def.nav.select, args).catch(() => null)) as
      | { result?: { navigate?: string } }
      | null;
    const target = res?.result?.navigate;
    if (typeof target === "string" && byId.has(target)) {
      current = target;
      render();
    }
  }

  /**
   * Copy prompt: hand the agent in the next window a blurb that teaches it to
   * drive THIS surface — the applet you have open, or (from the launcher) the
   * whole set. Generated from the live manifest the host already loaded, so it
   * names the verbs actually installed on this machine, and goes out through
   * the system clipboard because that is where a paste comes from.
   */
  async function copyPrompt() {
    const def = current ? byId.get(current) : null;
    const url = base();
    const text = def ? appletPrompt(def, { base: url }) : surfacePrompt(applets, { base: url });
    const what = def ? `\`${def.id}\`` : `all ${applets.length} applets`;
    const result = await copyToClipboard(text);
    const { ok, error } = theme();
    if (result === "copied") stage.footerNote(`copied a prompt for ${what} — paste it to your agent`, ok);
    else if (result === "unsupported")
      stage.footerNote(`no clipboard helper — install one of ${clipboardHelpers()}, or set KONA_CLIPBOARD`, error);
    else stage.footerNote("clipboard helper failed — nothing copied", error);
    // The note lives in the hint bar, so put the hints back after a beat.
    setTimeout(() => render(), 2500);
  }

  // The mouse rides the same intents as the keyboard: a click on a row is that
  // row's "select" (cursor moves there, then the verb fires); the wheel scrolls.
  stage.onMouse((e) => {
    if (!alive) return;
    if (e.kind === "wheel") return stage.scrollBy(e.lines);
    if (e.index === null) return; // clicked the chrome or a non-selectable line
    if (search) {
      search = null; // reaching for the mouse abandons the search line
      render();
    }
    if (current === null) {
      // The click carries the row's index into what is ON SCREEN, which with a
      // filter open is not the full list.
      const pick = shown()[e.index];
      if (pick) openFromLauncher(pick.id);
      render();
      return;
    }
    const def = byId.get(current);
    if (def) void select(def, { index: e.index });
  });

  renderer.keyInput.on(
    "keypress",
    async (k: { name: string; ctrl: boolean; sequence?: string; meta?: boolean }) => {
      // ctrl+c: exit cleanly on the first press.
      if (k.ctrl && k.name === "c") return shutdown();

      const n = keyName(k);

      if (current === null) {
        const list = shown();
        const act = launcherKey({ count: list.length, cursor, filter }, k);
        if (act.kind === "filter") {
          filter = act.edit;
          cursor = act.cursor;
          stage.resetScroll(); // a new set of matches starts at the top
        } else if (act.kind === "move") {
          cursor = act.cursor;
        } else if (act.kind === "open") {
          const pick = list[act.index];
          if (pick) openFromLauncher(pick.id);
        }
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

      // The field with the keyboard, if any. While an overlay is up the stage
      // only looks INSIDE it, so a dialog's own field takes the keys and a
      // field in the body behind it is inert.
      const field = stage.focusedInput();

      // --- Overlay input mode: a floating layer owns the keyboard. Everything
      // that would move or navigate the body behind it is trapped, so a dialog
      // can't be scrolled out from under you. The exception is back with no
      // dismiss verb: it falls through, so an applet can never strand you.
      const overlay = def.overlay?.(state) ?? null;
      if (overlay && !field) {
        const action = overlayAction(overlay, n);
        if (action.kind === "verb") {
          await callVerb(def.id, action.verb, action.args).catch(() => {});
          return;
        }
        if (action.kind === "trap") return;
      }

      // --- Search input mode: the footer line editor owns the keyboard.
      if (!overlay && search && def.search) {
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
      // key is text (even `/` and the arrows) until submit or esc ends the edit
      // — enter for a one-line field, ctrl+d for a textarea.
      if (field) {
        if (draft?.id !== field.id) draft = { id: field.id, edit: mkEdit(field.value) };
        // A textarea spends enter on a newline, so the editor is told which
        // shape the field is: same brain, different exit key (ctrl+d).
        const { edit: next, action } = applyKey(draft.edit, k, { multiline: field.multiline });
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
        } else if (overlay) {
          // A key the editor has no use for (tab, say) still belongs to the
          // dialog around the field — that's how a form moves between fields.
          const dialogKey = overlayAction(overlay, n);
          if (dialogKey.kind === "verb") await callVerb(def.id, dialogKey.verb, dialogKey.args).catch(() => {});
        }
        return;
      }

      // `/` opens search on a searchable applet.
      if (def.search && k.sequence === "/") {
        search = mkEdit("");
        stage.searchBar(search, def.search.placeholder);
        return;
      }

    // The applet's own keymap is matched FIRST, so a `when`-guarded binding can
    // claim a navigation key on one screen (spotify scrubs with ←/→ while
    // now-playing) without stealing it everywhere else. Unclaimed keys fall
    // through to the canonical nav intents below.
    const claimed = bindingFor(def, n, state);
    if (claimed) {
      const { verb, args } = resolveBinding(claimed);
      await callVerb(def.id, verb, args).catch(() => {});
      return;
    }

    // Platform keybind: teach an agent the surface you are looking at. Matched
    // AFTER the applet's keymap, so an applet that binds the key keeps it.
    if (n === COPY_PROMPT_KEY) {
      await copyPrompt();
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
      await select(def);
      return;
    }
  });

  render();

  // hold the process open; ctrl+c exits via exitOnCtrlC
  await new Promise(() => {});
}
