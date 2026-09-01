import { test, expect } from "bun:test";
import {
  CronScheduler,
  describeCron,
  matches,
  nextRun,
  parseCron,
  parseDuration,
  validateCron,
} from "../server/cron.ts";

/**
 * The daemon's clock. Everything here is local time on purpose: a person who
 * writes "30 8 * * 1-5" means half eight where they are, so the tests build
 * dates from local components too and stay TZ-independent.
 */

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test("durations parse the way the timer's do", () => {
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("5m")).toBe(300_000);
  expect(parseDuration("1h30m")).toBe(5_400_000);
  expect(parseDuration("90")).toBe(90_000); // a bare number is seconds
  expect(parseDuration("soon")).toBeNull();
});

test("a 5-field expression expands stars, steps, ranges and lists", () => {
  const spec = parseCron("*/15 9-17 * * mon,wed");
  expect(spec.kind).toBe("fields");
  if (spec.kind !== "fields") throw new Error("unreachable");
  expect([...spec.fields.minute]).toEqual([0, 15, 30, 45]);
  expect(spec.fields.hour.has(9)).toBe(true);
  expect(spec.fields.hour.has(18)).toBe(false);
  expect([...spec.fields.dow].sort()).toEqual([1, 3]);
});

test("bad expressions are rejected with a reason, not at fire time", () => {
  expect(validateCron("30 8 * * 1-5")).toBeNull();
  expect(validateCron("@daily")).toBeNull();
  expect(validateCron("@every 10m")).toBeNull();
  expect(validateCron("30 8 * *")).toContain("5 fields");
  expect(validateCron("99 * * * *")).toContain("outside");
  expect(validateCron("@every")).toContain("bad interval");
  expect(validateCron("@every 100ms")).toBeTruthy(); // sub-second is not a schedule
});

test("matches follows cron's dom/dow OR rule", () => {
  // Both day fields restricted: the 1st OR a Monday.
  const spec = parseCron("0 12 1 * mon");
  expect(matches(spec, new Date(at(2026, 6, 1, 12)))).toBe(true); // the 1st (a Monday too)
  expect(matches(spec, new Date(at(2026, 6, 8, 12)))).toBe(true); // a Monday
  expect(matches(spec, new Date(at(2026, 6, 9, 12)))).toBe(false); // neither
  // With one field a star, only the other one counts.
  expect(matches(parseCron("0 12 * * mon"), new Date(at(2026, 6, 9, 12)))).toBe(false);
});

test("nextRun lands on the next matching minute, skipping days that can't match", () => {
  // Friday 2026-01-02, 09:00 -> the weekday 08:30 job is Monday the 5th.
  expect(nextRun("30 8 * * 1-5", at(2026, 1, 2, 9, 0))).toBe(at(2026, 1, 5, 8, 30));
  // ...and from Monday 08:00 it is later the same morning.
  expect(nextRun("30 8 * * 1-5", at(2026, 1, 5, 8, 0))).toBe(at(2026, 1, 5, 8, 30));
  // Steps and shorthands.
  expect(nextRun("*/15 * * * *", at(2026, 1, 5, 8, 7))).toBe(at(2026, 1, 5, 8, 15));
  expect(nextRun("@daily", at(2026, 1, 5, 8, 7))).toBe(at(2026, 1, 6, 0, 0));
  // An interval is relative to now, not to a calendar.
  expect(nextRun("@every 30s", at(2026, 1, 5, 8, 7))).toBe(at(2026, 1, 5, 8, 7) + 30_000);
});

test("nextRun is strictly in the future — a job never re-fires on its own minute", () => {
  const noon = at(2026, 3, 4, 12, 0);
  expect(nextRun("0 12 * * *", noon)).toBe(at(2026, 3, 5, 12, 0));
});

test("describeCron says what an expression means, in the TUI's words", () => {
  expect(describeCron("30 8 * * *")).toBe("daily at 08:30");
  expect(describeCron("*/10 * * * *")).toBe("every 10m");
  expect(describeCron("@every 45s")).toBe("every 45s");
  expect(describeCron("0 9 * * 1-5")).toBe("weekdays at 09:00");
  expect(describeCron("0 9 * * 1")).toBe("mondays at 09:00");
  expect(describeCron("0 9 * * sat,sun")).toBe("weekends at 09:00");
  expect(describeCron("nonsense")).toBe("nonsense"); // never throws in a view
});

test("the scheduler starts a job's clock when it appears, and fires it when due", () => {
  const s = new CronScheduler();
  const t0 = at(2026, 1, 5, 8, 0);
  const jobs = [{ key: "workflows:morning:*/5 * * * *", cron: "*/5 * * * *" }];

  // First sight schedules; it does not fire. (Defining a job must not run it.)
  expect(s.due(jobs, t0)).toEqual([]);
  expect(s.nextAt(jobs[0]!.key)).toBe(at(2026, 1, 5, 8, 5));

  expect(s.due(jobs, at(2026, 1, 5, 8, 4))).toEqual([]);
  expect(s.due(jobs, at(2026, 1, 5, 8, 5))).toEqual([jobs[0]!.key]);
  // ...and it re-arms rather than firing every pass after that.
  expect(s.due(jobs, at(2026, 1, 5, 8, 5))).toEqual([]);
  expect(s.nextAt(jobs[0]!.key)).toBe(at(2026, 1, 5, 8, 10));
});

test("a job that disappears is forgotten; changing the expression reschedules it", () => {
  const s = new CronScheduler();
  const t0 = at(2026, 1, 5, 8, 0);
  const daily = [{ key: "workflows:a:0 9 * * *", cron: "0 9 * * *" }];
  s.due(daily, t0);
  expect(s.nextAt(daily[0]!.key)).toBe(at(2026, 1, 5, 9, 0));

  // The workflow was edited: the key carries the expression, so it re-arms.
  const edited = [{ key: "workflows:a:0 10 * * *", cron: "0 10 * * *" }];
  expect(s.due(edited, t0)).toEqual([]);
  expect(s.nextAt(daily[0]!.key)).toBeUndefined(); // the old schedule is gone
  expect(s.nextAt(edited[0]!.key)).toBe(at(2026, 1, 5, 10, 0));

  // Unscheduled entirely: nothing is left to fire.
  expect(s.due([], t0)).toEqual([]);
  expect(s.nextAt(edited[0]!.key)).toBeUndefined();
});

test("a bad expression parks the job instead of throwing every tick", () => {
  const s = new CronScheduler();
  const t0 = at(2026, 1, 5, 8, 0);
  const jobs = [{ key: "workflows:oops:nope", cron: "nope" }];
  expect(() => s.due(jobs, t0)).not.toThrow();
  expect(s.nextAt(jobs[0]!.key)).toBe(t0 + 3_600_000);
});
