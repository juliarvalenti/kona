import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The tray renders from a MIRROR of the daemon's queue, which is what makes
 * these fixtures possible at all: no agent, no daemon, no clock — just the
 * rows a human would be looking at.
 */
const NOW = Date.parse("2026-09-01T16:00:00Z");
const min = (n: number) => NOW + n * 60_000;

export default defineSnapshots([
  {
    name: "a queued send shows its exact arguments and what is holding it",
    hero: true,
    width: 72,
    height: 24,
    state: {
      now: NOW,
      tab: "pending",
      cursor: 0,
      pending: [
        {
          id: "p3",
          applet: "email",
          verb: "send",
          args: { to: "ada@example.com", subject: "ship it", body: "rc1 is up — merging at noon." },
          priority: "high",
          requestedAt: min(-2),
          requestedBy: "claude",
          reason: "high-priority verbs need a human",
          expiresAt: min(8),
        },
        {
          id: "p4",
          applet: "mycelium",
          verb: "post",
          args: { room: "ship-kona", text: "picking up #83" },
          priority: "high",
          requestedAt: min(-1),
          requestedBy: "claude",
          reason: "high-priority verbs need a human",
          expiresAt: min(9),
        },
      ],
      log: [],
    },
    contains: [
      "pending",
      "2 waiting",
      "email.send",
      "mycelium.post",
      "what it would do",
      "to: ada@example.com",
      "body: rc1 is up — merging at noon.",
      "high-priority verbs need a human",
      "8m",
    ],
  },
  {
    name: "an empty queue says what would land in it",
    width: 72,
    height: 16,
    state: { now: NOW, pending: [], log: [] },
    contains: ["Nothing waiting on you.", "high and critical"],
  },
  {
    name: "the activity tab is the receipt for what agents already did",
    width: 72,
    height: 18,
    state: {
      now: NOW,
      tab: "activity",
      cursor: 0,
      pending: [],
      log: [
        { id: "p3", applet: "email", verb: "send", args: {}, priority: "high", at: min(-3), by: "claude", outcome: "ran", decidedAt: min(-2) },
        { id: "p2", applet: "email", verb: "trash", args: { id: "m9" }, priority: "critical", at: min(-6), by: "claude", outcome: "denied", decidedAt: min(-5), error: "denied" },
        { id: "a1", applet: "timer", verb: "start", args: { seconds: 300 }, priority: "low", at: min(-9), by: "claude", outcome: "ran", allowed: true },
      ],
    },
    contains: ["activity", "✓ email.send", "✕ email.trash", "timer.start", "claude"],
  },
]);
