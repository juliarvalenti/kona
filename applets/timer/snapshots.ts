import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * Rendering regressions for the timer, shipped with the timer. The runner
 * (tests/snapshot.test.ts) discovers this file; nothing central lists it.
 */
export default defineSnapshots([
  {
    name: "shows status, label, and a partly-filled bar",
    state: { timers: [{ id: "t1", label: "tea", remaining: 125, total: 300, running: true }], cursor: 0 },
    width: 62,
    height: 24,
    contains: [
      "running",
      "tea",
      "█", // bar has fill
      "░", // ...and empty remainder
    ],
  },
  {
    name: "shows the selection big and the rest as rows with mini bars",
    state: {
      timers: [
        { id: "t1", label: "tea", remaining: 125, total: 300, running: true },
        { id: "t2", label: "pasta", remaining: 540, total: 900, running: false },
        { id: "t3", label: "pomodoro", remaining: 0, total: 1500, running: false },
      ],
      cursor: 0,
    },
    width: 62,
    height: 26,
    contains: [
      "3 timers",
      "02:05", // the selected timer's row
      "09:00", // ...alongside the others
      "00:00",
      "▶", "⏸", "✓", // running / paused / done
    ],
  },
  {
    name: "in pomodoro mode leads with the phase, round and tally",
    state: {
      timers: [{ id: "t1", label: "tea", remaining: 125, total: 300, running: true }],
      cursor: 0,
      pomodoro: {
        active: true,
        phase: "short",
        round: 2,
        remaining: 180,
        total: 300,
        running: true,
        awaiting: false,
        completed: 3,
        day: "2026-01-01",
        plan: { work: 1500, short: 300, long: 900, every: 4, auto: true },
      },
    },
    width: 62,
    height: 30,
    contains: [
      "pomodoro",
      "short break",
      "round 2/4",
      "● ● ○ ○", // two rounds banked this cycle
      "3 done today",
      "tea", // the plain countdowns keep their roster
      "02:05",
    ],
  },
  {
    name: "with nothing running points at the presets",
    width: 62,
    height: 14,
    contains: ["no timers", "5m", "25m"],
  },
]);
