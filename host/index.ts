import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { bindingFor, type AppletDef, type AppletState } from "../sdk/index.ts";
import { loadApplets } from "../core/load.ts";
import { filterApplets } from "../core/catalog.ts";
import { base, callVerb, ensureDaemon } from "../core/client.ts";
import { createStage, COPY_PROMPT_KEY, LAUNCHER_COPY_PROMPT_KEY, type Draft } from "./stage.ts";
import { applyKey, edit as mkEdit, type Edit } from "./editor.ts";
import { resolveKey, keyName, isUp, isDown, isSelect, isBack, type InputContext } from "./input.ts";
import { appletPrompt, surfacePrompt } from "../core/prompt.ts";
import { clipboardHelpers, copyToClipboard } from "../core/clipboard.ts";
import { refreshConfig, setThemeOverride, theme } from "../core/config.ts";

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

/**
 * Keys are resolved by the input state machine in ./input.ts: it names the mode
 * that owns the keyboard and returns an ACTION. Everything below the handler is
 * the other half — performing those actions.
 */

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
  /** Copy an agent prompt for every installed applet (#62). */
  | { kind: "prompt" }
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

  // Copy-prompt for the whole set. It sits after the filter (which only ever
  // "ignores" a ctrl chord) and before the count guard, because a prompt for
  // what is INSTALLED doesn't depend on what the filter currently matches.
  if (keyName(k) === LAUNCHER_COPY_PROMPT_KEY) return { kind: "prompt" };

  if (!count) return { kind: "none" };
  if (isUp(k.name)) return { kind: "move", cursor: (cursor - 1 + count) % count };
  if (isDown(k.name)) return { kind: "move", cursor: (cursor + 1) % count };
  if (isSelect(k.name)) return { kind: "open", index: cursor };
  return { kind: "none" };
}

/** Stream the daemon's SSE, invoking onState for every state change. */
// The server heartbeats every 15s to keep the socket warm; if a sleep/wake or
// network change silently kills the TCP connection, no error ever surfaces —
// reader.read() just hangs forever and the reconnect loop below never fires.
// Race each read against a watchdog so a stalled (not just dropped) stream
// still gets torn down and retried.
const STALL_MS = 45_000;

