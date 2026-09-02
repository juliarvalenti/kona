import { PRIORITIES, type Priority } from "../sdk/index.ts";
import { securityConfig, type SecurityConfig, type SecurityHold } from "./config.ts";
import { trustAgents, type Caller } from "./trust.ts";

/**
 * The policy: given a verb's priority and who is asking, does this run now or
 * wait for a human?
 *
 * Pure and tiny on purpose. The daemon owns the parking, the applet owns the
 * list, the config owns the preferences — this file owns the one decision, so
 * there is exactly one place to read (or test) when you want to know why your
 * agent's `email.send` came back `pending`.
 *
 *   trusted caller                        -> run   (a human pressed a key)
 *   `[security] allow` names the verb     -> run
 *   `[security] guard` names the verb     -> hold
 *   hold = "none"                         -> run
 *   hold = "all-writes", priority >= medium -> hold
 *   default, priority high|critical       -> hold
 *   otherwise                             -> run
 */

/** What to do with a call. `hold` means park it and ask. */
export type Decision = "run" | "hold";

/** A verb identified the way the config file names it: `<applet>.<verb>`. */
export interface VerbRef {
  applet: string;
  verb: string;
  priority: Priority;
}

export const verbName = (ref: Pick<VerbRef, "applet" | "verb">): string => `${ref.applet}.${ref.verb}`;

/**
 * Does a `[security]` entry name this verb? Three spellings, so the file reads
 * the way people think: the exact `spotify.playPause`, the whole applet as
 * `spotify.*` or just `spotify`, and `*` for everything.
 */
export function matches(pattern: string, ref: Pick<VerbRef, "applet" | "verb">): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === "*") return true;
  const full = verbName(ref);
  if (p === full) return true;
  return p === ref.applet || p === `${ref.applet}.*`;
}

const listed = (patterns: string[], ref: VerbRef): boolean => patterns.some((p) => matches(p, ref));

/** Rank of a priority on the ordinal scale — higher means more oversight. */
const rank = (p: Priority): number => PRIORITIES.indexOf(p);

/** Which priorities `hold` reaches, before the per-verb lists have their say. */
function heldByLevel(hold: SecurityHold, priority: Priority): boolean {
  if (hold === "none") return false;
  // "all-writes" holds anything past a pure read/local (priority >= medium);
  // the default holds only the verbs that act as you or destroy (>= high).
  const floor = hold === "all-writes" ? "medium" : "high";
  return rank(priority) >= rank(floor);
}

/**
 * The whole decision. `policy` defaults to the live config, so callers that
 * don't care about injecting one (the daemon) just pass the verb and caller.
 */
export function decide(ref: VerbRef, caller: Caller, policy: SecurityConfig = securityConfig()): Decision {
  if (caller.trusted || trustAgents()) return "run";
  // An explicit list beats the level rule in both directions — that is what
  // makes `allow = ["spotify.playPause"]` under `hold = "all-writes"` mean
  // something, and `guard = ["notes.clear"]` under the default too.
  if (listed(policy.allow, ref)) return "run";
  if (listed(policy.guard, ref)) return "hold";
  return heldByLevel(policy.hold, ref.priority) ? "hold" : "run";
}

/** `decide`, as the boolean the manifest wants: would an agent be held here? */
export function wouldHold(ref: VerbRef, policy: SecurityConfig = securityConfig()): boolean {
  return decide(ref, { trusted: false, by: "agent" }, policy) === "hold";
}

/**
 * Why a verb is held, in one human phrase — the line the pending list and the
 * daemon's 202 both show, so "why is this waiting?" never needs the source.
 */
export function reason(ref: VerbRef, policy: SecurityConfig = securityConfig()): string {
  if (listed(policy.guard, ref)) return `[security] guard names ${verbName(ref)}`;
  if (policy.hold === "all-writes") return `hold = "all-writes" (this verb is ${ref.priority}-priority)`;
  return `${ref.priority}-priority verbs need a human`;
}
