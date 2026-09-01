import { test, expect, afterEach } from "bun:test";
import type { AppletCtx, ViewNode } from "../../sdk/index.ts";
import weather, { sparkline } from "./index.ts";
import { describeCode, iconForCode, isWet, parseForecast, placeLabel, windArrow } from "../../server/weather.ts";
import { renderApplet } from "../../sdk/testing.ts";

/**
 * The weather applet has two halves worth testing without a network: the pure
 * transform of open-meteo's column-oriented payload into rows, and the verb
 * reducer. The verbs DO fetch, so we stub `fetch` with a canned payload — which
 * also proves the applet never reaches past `server/weather.ts` for its data.
 */

const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"];
const HOURS = 48;
const hourTime = (i: number) => new Date(Date.UTC(2026, 8, 1, i)).toISOString().slice(0, 16);

/** A miniature but structurally faithful open-meteo forecast response. */
function forecastPayload() {
  return {
    timezone: "America/Los_Angeles",
    current_units: { temperature_2m: "°F", wind_speed_10m: "mp/h" },
    current: {
      time: "2026-09-01T14:30",
      temperature_2m: 71.4,
      apparent_temperature: 69.2,
      relative_humidity_2m: 61,
      is_day: 1,
      precipitation: 0,
      weather_code: 2,
      wind_speed_10m: 8.3,
      wind_direction_10m: 220,
    },
    hourly: {
      time: Array.from({ length: HOURS }, (_, i) => hourTime(i)),
      temperature_2m: Array.from({ length: HOURS }, (_, i) => 58 + 16 * Math.sin(((i - 6) / 24) * Math.PI * 2)),
      weather_code: Array.from({ length: HOURS }, (_, i) => (i % 24 < 8 ? 3 : i % 24 < 14 ? 2 : i % 24 < 18 ? 61 : 1)),
      precipitation_probability: Array.from({ length: HOURS }, (_, i) => (i % 24 < 12 ? 5 : Math.min(90, (i % 24) * 7))),
      is_day: Array.from({ length: HOURS }, (_, i) => (i % 24 >= 6 && i % 24 < 20 ? 1 : 0)),
    },
    daily: {
      time: DAYS,
      weather_code: [2, 61, 3, 0, 0, 80, 95],
      temperature_2m_max: [74, 68, 66, 79, 82, 71, 65],
      temperature_2m_min: [56, 54, 52, 58, 61, 55, 50],
      precipitation_probability_max: [10, 70, 30, 0, 0, 55, 80],
      sunrise: DAYS.map((d) => `${d}T06:31`),
      sunset: DAYS.map((d) => `${d}T19:48`),
    },
  };
}

const geocodePayload = {
  results: [
    { name: "Lisbon", latitude: 38.71667, longitude: -9.13333, country: "Portugal", admin1: "Lisbon", timezone: "Europe/Lisbon" },
    { name: "Lisbon", latitude: 40.77339, longitude: -80.7678, country: "United States", admin1: "Ohio", timezone: "America/New_York" },
  ],
};

/** A loaded-forecast state, as the daemon would hold it after a refresh. */
function loadedState() {
  const f = parseForecast(forecastPayload());
  return {
    ...structuredClone(weather.initialState),
    place: "Seattle, Washington",
    lat: 47.61,
    lon: -122.33,
    current: f.current,
    hourly: f.hourly,
    daily: f.daily,
    tempUnit: f.tempUnit,
    windUnit: f.windUnit,
    timezone: f.timezone,
    syncedAt: Date.now() - 120_000,
    cursor: 1,
  };
}

type WeatherState = typeof weather.initialState;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Drive the applet exactly like the daemon does, over a stubbed network. */
function harness(state: WeatherState = structuredClone(weather.initialState)) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("geocoding") ? geocodePayload : forecastPayload();
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  let emits = 0;
  const ctx: AppletCtx<WeatherState> = { state, emit: () => void emits++ };
  return {
    state,
    urls,
    emits: () => emits,
    call: (verb: string, args: Record<string, unknown> = {}) => weather.verbs[verb]!(args, ctx),
    tick: () => weather.tick!(ctx),
  };
}

// --- the pure layer -------------------------------------------------------

test("parseForecast turns open-meteo's columns into rows", () => {
  const f = parseForecast(forecastPayload());
  expect(f.current).toMatchObject({ temp: 71.4, feelsLike: 69.2, humidity: 61, code: 2, isDay: true });
  expect(f.hourly).toHaveLength(HOURS);
  expect(f.hourly[0]).toMatchObject({ time: "2026-09-01T00:00", precipProb: 5 });
  expect(f.daily).toHaveLength(7);
  expect(f.daily[1]).toMatchObject({ date: "2026-09-02", hi: 68, lo: 54, precipProb: 70, code: 61 });
  expect(f.timezone).toBe("America/Los_Angeles");
});

