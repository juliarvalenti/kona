import { defineApplet, big, text, spacer, col, row, type ViewNode, type Color } from "../../sdk/index.ts";
import { divider, keyValue, progress, recordRow } from "../../sdk/components.ts";
import {
  configuredLocation,
  describeCode,
  fetchForecast,
  geocode,
  iconForCode,
  isWet,
  locateByIp,
  placeLabel,
  windArrow,
  type Current,
  type Day,
  type Hour,
  type Place,
  type Units,
} from "../../server/weather.ts";

/**
 * weather — open-meteo, no key and no login, so this applet works the moment
 * you drop it in. It is the "ambient data" shape of a kona applet: the daemon
 * polls every ~15 minutes whether or not anyone is looking, YOU browse the week
 * with j/k and open a day, and an AGENT calls the same verbs — `weather.refresh`
 * before answering "do I need a jacket", `weather.setLocation` to move the view
 * to wherever it is talking about. Same state, same forecast.
 */

interface WeatherState {
  place: string;
  lat: number | null;
  lon: number | null;
  units: Units;
  current: Current | null;
  hourly: Hour[];
  daily: Day[];
  tempUnit: string;
  windUnit: string;
  timezone: string;
  /** forecast: the week; day: one day's hours; places: geocode results. */
  mode: "forecast" | "day" | "places";
  cursor: number; // day cursor on the forecast screen
  dayIndex: number; // which day the `day` screen is showing
  places: Place[];
  placeCursor: number;
  query: string;
  loading: boolean;
  error: string | null;
  syncedAt: number;
}

const SUN = "#f7c948";
const NIGHT = "#8f9bde";
const RAIN = "#5aa9e6";
const SNOW = "#dbe9f4";
const STORM = "#bb9af7";
const CLOUD = "#9aa5b1";
const FG = "#d0d0d0";
const DIM = "#6a6a6a";
const AMBER = "#f0b000";
const RED = "#ff5c57";

// Poll on the minute, but only actually refetch a quarter-hour-old forecast —
// open-meteo updates on that order and we are a guest on a free API.
const TICK_MS = 60_000;
const STALE_MS = 15 * 60_000;
// bun test / KONA_NO_NET: never let a background tick hit the network.
const OFFLINE = !!process.env.KONA_NO_NET || process.env.NODE_ENV === "test";

const SPARK = "▁▂▃▄▅▆▇█";

/**
 * A row of block glyphs whose heights track the values — the hourly
 * temperature curve in one line. `cell` widens each sample so hour labels can
 * be written underneath at the same offsets.
 */
export function sparkline(values: number[], cell = 1): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v) => {
      // A flat series sits mid-height rather than collapsing to the floor.
      const t = span === 0 ? 0.5 : (v - min) / span;
      return SPARK[Math.min(SPARK.length - 1, Math.round(t * (SPARK.length - 1)))]!.repeat(cell);
    })
    .join("");
}

/** Chance-of-rain shading under the temperature curve. */
function precipStrip(probs: number[], cell = 1): string {
  const shade = (p: number) => (p < 10 ? "·" : p < 30 ? "░" : p < 60 ? "▒" : p < 85 ? "▓" : "█");
  return probs.map((p) => shade(p).repeat(cell)).join("");
}

/** Write labels into a fixed-width line at the offsets their samples occupy. */
function labelStrip(labels: Array<string | null>, cell: number, width: number): string {
  const out = new Array(width).fill(" ");
  labels.forEach((label, i) => {
    if (!label) return;
    const at = i * cell;
    if (at + label.length > width) return;
    for (let k = 0; k < label.length; k++) out[at + k] = label[k]!;
  });
  return out.join("");
}

/** "2026-09-01T15:00" -> "3p" (compact enough to sit under a sparkline). */
function hourLabel(iso: string): string {
  const h = Number(iso.slice(11, 13));
  if (!Number.isFinite(h)) return "";
  const suffix = h < 12 ? "a" : "p";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${suffix}`;
}

/** "2026-09-01T05:32" -> "5:32a" */
function clockLabel(iso: string): string {
  const h = Number(iso.slice(11, 13));
  const m = iso.slice(14, 16);
  if (!Number.isFinite(h)) return "";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}${h < 12 ? "a" : "p"}`;
}

