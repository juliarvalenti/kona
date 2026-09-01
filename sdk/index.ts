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

/** A key can fire a verb by name, or a verb with fixed args. */
export type KeyBinding = string | { verb: string; args: Record<string, unknown> };

export interface AppletDef<S extends AppletState = AppletState> {
  /** Stable id, used in the CLI and HTTP routes: `kona <id>`, `/applets/<id>`. */
  id: string;
  /** Human title shown in the launcher. */
  title: string;
  /** One-line description for the "pick an app" launcher. */
  summary?: string;
  /** State the applet boots with. */
  initialState: S;
  /** Actions. Keyed by verb name. */
  verbs: Record<string, Verb<S>>;
  /** Pure render: current state -> the lines the host draws. */
  view: (state: S) => string | string[];
  /** key -> verb. e.g. { space: "toggle", s: "stop" }. */
  keymap?: Record<string, KeyBinding>;
  /** If set, the daemon calls tick every tickMs while the applet is "live". */
  tick?: (ctx: AppletCtx<S>) => void;
  tickMs?: number;
}

/** Identity helper — gives you types and a stable shape. */
export function defineApplet<S extends AppletState>(def: AppletDef<S>): AppletDef<S> {
  return def;
}

/** The tool manifest entry an agent reads to learn what it can call. */
export interface ToolSpec {
  name: string; // `${appletId}.${verb}`
  applet: string;
  verb: string;
}

export function toolsForApplet(def: AppletDef): ToolSpec[] {
  return Object.keys(def.verbs).map((verb) => ({
    name: `${def.id}.${verb}`,
    applet: def.id,
    verb,
  }));
}