test("parseForecast normalizes the wind unit and survives an empty payload", () => {
  expect(parseForecast(forecastPayload()).windUnit).toBe("mph"); // open-meteo says "mp/h"
  const empty = parseForecast({});
  expect(empty.hourly).toEqual([]);
  expect(empty.daily).toEqual([]);
  expect(empty.current.temp).toBe(0);
});

test("WMO codes map to phrases, single-width icons, and wet/dry", () => {
  expect(describeCode(0)).toBe("Clear sky");
  expect(describeCode(65)).toBe("Heavy rain");
  expect(describeCode(4242)).toBe("Unknown");
  expect(iconForCode(0, true)).toBe("☀");
  expect(iconForCode(0, false)).toBe("☾"); // night
  // Column alignment depends on every icon being one cell wide.
  for (const code of [0, 1, 2, 3, 45, 51, 61, 71, 80, 95, 96]) {
    expect([...iconForCode(code)]).toHaveLength(1);
  }
  expect(isWet(61)).toBe(true);
  expect(isWet(3)).toBe(false);
});

test("windArrow points around the compass", () => {
  expect(windArrow(0)).toBe("↓");
  expect(windArrow(90)).toBe("←");
  expect(windArrow(180)).toBe("↑");
  expect(windArrow(270)).toBe("→");
  expect(windArrow(-90)).toBe("→"); // negatives wrap
});

test("sparkline maps the series onto block heights", () => {
  expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█");
  expect(sparkline([])).toBe("");
  expect(sparkline([5, 5, 5])).toBe("▅▅▅"); // flat sits mid-height, not on the floor
  expect(sparkline([1, 5], 3)).toBe("▁▁▁███"); // cell widens each sample
});

test("placeLabel prefers the region, falls back to the country", () => {
  expect(placeLabel({ name: "Lisbon", admin1: "Lisbon", country: "Portugal", lat: 0, lon: 0, timezone: "" })).toBe("Lisbon, Lisbon");
  expect(placeLabel({ name: "Lisbon", admin1: "", country: "Portugal", lat: 0, lon: 0, timezone: "" })).toBe("Lisbon, Portugal");
});

// --- verbs ----------------------------------------------------------------

test("setLocation with coordinates loads that forecast", async () => {
  const h = harness();
  await h.call("setLocation", { lat: 47.61, lon: -122.33, name: "Seattle" });
  expect(h.state.place).toBe("Seattle");
  expect(h.state.lat).toBe(47.61);
  expect(h.state.current?.temp).toBe(71.4);
  expect(h.state.daily).toHaveLength(7);
  expect(h.state.syncedAt).toBeGreaterThan(0);
  expect(h.urls[0]).toContain("latitude=47.61");
  expect(h.emits()).toBeGreaterThan(0);
});

test("setLocation with a name geocodes it first", async () => {
  const h = harness();
  const res = (await h.call("setLocation", { q: "Lisbon" })) as { place: string };
  expect(res.place).toBe("Lisbon, Lisbon");
  expect(h.urls[0]).toContain("geocoding-api");
  expect(h.urls[1]).toContain("latitude=38.71667");
  expect(h.state.mode).toBe("forecast");
});

test("refresh reports the reading an agent asked for", async () => {
  const h = harness(loadedState() as WeatherState);
  const res = (await h.call("refresh")) as { place: string; temp: number; condition: string };
  expect(res).toMatchObject({ place: "Seattle, Washington", temp: 71.4, condition: "Partly cloudy" });
  expect(h.state.error).toBeNull();
});

test("a failed fetch surfaces as an error, not a crash", async () => {
  const h = harness(loadedState() as WeatherState);
  globalThis.fetch = (async () => new Response(JSON.stringify({ reason: "Latitude must be in range" }), { status: 400 })) as unknown as typeof fetch;
  await h.call("refresh");
  expect(h.state.error).toBe("Latitude must be in range");
  expect(h.state.loading).toBe(false);
  expect(h.state.daily).toHaveLength(7); // the last good forecast stays on screen
});

test("units toggles °F/°C and refetches in the new unit", async () => {
  const h = harness(loadedState() as WeatherState);
  expect(h.state.units).toBe("imperial");
  await h.call("units");
  expect(h.state.units).toBe("metric");
  expect(h.urls[0]).not.toContain("temperature_unit=fahrenheit"); // metric is the API default
  await h.call("units", { units: "imperial" });
  expect(h.state.units).toBe("imperial");
  expect(h.urls[1]).toContain("temperature_unit=fahrenheit");
});