/** Minutes since local midnight, straight off the ISO string (already local). */
function minuteOfDay(iso: string): number {
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today" / "Tomorrow" / "Thu", relative to the first day in the series. */
function dayName(date: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  // Noon UTC so the weekday never slips a day on the local-date string.
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? date;
}

/** A lo—hi band drawn against the whole week's range, like a weather app. */
function rangeBar(lo: number, hi: number, min: number, max: number, width: number): string {
  const span = max - min || 1;
  const from = Math.round(((lo - min) / span) * (width - 1));
  const to = Math.round(((hi - min) / span) * (width - 1));
  return Array.from({ length: width }, (_, i) => (i >= from && i <= to ? "█" : "─")).join("");
}

const deg = (n: number, unit: string) => `${Math.round(n)}${unit.startsWith("°") ? unit : `°${unit}`}`;

/** Index of the first hourly sample at or after "now". */
function nowIndex(state: WeatherState): number {
  const t = state.current?.time ?? "";
  const i = state.hourly.findIndex((h) => h.time >= t);
  return i < 0 ? 0 : i;
}

function tintFor(code: number, isDay: boolean): Color {
  if (code >= 95) return STORM;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return SNOW;
  if (isWet(code)) return RAIN;
  if (!isDay) return NIGHT;
  if (code <= 1) return SUN;
  return CLOUD;
}

async function load(state: WeatherState, emit: () => void) {
  if (state.lat === null || state.lon === null || state.loading) return;
  state.loading = true;
  state.error = null;
  emit();
  try {
    const f = await fetchForecast(state.lat, state.lon, state.units);
    state.current = f.current;
    state.hourly = f.hourly;
    state.daily = f.daily;
    state.tempUnit = f.tempUnit;
    state.windUnit = f.windUnit;
    state.timezone = f.timezone;
    state.syncedAt = Date.now();
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
}

/** Point the applet at a coordinate and pull its forecast. */
async function moveTo(state: WeatherState, emit: () => void, lat: number, lon: number, label: string) {
  state.lat = lat;
  state.lon = lon;
  state.place = label;
  state.mode = "forecast";
  state.cursor = 0;
  state.places = [];
  emit();
  await load(state, emit);
}

/** IP-guess the location and load it. Shared by `locate`, `refresh` and init. */
async function locateHere(state: WeatherState, emit: () => void): Promise<string | null> {
  try {
    const p = await locateByIp();
    await moveTo(state, emit, p.lat, p.lon, placeLabel(p));
    return null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    emit();
    return state.error;
  }
}

function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export default defineApplet<WeatherState>({
  id: "weather",
  title: "Weather",
  summary: "Current conditions and the week ahead, from open-meteo.",
  labels: ["weather", "network"],
  initialState: {
    place: "",
    lat: null,
    lon: null,
    units: "imperial",
    current: null,
    hourly: [],
    daily: [],
    tempUnit: "°F",
    windUnit: "mph",
    timezone: "",
    mode: "forecast",
    cursor: 0,
    dayIndex: 0,
    places: [],
    placeCursor: 0,
    query: "",
    loading: false,
    error: null,
    syncedAt: 0,
  },

  docs: {
    refresh: "Refetch the current location. Call this before you read state.",
    setLocation: { doc: "Move the view — coordinates, or a place name in `q` that gets geocoded.", args: { q: "Lisbon" } },
    locate: "Guess the location from the IP address.",
    search: { doc: "Geocode a query and offer the matches to pick from.", args: { q: "Porto" } },
    units: { doc: "Switch units.", args: { fahrenheit: true } },
    open: { doc: "Open a day in the forecast, or adopt a search result.", args: { index: 0 } },
  },

  verbs: {
    /** Refetch the current location (the `r` key, and what an agent calls first). */
    async refresh(_args, { state, emit }) {
      // Cold start (agent called refresh before anything set a location).
      if (state.lat === null || state.lon === null) await locateHere(state, emit);
      else await load(state, emit);
      return {
        place: state.place,
        temp: state.current?.temp ?? null,
        unit: state.tempUnit,
        condition: state.current ? describeCode(state.current.code) : null,
        error: state.error,
      };
    },

    /**
     * Move the view. Either coordinates (`{lat, lon, name?}`) or a place name
     * (`{q: "Lisbon"}`), which is geocoded and resolved to the best match.
     */
    async setLocation(args, { state, emit }) {
      const lat = Number(args.lat ?? args.latitude);
      const lon = Number(args.lon ?? args.lng ?? args.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const name = typeof args.name === "string" ? args.name : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
        await moveTo(state, emit, lat, lon, name);
        return { place: state.place, lat, lon };
      }
      const q = String(args.q ?? args.query ?? args.name ?? args.place ?? "").trim();
      if (!q) return { error: "need {lat,lon} or {q}" };
      try {
        const hits = await geocode(q, 1);
        const hit = hits[0];
        if (!hit) {
          state.error = `no place matching "${q}"`;
          emit();
          return { error: state.error };
        }
        await moveTo(state, emit, hit.lat, hit.lon, placeLabel(hit));
        return { place: state.place, lat: hit.lat, lon: hit.lon };
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        emit();
        return { error: state.error };
      }
    },

    /** Guess the location from the IP address (the fallback on first run). */
    async locate(_args, { state, emit }) {
      const err = await locateHere(state, emit);
      return err ? { error: err } : { place: state.place };
    },

    /** `/` in the TUI: geocode a query and offer the matches to pick from. */
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "").trim();
      if (!state.query) return { error: "empty query" };
      state.mode = "places";
      state.loading = true;
      state.placeCursor = 0;
      emit();
      try {
        state.places = await geocode(state.query);
        state.error = state.places.length ? null : `no place matching "${state.query}"`;
      } catch (e) {
        state.places = [];
        state.error = e instanceof Error ? e.message : String(e);
      } finally {
        state.loading = false;
        emit();
      }
      return { query: state.query, matches: state.places.map(placeLabel) };
    },

    /** Toggle °F/°C (and mph/km-h with it), then refetch in the new units. */
    async units(args, { state, emit }) {
      const asked = String(args.units ?? "");
      state.units = asked === "metric" || asked === "imperial" ? asked : state.units === "metric" ? "imperial" : "metric";
      emit();
      await load(state, emit);
      return { units: state.units };
    },

    up(_args, { state, emit }) {
      if (state.mode === "places") state.placeCursor = Math.max(0, state.placeCursor - 1);
      else if (state.mode === "forecast") state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },

    down(_args, { state, emit }) {
      if (state.mode === "places") state.placeCursor = Math.min(Math.max(0, state.places.length - 1), state.placeCursor + 1);
      else if (state.mode === "forecast") state.cursor = Math.min(Math.max(0, state.daily.length - 1), state.cursor + 1);
      emit();
    },

    /** Open the selected day, or adopt the selected search result. */
    async open(args, { state, emit }) {
      if (state.mode === "places") {
        const p = state.places[typeof args.index === "number" ? args.index : state.placeCursor];
        if (!p) return { error: "no such place" };
        await moveTo(state, emit, p.lat, p.lon, placeLabel(p));
        return { place: state.place };
      }
      const i = typeof args.index === "number" ? args.index : state.cursor;
      if (!state.daily[i]) return { error: "no such day" };
      state.dayIndex = i;
      state.mode = "day";
      emit();
      return { date: state.daily[i]!.date };
    },

    back(_args, { state, emit }) {
      state.mode = "forecast";
      emit();
    },
  },

  init({ state, emit }) {
    if (OFFLINE) return;
    void (async () => {
      const cfg = await configuredLocation();
      if (cfg?.units) state.units = cfg.units;
      if (cfg && cfg.lat !== undefined && cfg.lon !== undefined) {
        await moveTo(state, emit, cfg.lat, cfg.lon, cfg.place ?? "Home");
        return;
      }
      // No pin, but a persisted location from last run — use it.
      if (state.lat !== null && state.lon !== null) return void load(state, emit);
      await locateHere(state, emit);
    })();
  },

  tickMs: TICK_MS,
  tick({ state, emit }) {
    if (OFFLINE || state.loading) return;
    if (Date.now() - state.syncedAt < STALE_MS) return;
    void load(state, emit);
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
    u: { verb: "units", label: "°F/°C" },
    l: { verb: "locate", label: "locate me" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "open day",
    back: "back",
    backLabel: "week",
    canBack: (s) => s.mode !== "forecast",
  },

  search: { verb: "search", placeholder: "city or place (e.g. Lisbon, Ithaca NY)" },

  crumb(s) {
    if (s.mode === "places") return `search "${s.query}"`;
    if (s.mode === "day") {
      const d = s.daily[s.dayIndex];
      return d ? dayName(d.date, s.dayIndex) : null;
    }
    return s.place || null;
  },

  accent(s) {
    if (s.error && !s.current) return AMBER;
    if (!s.current) return DIM;
    return tintFor(s.current.code, s.current.isDay);
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);

    // --- search results: pick a place
    if (state.mode === "places") {
      const rows: ViewNode[] = state.places.map((p, i) =>
        recordRow(
          [
            { text: p.name, grow: true },
            { text: [p.admin1, p.country].filter(Boolean).join(", "), width: Math.min(30, Math.floor(W * 0.35)) },
            { text: `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`, width: 16, align: "right" },
          ],
          { width: W, selected: i === state.placeCursor, accent: RAIN, color: FG },
        ),
      );
      if (!rows.length) {
        rows.push(text(state.loading ? "searching…" : (state.error ?? "no matches"), { color: state.loading ? AMBER : DIM }));
      }
      return [col([text(`matches for "${state.query}"`, { dim: true }), divider(W - 1), ...rows])];
    }

    // --- nothing yet (first boot, or the IP guess failed)
    if (!state.current) {
      return [
        col(
          [
            text(state.loading ? "fetching forecast…" : "No location yet", { color: state.loading ? AMBER : FG }),
            spacer(),
            text("Press l to locate by IP, or / to search for a city.", { dim: true }),
            ...(state.error ? [spacer(), text(state.error, { color: DIM })] : []),
          ],
          { align: "center", justify: "center", grow: true },
        ),
      ];
    }

    const cur = state.current;
    const tint = tintFor(cur.code, cur.isDay);
    const T = (n: number) => deg(n, state.tempUnit);

    // --- one day, hour by hour
    if (state.mode === "day") {
      const d = state.daily[state.dayIndex];
      if (!d) return [text("no such day", { color: RED })];
      const hours = state.hourly.filter((h) => h.time.startsWith(d.date));
      const rows: ViewNode[] = hours.map((h) =>
        recordRow(
          [
            { text: hourLabel(h.time), width: 5 },
            { text: iconForCode(h.code, h.isDay), width: 1 },
            { text: describeCode(h.code), grow: true },
            { text: h.precipProb > 0 ? `${h.precipProb}%` : "", width: 6, align: "right" },
            { text: T(h.temp), width: 7, align: "right" },
          ],
          { width: W, accent: tint, color: FG },
        ),
      );
      return [
        col([
          text(`${iconForCode(d.code)} ${describeCode(d.code)}`, { color: tint }),
          keyValue("high / low", `${T(d.hi)} / ${T(d.lo)}`, { color: FG }),
          keyValue("rain      ", `${d.precipProb}%`, { color: FG }),
          keyValue("sun       ", `${clockLabel(d.sunrise)} → ${clockLabel(d.sunset)}`, { color: FG }),
          divider(W - 1),
          ...(rows.length ? rows : [text("no hourly detail this far out", { dim: true })]),
        ]),
      ];
    }

    // --- the week (default screen)
    const head = row(
      [
        text(state.place || "—", { color: tint }),
        text(state.loading ? "syncing…" : `updated ${ago(state.syncedAt)}`, { dim: true }),
      ],
      { justify: "between", width: W },
    );

    const wind = `${windArrow(cur.windDir)} ${Math.round(cur.windSpeed)} ${state.windUnit}`;
    const hero = row(
      [
        big(String(Math.round(cur.temp)), tint, "block"),
        col([
          text(`${state.tempUnit}`, { dim: true }),
          spacer(),
          text(`${iconForCode(cur.code, cur.isDay)} ${describeCode(cur.code)}`, { color: tint }),
          text(`feels ${T(cur.feelsLike)}  ·  ${Math.round(cur.humidity)}% humidity  ·  ${wind}`, { dim: true }),
        ]),
      ],
      { align: "center", gap: 2 },
    );

    // Hourly strip: a temperature sparkline, hour labels beneath it at the same
    // offsets, and a shading band for the chance of rain.
    const strip: ViewNode[] = [];
    const start = nowIndex(state);
    // Widen each hour's cell to fill the terminal (and to leave room for the
    // labels underneath) rather than showing fewer hours.
    const want = Math.min(24, state.hourly.length - start);
    const cell = Math.max(1, Math.min(3, Math.floor((W - 4) / Math.max(1, want))));
    const count = Math.min(want, Math.floor((W - 4) / cell));
    const slice = state.hourly.slice(start, start + count);
    if (slice.length > 1) {
      const stripW = slice.length * cell;
      const every = cell >= 3 ? 2 : cell === 2 ? 3 : 6;
      const lo = Math.min(...slice.map((h) => h.temp));
      const hi = Math.max(...slice.map((h) => h.temp));
      strip.push(
        spacer(),
        // The sparkline has no axis, so the heading carries its range.
        text(`NEXT ${slice.length} HOURS   ${T(lo)} – ${T(hi)}`, { color: DIM }),
        text(sparkline(slice.map((h) => h.temp), cell), { color: tint }),
        text(labelStrip(slice.map((h, i) => (i % every === 0 ? hourLabel(h.time) : null)), cell, stripW), { dim: true }),
      );
      if (slice.some((h) => h.precipProb >= 10)) {
        strip.push(
          text(precipStrip(slice.map((h) => h.precipProb), cell), { color: RAIN }),
          text(`rain  ${Math.max(...slice.map((h) => h.precipProb))}% peak`, { dim: true }),
        );
      }
    }

    // Where we are between today's sunrise and sunset.
    const today = state.daily[0];
    const daylight: ViewNode[] = [];
    if (today?.sunrise && today?.sunset) {
      const rise = minuteOfDay(today.sunrise);
      const set = minuteOfDay(today.sunset);
      const now = minuteOfDay(cur.time);
      const frac = set > rise ? (now - rise) / (set - rise) : 0;
      daylight.push(
        spacer(),
        row(
          [
            text(cur.isDay ? "daylight" : "night    ", { dim: true }),
            text(clockLabel(today.sunrise), { dim: true }),
            progress(frac, { width: Math.min(32, W - 32), color: cur.isDay ? SUN : NIGHT }),
            text(clockLabel(today.sunset), { dim: true }),
          ],
          { align: "center", gap: 1 },
        ),
      );
    }

    const weekMin = Math.min(...state.daily.map((d) => d.lo));
    const weekMax = Math.max(...state.daily.map((d) => d.hi));
    // The lo—hi band is the first thing to go on a narrow terminal; the
    // condition text matters more than the picture of it.
    const barW = W >= 78 ? 14 : 10;
    const days: ViewNode[] = state.daily.map((d, i) =>
      recordRow(
        [
          { text: dayName(d.date, i), width: 8 },
          { text: iconForCode(d.code), width: 1 },
          { text: describeCode(d.code), grow: true },
          { text: d.precipProb > 0 ? `${d.precipProb}%` : "", width: 5, align: "right" },
          { text: T(d.lo), width: 6, align: "right" },
          ...(W >= 64 ? [{ text: rangeBar(d.lo, d.hi, weekMin, weekMax, barW), width: barW }] : []),
          { text: T(d.hi), width: 6, align: "right" },
        ],
        { width: W, selected: i === state.cursor, accent: tint, color: FG },
      ),
    );

    return [
      col([
        head,
        divider(W - 1),
        hero,
        ...strip,
        ...daylight,
        spacer(),
        divider(W - 1),
        ...days,
        ...(state.error ? [spacer(), text(state.error, { color: AMBER })] : []),
      ]),
    ];
  },
});
