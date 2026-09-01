/**
 * A clock from the future.
 *
 * The gallery is committed, so every instant that reaches a shot has to come
 * from `core/shots.ts`'s pinned epoch and nowhere else. These move the machine
 * out from under the render: `Date.now()` and `new Date()` answer weeks later,
 * in another month, at another time of day. Anything that reads the real clock
 * instead of the pin draws a different frame, and the shot goes stale.
 *
 * Preloaded, it skews a whole process — `bun --preload tests/fixtures/skew-clock.ts …`
 * with `KONA_CLOCK_SKEW_MS` set — which is the only way to catch a fixture
 * that stamps itself at IMPORT time, before any test can stub anything.
 */

/**
 * Far enough to change the month, the day of the week, the hour and the
 * minute — every bucket a relative stamp or a "was that today?" can land in.
 */
export const SKEW_MS = 71 * 86_400_000 + 13 * 3_600_000 + 7 * 60_000 + 23_000;

/** `real`, shifted by `ms`. Parsing and the other statics are untouched. */
export function skewedDate(real: DateConstructor, ms: number): DateConstructor {
  return class SkewedDate extends real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(real.now() + ms);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now(): number {
      return real.now() + ms;
    }
  } as DateConstructor;
}

const preload = Number(process.env.KONA_CLOCK_SKEW_MS ?? 0);
if (preload) globalThis.Date = skewedDate(globalThis.Date, preload);
