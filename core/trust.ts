import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Who is calling.
 *
 * kona's thesis is that a keypress and an agent's POST fire the SAME verb over
 * the same state, and the applet cannot tell them apart. That is still true —
 * but the daemon has to, because the two callers differ in exactly one way that
 * matters: a keypress is **self-confirming** (a human was there, and pressed
 * it) and an HTTP call is not. Everything in core/guard.ts hangs off that one
 * bit.
 *
 * The signal is a loopback token: a random string in the state dir, mode 0600,
 * that the daemon writes on boot and the host (and the human's own
 * `kona approvals`) sends back in a header. It is NOT a secret from the
 * machine's user — anything running as you can read the file, and could already
 * write to `applets/` and be loaded as an applet. It is a marker that says
 * "this call came from the surface a human is typing into", so an agent has to
 * *choose* to impersonate a human rather than doing it by accident, which is
 * the failure this guards against.
 *
 * `KONA_TRUST_AGENTS=1` trusts everyone — the old behaviour, kept as a
 * documented escape hatch rather than a thing you rediscover.
 */

/** The header the host sends. */
export const TRUST_HEADER = "x-kona-trust";
/** Optional: who is calling, for the audit trail ("claude", "cron", a script). */
export const CALLER_HEADER = "x-kona-caller";

/** Same default as the daemon's state dir; KONA_STATE_DIR moves both. */
const stateDir = () => process.env.KONA_STATE_DIR ?? join(homedir(), ".local", "state", "kona");

export const tokenPath = (): string => join(stateDir(), "trust.token");

/**
 * The machine's trust token, created on first use. Written 0600 into the state
 * dir alongside `state.json`, so it moves with KONA_STATE_DIR and a test never
 * touches the real one.
 *
 * Memoized per path: the host asks for this on EVERY keypress, and a syscall
 * per keystroke is not a thing to add to a terminal's input loop. Keying the
 * memo on the path (rather than a bare flag) keeps a test that moves
 * KONA_STATE_DIR honest.
 */
let memo: { path: string; token: string } | null = null;

export function trustToken(): string {
  const path = tokenPath();
  if (memo?.path === path) return memo.token;
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      memo = { path, token: existing };
      return existing;
    }
  } catch {
    /* absent — write one below */
  }
  const token = randomBytes(24).toString("hex");
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  } catch {
    // An unwritable state dir means the host and the daemon each mint their own
    // token and never agree — so the TUI would be treated as an agent and every
    // guarded keypress would queue for an approval nobody can grant. Say so
    // rather than letting it look like a policy decision.
    console.error(`kona: could not write ${path} — the TUI cannot prove it is you, so guarded verbs will queue.`);
  }
  memo = { path, token };
  return token;
}

/** Test seam: forget the memoized token (after moving KONA_STATE_DIR). */
export function __resetTrust(): void {
  memo = null;
}

/** Is every caller trusted on this machine? The full-yolo escape hatch. */
export function trustAgents(): boolean {
  return process.env.KONA_TRUST_AGENTS === "1";
}

/**
 * A caller, as the daemon and the audit trail know it. `trusted` decides
 * whether a guarded verb runs; `by` is only ever a label.
 */
export interface Caller {
  trusted: boolean;
  /** "human" (the TUI), "daemon" (a tick or a cron pass), else the agent's name. */
  by: string;
}

/** The internal caller: the daemon's own ticks, cron passes and init. */
export const DAEMON: Caller = { trusted: true, by: "daemon" };

/** Headers that mark a call as coming from the human's own surface. */
export function trustHeaders(): Record<string, string> {
  return { [TRUST_HEADER]: trustToken(), [CALLER_HEADER]: "human" };
}

/**
 * Classify an incoming request. Trusted when it carries this machine's token
 * (or when the escape hatch is on); the caller label is whatever it says it is,
 * which is fine — the label is for the log, the token is the decision.
 */
export function callerOf(req: { headers: { get(name: string): string | null } }, token: string): Caller {
  const sent = req.headers.get(TRUST_HEADER);
  const named = req.headers.get(CALLER_HEADER)?.trim().slice(0, 40);
  const trusted = trustAgents() || (!!sent && sent === token);
  return { trusted, by: named || (trusted ? "human" : "agent") };
}
