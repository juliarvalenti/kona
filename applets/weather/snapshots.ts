import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * The week, one day's hours, and the two states you get before a location.
 *
 * Times are literal local ISO strings (that is what open-meteo returns and what
 * the applet slices), so these frames don't move with the wall clock — only
 * `syncedAt` does, and it is built per run.
 */
const DAY = "2026-09-01";

/** A clear morning warming into a showery afternoon, then a cool night. */
const HOURLY = Array.from({ length: 36 }, (_, i) => {
  const h = i % 24;
  const date = i < 24 ? DAY : "2026-09-02";
  const wet = h >= 15 && h <= 19;
  return {
    time: `${date}T${String(h).padStart(2, "0")}:00`,
    // One continuous curve across the two days: warmest mid-afternoon.
    temp: 62 + Math.round(14 * Math.sin(((i - 9) / 24) * 2 * Math.PI)),
    code: wet ? 61 : h < 10 ? 0 : 2,
    precipProb: wet ? 40 + (h - 15) * 8 : h < 10 ? 0 : 10,
    isDay: h >= 7 && h < 20,
  };
});

const DAILY = [
  [DAY, 2, 79, 58, 55],
  ["2026-09-02", 61, 74, 57, 70],
  ["2026-09-03", 3, 71, 55, 20],
  ["2026-09-04", 0, 76, 54, 5],
  ["2026-09-05", 80, 72, 56, 45],
  ["2026-09-06", 1, 75, 57, 10],
  ["2026-09-07", 95, 69, 58, 80],
] as const;

const forecast = () => ({
  place: "San Francisco, California",
  lat: 37.77,
  lon: -122.42,
  units: "imperial",
  tempUnit: "°F",
  windUnit: "mph",
  timezone: "America/Los_Angeles",
  syncedAt: Date.now() - 6 * 60_000,
  current: {
    time: `${DAY}T14:00`,
    temp: 74,
    feelsLike: 72,
    humidity: 61,
    precipitation: 0,
    code: 2,
    windSpeed: 11,
    windDir: 280,
    isDay: true,
  },
  hourly: HOURLY,
  daily: DAILY.map(([date, code, hi, lo, precipProb]) => ({
    date,
    code,
    hi,
    lo,
    precipProb,
    sunrise: `${date}T06:41`,
    sunset: `${date}T19:33`,
  })),
});

export default defineSnapshots([
  {
    name: "the week: now, the next hours, and a day per row",
    hero: true,
    state: forecast,
    width: 84,
    height: 24,
    tz: "America/Los_Angeles",
    contains: [
      "San Francisco",
      "Partly cloudy",
      "feels 72°F  ·  61% humidity",
      "NEXT", // the hourly strip's heading
      "rain", // the chance-of-rain band under it
      "daylight",
      "█", // the block-font hero temperature, and the daylight bar
    ],
  },
  {
    name: "opening a day lists its hours",
    state: () => ({ ...forecast(), mode: "day", dayIndex: 1 }),
    width: 80,
    height: 22,
    tz: "America/Los_Angeles",
    contains: ["high / low", "74°F / 57°F", "sun", "6:41a"],
  },
  {
    name: "with nowhere to look it says how to pick a place",
    width: 72,
    height: 14,
    contains: ["No location yet", "locate by IP"],
  },
]);