async function readStream(
  onSnapshot: (s: States) => void,
  onState: (id: string, s: AppletState) => void,
) {
  const controller = new AbortController();
  const res = await fetch(`${base()}/events`, { signal: controller.signal });
  if (!res.body) throw new Error("no event stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      let timer!: ReturnType<typeof setTimeout>;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("stream stalled")), STALL_MS);
      });
      const { done, value } = await Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
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
  } finally {
    // Stalled or not, make sure the dead socket actually gets torn down —
    // otherwise it leaks and the next connection attempt has nothing to do
    // with reclaiming it.
    controller.abort();
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
    // Theming is live, from both ends. The file may have changed under us (the
    // picker's `set`, or an editor), and the applet on screen may be standing a
    // palette in front of it (the picker's preview) — so both are settled
    // before anything is drawn, and leaving the applet drops the preview by
    // simply not asking for it again.
    refreshConfig();
    const state = def ? ((states[def.id] ?? def.initialState) as AppletState) : null;
    setThemeOverride(def && state ? (def.theme?.(state) ?? null) : null);
    if (!def || !state) {
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

  // One keypress: ask the state machine what it means, then do exactly that.
  // Every mode's precedence lives in ./input.ts, so this half stays a flat list
  // of effects — no ladder, no early return that quietly claims someone's key.
  renderer.keyInput.on(
    "keypress",
    async (k: { name: string; ctrl: boolean; sequence?: string; meta?: boolean }) => {
      // ctrl+c: exit on the first press, before anything else — building the
      // input context calls the applet's own overlay(state), and a view that
      // throws must never sit between you and the exit. (The state machine also
      // maps this to `quit`, but the launcher branch below returns before we
      // reach it, so it has to be handled here too.)
      if (k.ctrl && k.name === "c") return shutdown();

      // Launcher: the type-to-filter list has its own mini state machine
      // (launcherKey), because it edits a footer buffer and indexes the FILTERED
      // set — neither of which the applet input machine knows about.
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
        } else if (act.kind === "prompt") {
          // Draw first, then copy: copyPrompt() writes its result into the
          // footer, and a render after it would wipe the note it just left.
          render();
          await copyPrompt();
          return;
        }
        render();
        return;
      }

      const def = current ? (byId.get(current) ?? null) : null;
      if (current && !def) {
        // The open applet vanished (unloaded plugin) — fall back to the launcher.
        current = null;
        render();
        return;
      }
      const state = (def ? (states[def.id] ?? def.initialState) : {}) as AppletState;
      // The field with the keyboard, if any. While an overlay is up the stage
      // only looks INSIDE it, so a dialog's own field takes the keys and a
      // field in the body behind it is inert.
      const ctx: InputContext = {
        def,
        state,
        overlay: def?.overlay?.(state) ?? null,
        field: stage.focusedInput(),
        search,
        draft,
      };
      const action = resolveKey(ctx, k);

      switch (action.kind) {
        case "quit":
          return shutdown();

        case "none":
          // The state machine had no use for this key. One platform keybind
          // still applies in normal mode: copy-prompt (#55), matched AFTER the
          // applet's own keymap so an applet that binds the key keeps it.
          if (
            def &&
            !ctx.overlay &&
            !ctx.field &&
            !(search && def.search) &&
            keyName(k) === COPY_PROMPT_KEY &&
            !bindingFor(def, COPY_PROMPT_KEY, state)
          ) {
            await copyPrompt();
          }
          return;

        case "launcherMove":
          cursor = (cursor + action.delta + applets.length) % applets.length;
          return render();

        case "launcherOpen":
          current = applets[cursor]?.id ?? null;
          return render();

        case "verb":
          await callVerb(def!.id, action.verb, action.args).catch(() => {});
          return;

        case "searchOpen":
          search = mkEdit("");
          stage.searchBar(search, def!.search!.placeholder);
          return;

        case "searchEdit":
          search = action.edit;
          stage.searchBar(search, def!.search!.placeholder);
          return;

        case "searchSubmit": {
          search = null;
          stage.resetScroll();
          await callVerb(def!.id, def!.search!.verb, { q: action.q }).catch(() => {});
          render();
          return;
        }

        case "searchCancel":
          search = null;
          render();
          return;

        case "fieldEdit": {
          draft = { id: action.field.id, edit: action.edit };
          stage.setDraft(draft);
          render();
          // Opt-in live editing (filter-as-you-type). Off by default: a verb per
          // keystroke is a round-trip per keystroke.
          if (action.changed && action.field.change) {
            await callVerb(def!.id, action.field.change, { id: action.field.id, value: action.edit.value }).catch(() => {});
          }
          return;
        }

        case "fieldSubmit": {
          draft = null;
          stage.setDraft(null);
          if (action.field.submit) {
            await callVerb(def!.id, action.field.submit, { id: action.field.id, value: action.value }).catch(() => {});
          }
          render();
          return;
        }

        case "fieldCancel": {
          draft = null;
          stage.setDraft(null);
          // No cancel verb? Then esc means what it always means.
          if (action.field.cancel) await callVerb(def!.id, action.field.cancel, { id: action.field.id }).catch(() => {});
          else await goBack(def!, state);
          render();
          return;
        }

        case "back":
          // Browser-like: pop an internal view if the applet has one, otherwise
          // return to the launcher. Either way, reset scroll.
          await goBack(def!, state);
          render();
          return;

        case "move": {
          // In a cursored list, move the cursor — the stage scrolls to keep the
          // selection visible (never yanks the whole list). In a plain document
          // (no selection, e.g. an email body), scroll the viewport directly.
          const intent = action.delta < 0 ? def!.nav?.up : def!.nav?.down;
          if (stage.hasFocusTarget() && intent) await callVerb(def!.id, intent).catch(() => {});
          else stage.scrollBy(action.delta * 2);
          // Infinite pagination: at the end of the list with more to load, append.
          const pg = def!.paginate;
          if (action.delta > 0 && pg && (pg.atEnd?.(state) ?? true) && (pg.hasMore?.(state) ?? false)) {
            await callVerb(def!.id, pg.more).catch(() => {});
          }
          return;
        }

        case "select":
          // Drills in (e.g. open an email); starts at the top. A verb may return
          // {navigate:"<appletId>"} to hyperlink into another applet.
          await select(def!);
          return;
      }
    },
  );

  render();

  // hold the process open; ctrl+c exits via exitOnCtrlC
  await new Promise(() => {});
}
