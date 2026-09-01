import { test, expect } from "bun:test";
import { defineApplet, priorityFor, defaultPriority, toolsForApplet, type AnyApplet } from "../sdk/index.ts";
import { decide, matches, wouldHold, reason } from "../core/guard.ts";
import { resolveConfig, DEFAULT_SECURITY, type SecurityConfig } from "../core/config.ts";
import { callerOf, TRUST_HEADER, CALLER_HEADER } from "../core/trust.ts";

/**
 * The decision, on its own: how much oversight a verb needs, who is asking, and
 * what the config says about the two together. Everything downstream — the
 * daemon's park, the tray, the manifest's `guarded` flag — is this function plus
 * plumbing, so this is where the policy is actually pinned.
 */

const HUMAN = { trusted: true, by: "human" };
const AGENT = { trusted: false, by: "claude" };

const policy = (over: Partial<SecurityConfig> = {}): SecurityConfig => ({ ...DEFAULT_SECURITY, ...over });

const sample = defineApplet({
  id: "sample",
  title: "Sample",
  initialState: {},
  priority: { blast: "critical", shout: "high", nudge: "medium", scribble: "low" },
  verbs: {
    blast: () => null,
    shout: () => null,
    nudge: () => null,
    scribble: () => null,
    refresh: () => null,
    up: () => null,
  },
  nav: { up: "up" },
  view: () => [],
}) as unknown as AnyApplet;

test("a verb's priority is what the applet declared", () => {
  expect(priorityFor(sample, "blast")).toBe("critical");
  expect(priorityFor(sample, "shout")).toBe("high");
  expect(priorityFor(sample, "nudge")).toBe("medium");
  expect(priorityFor(sample, "scribble")).toBe("low");
});

test("...and, unspoken, what its name suggests", () => {
  expect(defaultPriority("refresh")).toBe("low");
  expect(defaultPriority("send")).toBe("high");
  expect(defaultPriority("trash")).toBe("critical");
  expect(defaultPriority("playPause")).toBe("medium");
  // Nothing recognisable is `low`: the level that needs no permission and
  // claims none either.
  expect(defaultPriority("wobble")).toBe("low");
  // A cursor key is never a decision, whatever it is called.
  expect(priorityFor(sample, "up")).toBe("low");
});

test("a trusted caller runs anything — the keypress IS the confirmation", () => {
  for (const verb of ["blast", "shout", "nudge", "scribble"]) {
    expect(decide({ applet: "sample", verb, priority: priorityFor(sample, verb) }, HUMAN, policy())).toBe("run");
  }
});

test("an agent's high and critical verbs are held by default; medium and low run", () => {
  expect(decide({ applet: "sample", verb: "shout", priority: "high" }, AGENT, policy())).toBe("hold");
  expect(decide({ applet: "sample", verb: "blast", priority: "critical" }, AGENT, policy())).toBe("hold");
  // ...and the reversible/harmless ones are not, or the platform stops being useful.
  expect(decide({ applet: "sample", verb: "nudge", priority: "medium" }, AGENT, policy())).toBe("run");
  expect(decide({ applet: "sample", verb: "scribble", priority: "low" }, AGENT, policy())).toBe("run");
  expect(decide({ applet: "sample", verb: "refresh", priority: "low" }, AGENT, policy())).toBe("run");
});

test("reversible remote playback runs free while acting-as-you is held", () => {
  // The whole point of the priority scale: low-stakes remote control
  // (Spotify playback, now `medium`) is NOT lumped with `email.send` (`high`).
  expect(decide({ applet: "spotify", verb: "playPause", priority: "medium" }, AGENT, policy())).toBe("run");
  expect(decide({ applet: "email", verb: "send", priority: "high" }, AGENT, policy())).toBe("hold");
});