test("search lists matches; opening one adopts it as the location", async () => {
  const h = harness(loadedState() as WeatherState);
  const res = (await h.call("search", { q: "Lisbon" })) as { matches: string[] };
  expect(h.state.mode).toBe("places");
  expect(res.matches).toEqual(["Lisbon, Lisbon", "Lisbon, Ohio"]);
  h.call("down");
  expect(h.state.placeCursor).toBe(1);
  await h.call("open");
  expect(h.state.place).toBe("Lisbon, Ohio");
  expect(h.state.mode).toBe("forecast");
  expect(h.state.places).toEqual([]);
});

test("the day screen opens on the cursor and back returns to the week", async () => {
  const h = harness(loadedState() as WeatherState);
  h.call("up");
  expect(h.state.cursor).toBe(0);
  h.call("down");
  h.call("down");
  expect(h.state.cursor).toBe(2);
  const res = (await h.call("open")) as { date: string };
  expect(res.date).toBe("2026-09-03");
  expect(h.state.mode).toBe("day");
  expect(weather.nav!.canBack!(h.state)).toBe(true);
  h.call("back");
  expect(h.state.mode).toBe("forecast");
  expect(weather.nav!.canBack!(h.state)).toBe(false);
});

test("cursors clamp at both ends of the week", () => {
  const h = harness(loadedState() as WeatherState);
  for (let i = 0; i < 20; i++) h.call("down");
  expect(h.state.cursor).toBe(6); // 7 days
  for (let i = 0; i < 20; i++) h.call("up");
  expect(h.state.cursor).toBe(0);
});

test("the tick only refetches a stale forecast (and never during tests)", async () => {
  const h = harness(loadedState() as WeatherState);
  h.tick();
  await Bun.sleep(0);
  expect(h.urls).toHaveLength(0); // fresh — and offline under NODE_ENV=test
});

test("accent tracks the sky: sun, rain, storm, night", () => {
  const s = loadedState() as WeatherState;
  expect(weather.accent!(s)).toBe("#9aa5b1"); // partly cloudy
  s.current!.code = 0;
  expect(weather.accent!(s)).toBe("#f7c948"); // clear day
  s.current!.isDay = false;
  expect(weather.accent!(s)).toBe("#8f9bde"); // clear night
  s.current!.code = 61;
  expect(weather.accent!(s)).toBe("#5aa9e6"); // rain
  s.current!.code = 95;
  expect(weather.accent!(s)).toBe("#bb9af7"); // thunderstorm
});

// --- rendering ------------------------------------------------------------

// walk the view tree and collect every node
function flatten(nodes: ViewNode[]): Array<Exclude<ViewNode, string>> {
  const out: Array<Exclude<ViewNode, string>> = [];
  const visit = (n: ViewNode) => {
    if (typeof n === "string") return;
    out.push(n);
    if (n.kind === "row" || n.kind === "col") n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

test("the week view is a big hero temp, an hourly strip, and a row per day", () => {
  const all = flatten(weather.view(loadedState() as WeatherState, { width: 80, height: 30 }) as ViewNode[]);
  expect(all.find((n) => n.kind === "big")).toMatchObject({ kind: "big", text: "71" });
  expect(all.some((n) => n.kind === "bar")).toBe(true); // the daylight bar
  const strip = all.find((n) => n.kind === "text" && /[▁▂▃▄▅▆▇█]/.test(n.text) && n.text.length > 20);
  expect(strip).toBeDefined();
  const dayRows = all.filter((n) => n.kind === "text" && /Partly cloudy|Light rain|Thunderstorm/.test(n.text));
  expect(dayRows.length).toBeGreaterThanOrEqual(3);
});

test("snapshot: the week renders place, conditions, the strip and the daily rows", async () => {
  const frame = await renderApplet("weather", loadedState(), 84, 34);
  expect(frame).toContain("Seattle, Washington");
  expect(frame).toContain("Partly cloudy");
  expect(frame).toContain("61% humidity");
  expect(frame).toContain("NEXT 24 HOURS");
  expect(frame).toContain("Today");
  expect(frame).toContain("Tomorrow");
  expect(frame).toContain("74°F"); // today's high
  expect(frame).toContain("▁"); // the sparkline
  expect(frame).toContain("6:31a"); // sunrise on the daylight bar
});

test("snapshot: opening a day lists its hours", async () => {
  const frame = await renderApplet("weather", { ...loadedState(), mode: "day", dayIndex: 1 }, 84, 30);
  expect(frame).toContain("high / low");
  expect(frame).toContain("68°F / 54°F");
  expect(frame).toContain("12a");
  expect(frame).toContain("Light rain");
});

test("snapshot: with no location, the view says how to get one", async () => {
  const frame = await renderApplet("weather", {}, 70, 14);
  expect(frame).toContain("No location yet");
  expect(frame).toContain("locate by IP");
});

test("every row stays inside the frame at any width", async () => {
  for (const width of [50, 62, 84, 120]) {
    const frame = await renderApplet("weather", loadedState(), width, 34);
    for (const line of frame.split("\n")) expect([...line].length).toBeLessThanOrEqual(width);
  }
});
