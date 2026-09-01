/**
 * kona SDK — the applet contract.
 *
 * An applet is a pure object over shared state. It exposes:
 *   - verbs   : actions. Run server-side. Triggered by YOU (a keypress) or the
 *               AGENT (an HTTP call) — the applet cannot tell the difference and
 *               does not care. This indifference is the whole platform thesis.
 *   - view    : how the current state looks in the TUI. Pure: state -> lines.
 *   - keymap  : which key fires which verb (first-class, per-applet).
 *   - tick    : optional heartbeat the daemon calls on an interval (the timer
 *               counts down here); it mutates state and emits like any verb.
 *
 * The daemon loads this module for verbs/tick/state. The host loads the SAME
 * module for view/keymap. State lives in the daemon and streams to the host
 * over SSE, so the two consumers never touch the same memory — only the same
 * logical state.
 */

export interface AppletCtx<S = AppletState> {
  /** This applet's state slice. Mutate it freely, then call emit(). */
  state: S;
  /** Notify every subscriber (the TUI, any agent watching) that state changed. */
  emit: () => void;
  /**
   * Read another applet's live state (read-only). Every applet's tick runs in
   * the daemon regardless of what's on screen, so a dashboard can compose them.
   */
  peek?: (appletId: string) => AppletState | undefined;
  /**
   * Fire another applet's verb — the SAME entry point an agent's POST and a
   * keypress land on, so an applet composing others is just one more caller.
   * This is what makes `workflows` possible without the engine knowing HTTP.
   * Resolves with the verb's return value; rejects if the applet or verb is
   * unknown, exactly as the HTTP seam 404s.
   */
  call?: (appletId: string, verb: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export type AppletState = Record<string, unknown>;

export type Verb<S = AppletState> = (
  args: Record<string, unknown>,
  ctx: AppletCtx<S>,
) => unknown | Promise<unknown>;

/**
 * A key can fire a verb by name, or a verb with fixed args and a display label.
 * The `label` is what the host's keybind hint bar shows (falls back to the verb
 * name), so keybinds document themselves.
 *
 * A binding may also claim a key only in certain states via `when`: the host
 * checks the keymap BEFORE the navigation intents, so an applet can take over
 * ←/→ on one screen (spotify scrubs while now-playing) and leave them to
 * navigation everywhere else. `when` gates the hint bar too, so the footer
 * always shows the keys that actually do something right now.
 */
export type KeyBinding<S = AppletState> =
  | string
  | { verb: string; args?: Record<string, unknown>; label?: string; when?: (state: S) => boolean };

/**
 * The binding a key fires in this state, or null if the applet doesn't claim
 * it (unbound, or its `when` guard is false). One place decides, so the host's
 * dispatch and the hint bar can never disagree.
 */
export function bindingFor<S extends object>(
  def: Pick<AppletDef<S>, "keymap">,
  key: string,
  state: S,
): KeyBinding<S> | null {
  const b = def.keymap?.[key];
  if (!b) return null;
  if (typeof b !== "string" && b.when && !b.when(state)) return null;
  return b;
}

/** Hex color, e.g. "#00d488". */
export type Color = string;

/**
 * Theming + per-applet settings, re-exported so an applet has ONE import.
 * Colors live in `~/.config/kona/config.toml` (see core/config.ts): name a
 * semantic ROLE — `theme().ok`, not "#00d488" — and one file rethemes all of
 * kona. `appletConfig("<id>")` is that applet's own `[applets.<id>]` block.
 */
export {
  theme,
  appletConfig,
  appletAccent,
  appletString,
  appletNumber,
  appletBool,
  type Theme,
} from "../core/config.ts";

/** ASCII-art fonts the host can render for a `big` node. */
export type BigFont = "block" | "tiny" | "slick" | "shade" | "huge" | "grid" | "pallet";

/**
 * The view vocabulary — deliberately tiny. An applet's `view` returns these and
 * the host maps them to terminal widgets. Plain strings are lines; richer nodes
 * opt into a hero display or color. Grow this set only when an applet needs it.
 *
 * A `text` node carries two selection hints: `focus` marks the row the cursor is
 * on (the host scrolls to keep it visible) and `index` marks the row as a
 * SELECTABLE TARGET — clicking it fires `nav.select` with that `{ index }`. Both
 * are set for you by the list components in ./components.ts.
 */
/** Cross-axis alignment (align-items). */
export type Align = "start" | "center" | "end" | "stretch";
/** Main-axis distribution (justify-content). */
export type Justify = "start" | "center" | "end" | "between" | "around";
/** Flexbox knobs for row/col containers. */
export interface LayoutOpts {
  align?: Align;
  justify?: Justify;
  gap?: number;
  padding?: number;
  width?: number | `${number}%`;
  grow?: boolean;
}

/**
 * An editable text field. The applet owns the value AND the focus, both in
 * state — so an agent can fill a field (`POST .../verbs/save {"value":"…"}`)
 * with no terminal in sight, exactly as a human typing into it would. While a
 * field is focused the host keeps the in-flight keystrokes locally (a draft) so
 * typing never round-trips to the daemon, and hands the finished string to
 * `submit`.
 */
export interface InputNode {
  kind: "input";
  /** Stable id. Names the field in verb payloads and keys its draft. */
  id: string;
  /** The value as state knows it. Shown until the field takes focus. */
  value: string;
  /** Shown dim when the value is empty. */
  placeholder?: string;
  /** True when this field has the keyboard. Applet state decides. */
  focus?: boolean;
  /** Field width in cells; longer text scrolls under the caret. */
  width?: number;
  /**
   * Make it a TEXTAREA: the value keeps its newlines, enter inserts one and
   * `submit` moves to ctrl+d. Long lines word-wrap inside the field and it
   * scrolls vertically under the caret, so a note body is edited in place.
   */
  multiline?: boolean;
  /** Visible lines of a multiline field (default 6). Ignored otherwise. */
  rows?: number;
  /** Render the value as dots (secrets). */
  mask?: boolean;
  /** Verb fired on enter — ctrl+d in a multiline field — with `{ id, value }`. */
  submit?: string;
  /** What that key does, for the hint bar ("send", "create"). Defaults to "save". */
  submitLabel?: string;
  /** Verb fired on esc with `{ id }`. Without one, esc falls back to `back`. */
  cancel?: string;
  /** What esc does, for the hint bar. Defaults to "cancel". */
  cancelLabel?: string;
  /** Verb fired on every keystroke with `{ id, value }` — opt into live edits. */
  change?: string;
  color?: Color;
}

/** Border look for a `box` node. */
export type BorderStyle = "single" | "double" | "rounded" | "heavy";
/** A `box` is a `col` that can draw a border, a title and a background. */
export interface BoxOpts extends LayoutOpts {
  title?: string;
  titleAlign?: "left" | "center" | "right";
  /** Draw a border (default true when a title is set). */
  border?: boolean;
  borderStyle?: BorderStyle;
  borderColor?: Color;
  bg?: Color;
}

export type ViewNode =
  | string
  | { kind: "big"; text: string; color?: Color; font?: BigFont }
  | { kind: "text"; text: string; color?: Color; dim?: boolean; bg?: Color; focus?: boolean; index?: number }
  | { kind: "spacer" }
  | { kind: "row"; children: ViewNode[]; opts: LayoutOpts }
  | { kind: "col"; children: ViewNode[]; opts: LayoutOpts }
  | { kind: "bar"; value: number; width?: number; color?: Color }
  | InputNode
  | { kind: "box"; children: ViewNode[]; opts: BoxOpts };

export type View = string | string[] | ViewNode[];

/** Render context passed to view() so applets can size to the actual viewport. */
export interface ViewCtx {
  width: number;
  height: number;
}

/**
 * Primitive node constructors. `row`/`col` are the layout containers (flexbox);
 * everything richer (progress, key/value, lists) is a plain function that
 * composes these — see sdk/components.ts. The host only understands primitives.
 */
export const big = (text: string, color?: Color, font?: BigFont): ViewNode => ({ kind: "big", text, color, font });
export const text = (t: string, opts: { color?: Color; dim?: boolean; bg?: Color; focus?: boolean; index?: number } = {}): ViewNode => ({ kind: "text", text: t, ...opts });
export const spacer = (): ViewNode => ({ kind: "spacer" });
/** Lay children out horizontally. */
export const row = (children: ViewNode[], opts: LayoutOpts = {}): ViewNode => ({ kind: "row", children, opts });
/** Stack children vertically. */
export const col = (children: ViewNode[], opts: LayoutOpts = {}): ViewNode => ({ kind: "col", children, opts });
/** An editable text field; see InputNode. */
export const input = (
  id: string,
  value: string,
  opts: Omit<InputNode, "kind" | "id" | "value"> = {},
): ViewNode => ({ kind: "input", id, value, ...opts });
/**
 * A multi-line text field — the same node with `multiline` set, named for what
 * it is. Enter inserts a newline and ctrl+d fires `submit`, so a body that
 * contains blank lines can still be typed and saved from the keyboard.
 */
export const textarea = (
  id: string,
  value: string,
  opts: Omit<InputNode, "kind" | "id" | "value" | "multiline"> = {},
): ViewNode => ({ kind: "input", id, value, multiline: true, ...opts });
/** A fill bar; value is 0..1. */
export const bar = (value: number, opts: { width?: number; color?: Color } = {}): ViewNode => ({
  kind: "bar",
  value: Math.max(0, Math.min(1, value)),
  ...opts,
});
/**
 * A bordered container — a `col` that can also draw a frame, a title and a
 * background. The one node the host draws chrome for; `card`/`modal` in
 * sdk/components.ts are thin wrappers over it.
 */
export const box = (children: ViewNode[], opts: BoxOpts = {}): ViewNode => ({ kind: "box", children, opts });

/**
 * Navigation model. The host binds canonical intents to BOTH arrow keys and
 * vim keys, so movement is first-class and uniform across applets:
 *   up:    ↑ / k      down: ↓ / j
 *   select:→ / enter / l      back: ← / esc / backspace / h
 * `back` is browser-like: if `canBack(state)` is true the host fires the back
 * verb (pop an internal view, e.g. close an open email); otherwise it returns
 * to the launcher. Each field names a verb to fire.
 *
 * The mouse rides the same intents: a click on a selectable row fires `select`
 * with the row's `{ index }`, and the wheel scrolls the viewport.
 */
export interface Nav<S extends object = AppletState> {
  up?: string;
  down?: string;
  /**
   * Acts on the selection. Fired bare by → / enter / l; fired with
   * `{ index }` when the mouse clicks a row (a click means "select THAT row,
   * then act"). A select verb should honour `index` by moving its cursor there
   * first, and fall back to the current cursor when it is absent.
   */
  select?: string;
  selectLabel?: string;
  back?: string;
  backLabel?: string;
  canBack?: (state: S) => boolean;
}

/**
 * A floating layer drawn ON TOP of the applet body — a confirm dialog, a detail
 * popover. The terminal has no z-axis of its own, so the host provides one: an
 * overlay is positioned absolutely over the content viewport, does not scroll
 * with the body, and does not displace it.
 *
 * It is also an INPUT MODE. While `overlay(state)` returns non-null the host
 * routes keys here instead of to `nav`/`keymap`, so the body cannot be scrolled
 * or navigated behind a dialog. The one deliberate exception: with no `dismiss`
 * verb, back (esc/←) falls through to the applet's normal back — an applet can
 * never trap you in a dialog it forgot to give an exit.
 */
export interface Overlay {
  /** What to draw, centered over the body. Usually `modal(...)`. */
  node: ViewNode;
  /** Cover the body behind the layer. Off by default: the body shows around it. */
  scrim?: boolean;
  /** Verb fired by enter/→ (the affirmative action). */
  confirm?: string;
  confirmLabel?: string;
  /** Verb fired by esc/← (dismiss). */
  dismiss?: string;
  dismissLabel?: string;
  /** Extra keys while the layer is up. Replaces the applet's keymap. */
  keymap?: Record<string, KeyBinding>;
}

/**
 * A verb call, named declaratively so a caller that is NOT the daemon (the CLI,
 * a script) can fire it over HTTP.
 */
export interface AppletCall {
  verb: string;
  args?: Record<string, unknown>;
}

/** How an applet extends the `kona` command line. */
export interface AppletCli<S extends object = AppletState> {
  /** One line for `kona --help`, e.g. "kona timer 5m | kona timer pomodoro". */
  usage?: string;
  /**
   * Turn `kona <id> <args...>` into verbs fired before the TUI opens. Runs in
   * the CLI process with the applet's live state in hand, so it can decide
   * from state (the timer only applies its preset to an idle clock). Return
   * null for "just open it".
   */
  open?: (args: string[], state: S) => AppletCall | AppletCall[] | null;
}

/** Sign-in for one service, as `kona login <name>` / `kona logout <name>`. */
export interface AuthProvider {
  /** Run the flow; resolve with who signed in. */
  login: () => Promise<string>;
  /** Drop one account (or all of them, with no argument). */
  logout: (who?: string) => void | Promise<void>;
}

/**
 * An event this applet can raise as a desktop banner. `kona notify` lists what
 * an applet declares here, so the switchboard has no list of its own.
 */
export interface NotificationSpec {
  /** What fires it, shown by `kona notify`. */
  summary: string;
  /** On when the config says nothing? Defaults to false (opt in). */
  default?: boolean;
}

export interface AppletDef<S extends object = AppletState> {
  /** Stable id, used in the CLI and HTTP routes: `kona <id>`, `/applets/<id>`. */
  id: string;
  /** Human title shown in the launcher. */
  title: string;
  /** One-line description for the "pick an app" launcher. */
  summary?: string;
  /**
   * One glyph that IS this applet in the launcher. Keep it a single cell —
   * emoji are double-width and corrupt the row. `[applets.<id>].icon` in the
   * config overrides it; without either you get a neutral bullet.
   */
  icon?: string;
  /**
   * The applet's brand color, used wherever it is listed rather than open (the
   * launcher row, its selected bar). Static on purpose: `accent(state)` is the
   * LIVE frame tint and may say something about right now (the timer goes red
   * as it runs out), which is not an identity. `[applets.<id>].accent`
   * overrides it.
   */
  tint?: Color;
  /** Free-form tags for the catalog (`kona docs`), e.g. ["network", "mail"]. */
  labels?: string[];
  /** What the applet needs to be useful — an account, a config file, a binary. */
  requires?: string[];
  /** State the applet boots with. */
  initialState: S;
  /** If true, state is held in memory only — never persisted to disk (e.g. mail). */
  ephemeral?: boolean;
  /** Actions. Keyed by verb name. */
  verbs: Record<string, Verb<S>>;
  /** Pure render: current state (+ viewport size) -> what the host draws. */
  view: (state: S, ctx?: ViewCtx) => View;
  /** Optional frame tint (border/title color) derived from state. */
  accent?: (state: S) => Color;
  /** Navigation intents (arrows + vim + browser-like back). */
  nav?: Nav<S>;
  /**
   * A floating layer above the body. Returning non-null both draws the layer
   * and puts the host in overlay input mode — see `Overlay`.
   */
  overlay?: (state: S) => Overlay | null;
  /**
   * Makes the applet searchable. The host binds `/` to open a search line;
   * submitting fires `verb` with `{ q: <typed query> }`. First-class across
   * any applet — the host owns the input UI.
   */
  search?: { verb: string; placeholder?: string };
  /**
   * Infinite pagination. The host fires the `more` verb to fetch+append the
   * next page when the user reaches the end (down + `atEnd` + `hasMore`) AND,
   * on open/resize, keeps firing while `count(state)` is below the number of
   * visible rows — so a tall terminal fills instead of showing 20 in 50 lines.
   */
  paginate?: {
    more: string;
    hasMore?: (state: S) => boolean;
    atEnd?: (state: S) => boolean;
    count?: (state: S) => number;
  };
  /** Breadcrumb for the current sub-view, shown in the title (e.g. open email). */
  crumb?: (state: S) => string | null;
  /** key -> verb for actions (e.g. { r: "refresh" }). Bindings are matched
   * before the navigation intents, so a `when`-guarded entry may claim a nav
   * key (←/→) on a specific screen. */
  keymap?: Record<string, KeyBinding<S>>;
  /**
   * Agent-facing docs, keyed by verb name. A string is the one-liner; the
   * object form also carries example args, so the manifest can print a command
   * an agent can paste. This is what `GET /tools` and the generated skill read,
   * so a verb documents itself where it is written and the skill cannot drift.
   */
  docs?: Record<string, VerbDoc>;
  /** Multi-step flows worth showing an agent; emitted into the skill verbatim. */
  recipes?: Recipe[];
  /** If set, the daemon calls tick every tickMs while the applet is "live". */
  tick?: (ctx: AppletCtx<S>) => void;
  tickMs?: number;
  /**
   * Verb calls the daemon should make on a CALENDAR rather than a heartbeat.
   * `tick` answers "every N ms while loaded"; this answers "08:30 on weekdays".
   * The daemon reads it from live state on every scheduler pass, so a job
   * appears, changes or disappears the moment a verb edits state — which is how
   * `workflows` schedules itself without the daemon knowing what a workflow is.
   */
  cron?: (state: S) => CronJob[];
  /** Called once when the daemon boots — good for an initial data load. */
  init?: (ctx: AppletCtx<S>) => void;

  // --- the package manifest: what an applet tells the PLATFORM about itself.
  // Everything below replaces an entry an applet used to have to add to a
  // shared file, which is what makes a new applet a new directory and nothing
  // else. All of it is optional.

  /** Extends `kona <id> ...`; see AppletCli. */
  cli?: AppletCli<S>;
  /**
   * Services this applet can sign into, keyed by the name `kona login <name>`
   * takes. The value loads the provider lazily, so an OAuth module is only
   * imported when someone actually signs in:
   * `{ gmail: () => import("../../server/google.ts") }`.
   */
  auth?: Record<string, () => Promise<AuthProvider>>;
  /**
   * Desktop notifications this applet raises, keyed by the `event` it passes to
   * `notify()`. Declaring one here is what makes it listable and toggleable by
   * `kona notify` — there is no central catalogue.
   */
  notifications?: Record<string, NotificationSpec>;
  /**
   * A commented `[applets.<id>]` block for the starter file `kona config init`
   * writes. Document your settings where you read them.
   */
  configSample?: string;
}

/**
 * One scheduled verb call. `id` names it within the applet (the daemon keys the
 * schedule on `<applet>:<id>:<cron>`, so editing the expression reschedules by
 * construction), `cron` is a 5-field expression, an `@daily`-style shorthand or
 * `@every 10m` — see server/cron.ts.
 */
export interface CronJob {
  id: string;
  cron: string;
  verb: string;
  args?: Record<string, unknown>;
}

/** Identity helper — gives you types and a stable shape. */
export function defineApplet<S extends object>(def: AppletDef<S>): AppletDef<S> {
  return def;
}

/** Type-erased applet, as the daemon/host/loader handle them generically. */
export type AnyApplet = AppletDef<AppletState>;

/**
 * What a verb does, for the agent reading the manifest. The object form adds
 * example args — the exact JSON body a caller can send — so a tool entry is
 * self-demonstrating.
 */
export type VerbDoc = string | { doc: string; args?: Record<string, unknown> };

/** A worked flow: what to accomplish, and the calls that accomplish it. */
export interface Recipe {
  /** What the flow does, e.g. "Start a 25-minute focus timer". */
  title: string;
  /** Shell lines in order — usually `kona call ...` / `kona state ...`. */
  steps: string[];
  /** One line of context printed under the steps. */
  note?: string;
}

/**
 * The tool manifest entry an agent reads to learn what it can call. It carries
 * the applet's identity as well as the verb's, so `GET /tools` alone is enough
 * to drive kona — an agent never has to hardcode an applet id or guess args.
 */
export interface ToolSpec {
  name: string; // `${appletId}.${verb}`
  applet: string;
  verb: string;
  /** The applet's human title. */
  title: string;
  /** The applet's one-liner. */
  summary?: string;
  /** What this verb does (from the applet's `docs` block). */
  doc?: string;
  /** Example args — a ready-to-send JSON body. */
  args?: Record<string, unknown>;
  /** The TUI key that fires the same verb, when one is bound. */
  key?: string;
  /** A cursor/navigation verb (up/down/back/select) — the keyboard's business,
   * rarely an agent's: address a row by id or index instead. */
  nav?: boolean;
}

/** key -> verb, for annotating the manifest with the keyboard's equivalent. */
function keysByVerb(def: AnyApplet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, binding] of Object.entries(def.keymap ?? {})) {
    const verb = typeof binding === "string" ? binding : binding.verb;
    out[verb] ??= key;
  }
  return out;
}

/** Verbs the host wires to cursor movement — noise in an agent's tool list. */
function navVerbs(def: AnyApplet): Set<string> {
  const { up, down, back } = def.nav ?? {};
  return new Set([up, down, back].filter((v): v is string => !!v));
}

export function toolsForApplet(def: AnyApplet): ToolSpec[] {
  const keys = keysByVerb(def);
  const cursor = navVerbs(def);
  return Object.keys(def.verbs).map((verb) => {
    const doc = def.docs?.[verb];
    const spec: ToolSpec = {
      name: `${def.id}.${verb}`,
      applet: def.id,
      verb,
      title: def.title,
    };
    if (def.summary) spec.summary = def.summary;
    if (typeof doc === "string") spec.doc = doc;
    else if (doc) {
      spec.doc = doc.doc;
      if (doc.args) spec.args = doc.args;
    }
    if (keys[verb]) spec.key = keys[verb];
    if (cursor.has(verb)) spec.nav = true;
    return spec;
  });
}