test("hold moves the line wholesale", () => {
  // "all-writes" holds anything at medium or above — playback included now.
  const tight = policy({ hold: "all-writes" });
  expect(decide({ applet: "sample", verb: "nudge", priority: "medium" }, AGENT, tight)).toBe("hold");
  expect(decide({ applet: "sample", verb: "scribble", priority: "low" }, AGENT, tight)).toBe("run");
  expect(decide({ applet: "sample", verb: "refresh", priority: "low" }, AGENT, tight)).toBe("run");

  const open = policy({ hold: "none" });
  expect(decide({ applet: "sample", verb: "blast", priority: "critical" }, AGENT, open)).toBe("run");
});

test("allow and guard beat the level rule, in both directions", () => {
  // The issue's own examples: one verb back out of the tray...
  const loosened = policy({ hold: "all-writes", allow: ["spotify.playPause"] });
  expect(decide({ applet: "spotify", verb: "playPause", priority: "medium" }, AGENT, loosened)).toBe("run");
  expect(decide({ applet: "spotify", verb: "transfer", priority: "medium" }, AGENT, loosened)).toBe("hold");

  // ...and one harmless-looking verb into it.
  const tightened = policy({ guard: ["notes.clear"] });
  expect(decide({ applet: "notes", verb: "clear", priority: "low" }, AGENT, tightened)).toBe("hold");
  expect(reason({ applet: "notes", verb: "clear", priority: "low" }, tightened)).toContain("[security] guard");
});

test("a pattern names one verb, one applet, or everything", () => {
  const ref = { applet: "spotify", verb: "playPause" };
  expect(matches("spotify.playPause", ref)).toBe(true);
  expect(matches("spotify.*", ref)).toBe(true);
  expect(matches("spotify", ref)).toBe(true);
  expect(matches("*", ref)).toBe(true);
  expect(matches("spotify.next", ref)).toBe(false);
  expect(matches("notes", ref)).toBe(false);
});

test("[security] parses, and a malformed key is a complaint rather than a crash", () => {
  const good = resolveConfig(
    { security: { hold: "all-writes", allow: ["spotify.playPause"], guard: "notes.clear", expire: "2m" } },
    { path: "/x", exists: true },
  );
  expect(good.errors).toEqual([]);
  expect(good.security).toMatchObject({
    hold: "all-writes",
    allow: ["spotify.playPause"],
    guard: ["notes.clear"], // a bare string is the one-entry list people type
    expireMs: 120_000,
  });

  const bad = resolveConfig({ security: { hold: "sometimes", expire: "soon" } }, { path: "/x", exists: true });
  expect(bad.errors.join(" ")).toContain("security.hold");
  expect(bad.errors.join(" ")).toContain("security.expire");
  // ...and the defaults still stand, so a typo can never silently unguard.
  expect(bad.security).toMatchObject({ hold: "default", expireMs: DEFAULT_SECURITY.expireMs });
});

test("the manifest tells an agent which verbs will be held before it fires one", () => {
  const tools = toolsForApplet(sample, (ref) => wouldHold(ref, policy()));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(byName["sample.shout"]).toMatchObject({ priority: "high", guarded: true });
  expect(byName["sample.blast"]).toMatchObject({ priority: "critical", guarded: true });
  expect(byName["sample.nudge"]).toMatchObject({ priority: "medium" });
  expect(byName["sample.nudge"]!.guarded).toBeUndefined();
  expect(byName["sample.scribble"]!.guarded).toBeUndefined();
  expect(byName["sample.refresh"]).toMatchObject({ priority: "low" });
});

test("the token, not the claim, decides who is trusted", () => {
  const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
  expect(callerOf(req({ [TRUST_HEADER]: "secret" }), "secret")).toEqual({ trusted: true, by: "human" });
  // Saying you are the human is not being the human.
  expect(callerOf(req({ [CALLER_HEADER]: "human" }), "secret")).toEqual({ trusted: false, by: "human" });
  expect(callerOf(req({ [TRUST_HEADER]: "guessed" }), "secret").trusted).toBe(false);
  expect(callerOf(req({}), "secret")).toEqual({ trusted: false, by: "agent" });
  // The label rides along for the log, whatever it says.
  expect(callerOf(req({ [CALLER_HEADER]: "claude" }), "secret").by).toBe("claude");
});
