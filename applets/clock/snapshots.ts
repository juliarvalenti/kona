import { defineSnapshots } from "../../sdk/testing.ts";

/** Day-delta chips are relative to the machine's own day — hence `tz`. */
export default defineSnapshots([
  {
    name: "renders a hero time plus a row per zone",
    state: { now: Date.parse("2026-09-01T16:00:45Z"), cursor: 4 },
    width: 72,
    height: 26,
    tz: "UTC",
    contains: [
      "San Francisco", "UTC-7", "Tokyo", "UTC+9",
      "+1d", // Tokyo is already tomorrow
      "Wed 2 Sep", // hero date line
      "█", // the block-font hero + seconds bar
    ],
  },
  {
    name: "picker lists matching cities to add",
    state: { now: Date.parse("2026-09-01T16:00:45Z"), picker: true, query: "india" },
    width: 72,
    height: 20,
    tz: "UTC",
    contains: ["add a city", "Bengaluru", "Mumbai", "UTC+5:30"],
    excludes: ["Berlin"], // filtered out
  },
]);
