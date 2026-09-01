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
 */
export type KeyBinding =
  | string
  | { verb: string; args?: Record<string, unknown>; label?: string };

/** Hex color, e.g. "#00d488". */
export type Color = string;

/** ASCII-art fonts the host can render for a `big` node. */
export type BigFont = "block" | "tiny" | "slick" | "shade" | "huge" | "grid" | "pallet";

/**
 * The view vocabulary — deliberately tiny. An applet's `view` returns these and
 * the host maps them to terminal widgets. Plain strings are lines; richer nodes
 * opt into a hero display or color. Grow this set only when an applet needs it.
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

export type ViewNode =
  | string
  | { kind: "big"; text: string; color?: Color; font?: BigFont }
  | { kind: "text"; text: string; color?: Color; dim?: boolean }
  | { kind: "spacer" }
  | { kind: "row"; children: ViewNode[]; opts: LayoutOpts }
  | { kind: "col"; children: ViewNode[]; opts: LayoutOpts }
  | { kind: "bar"; value: number; width?: number; color?: Color };

export type View = string | string[] | ViewNode[];

/**
 * Primitive node constructors. `row`/`col` are the layout containers (flexbox);
 * everything richer (progress, key/value, lists) is a plain function that
 * composes these — see sdk/components.ts. The host only understands primitives.
 */
export const big = (text: string, color?: Color, font?: BigFont): ViewNode => ({ kind: "big", text, color, font });
export const text = (t: string, opts: { color?: Color; dim?: boolean } = {}): ViewNode => ({ kind: "text", text: t, ...opts });
export const spacer = (): ViewNode => ({ kind: "spacer" });
/** Lay children out horizontally. */
export const row = (children: ViewNode[], opts: LayoutOpts = {}): ViewNode => ({ kind: "row", children, opts });
/** Stack children vertically. */
export const col = (children: ViewNode[], opts: LayoutOpts = {}): ViewNode => ({ kind: "col", children, opts });
/** A fill bar; value is 0..1. */
export const bar = (value: number, opts: { width?: number; color?: Color } = {}): ViewNode => ({
  kind: "bar",
  value: Math.max(0, Math.min(1, value)),
  ...opts,
});

/**
 * Navigation model. The host binds canonical intents to BOTH arrow keys and
 * vim keys, so movement is first-class and uniform across applets:
 *   up:    ↑ / k      down: ↓ / j
 *   select:→ / enter / l      back: ← / esc / backspace / h
 * `back` is browser-like: if `canBack(state)` is true the host fires the back
 * verb (pop an internal view, e.g. close an open email); otherwise it returns
 * to the launcher. Each field names a verb to fire.
 */
export interface Nav<S extends object = AppletState> {
  up?: string;
  down?: string;
  select?: string;
  selectLabel?: string;
  back?: string;
  backLabel?: string;
  canBack?: (state: S) => boolean;
}

export interface AppletDef<S extends object = AppletState> {
  /** Stable id, used in the CLI and HTTP routes: `kona <id>`, `/applets/<id>`. */
  id: string;
  /** Human title shown in the launcher. */
  title: string;
  /** One-line description for the "pick an app" launcher. */
  summary?: string;
  /** State the applet boots with. */
  initialState: S;
  /** If true, state is held in memory only — never persisted to disk (e.g. mail). */
  ephemeral?: boolean;
  /** Actions. Keyed by verb name. */
  verbs: Record<string, Verb<S>>;
  /** Pure render: current state -> what the host draws (lines or view nodes). */
  view: (state: S) => View;
  /** Optional frame tint (border/title color) derived from state. */
  accent?: (state: S) => Color;
  /** Navigation intents (arrows + vim + browser-like back). */
  nav?: Nav<S>;
  /** Breadcrumb for the current sub-view, shown in the title (e.g. open email). */
  crumb?: (state: S) => string | null;
  /** key -> verb for NON-navigation actions (e.g. { r: "refresh" }). */
  keymap?: Record<string, KeyBinding>;
  /** If set, the daemon calls tick every tickMs while the applet is "live". */
  tick?: (ctx: AppletCtx<S>) => void;
  tickMs?: number;
  /** Called once when the daemon boots — good for an initial data load. */
  init?: (ctx: AppletCtx<S>) => void;
}

/** Identity helper — gives you types and a stable shape. */
export function defineApplet<S extends object>(def: AppletDef<S>): AppletDef<S> {
  return def;
}

/** Type-erased applet, as the daemon/host/loader handle them generically. */
export type AnyApplet = AppletDef<AppletState>;

/** The tool manifest entry an agent reads to learn what it can call. */
export interface ToolSpec {
  name: string; // `${appletId}.${verb}`
  applet: string;
  verb: string;
}

export function toolsForApplet(def: AnyApplet): ToolSpec[] {
  return Object.keys(def.verbs).map((verb) => ({
    name: `${def.id}.${verb}`,
    applet: def.id,
    verb,
  }));
}
