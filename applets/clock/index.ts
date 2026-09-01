import { defineApplet, big, text, spacer, col, type ViewNode, type Color } from "../../sdk/index.ts";
import { divider, progress, recordRow } from "../../sdk/components.ts";

/**
 * clock — a world clock. Pure and offline: every reading comes from the one
 * `now` the daemon's tick stamps into state, run through `Intl` per zone.
 *
 * Bimodal as usual: YOU browse the zones with ↑↓, press `a` to add one, `d` to
 * drop it; an AGENT calls `clock.add({city:"Tokyo"})` or just `clock.list()` to
 * read every zone's current time without touching the view. Same state.
 */

interface Zone {
  tz: string; // IANA id, e.g. "Asia/Tokyo"
  label: string; // display name, e.g. "Tokyo"
}

interface ClockState {
  zones: Zone[];
  cursor: number; // index into zones
  now: number; // epoch ms, restamped by tick — keeps view() pure
  hour12: boolean;
  picker: boolean; // the add-a-city catalog is open
  query: string; // catalog filter
  pick: number; // index into the filtered catalog
}

const NIGHT = "#7aa2f7";
const MORNING = "#f0b000";
const DAY = "#00d488";
const EVENING = "#bb9af7";
const FG = "#d0d0d0";
const DIM = "#6a6a6a";

/** A small, hand-picked catalog — enough to build a real board from keys alone. */
interface City {
  label: string;
  tz: string;
  where: string;
}
const CATALOG: City[] = [
  { label: "Honolulu", tz: "Pacific/Honolulu", where: "USA" },
  { label: "Anchorage", tz: "America/Anchorage", where: "USA" },
  { label: "San Francisco", tz: "America/Los_Angeles", where: "USA" },
  { label: "Seattle", tz: "America/Los_Angeles", where: "USA" },
  { label: "Denver", tz: "America/Denver", where: "USA" },
  { label: "Mexico City", tz: "America/Mexico_City", where: "Mexico" },
  { label: "Chicago", tz: "America/Chicago", where: "USA" },
  { label: "New York", tz: "America/New_York", where: "USA" },
  { label: "Toronto", tz: "America/Toronto", where: "Canada" },
  { label: "Bogotá", tz: "America/Bogota", where: "Colombia" },
  { label: "São Paulo", tz: "America/Sao_Paulo", where: "Brazil" },
  { label: "Buenos Aires", tz: "America/Argentina/Buenos_Aires", where: "Argentina" },
  { label: "Reykjavík", tz: "Atlantic/Reykjavik", where: "Iceland" },
  { label: "UTC", tz: "UTC", where: "—" },
  { label: "London", tz: "Europe/London", where: "UK" },
  { label: "Dublin", tz: "Europe/Dublin", where: "Ireland" },
  { label: "Lisbon", tz: "Europe/Lisbon", where: "Portugal" },
  { label: "Madrid", tz: "Europe/Madrid", where: "Spain" },
  { label: "Paris", tz: "Europe/Paris", where: "France" },
  { label: "Amsterdam", tz: "Europe/Amsterdam", where: "Netherlands" },
  { label: "Berlin", tz: "Europe/Berlin", where: "Germany" },
  { label: "Zürich", tz: "Europe/Zurich", where: "Switzerland" },
  { label: "Stockholm", tz: "Europe/Stockholm", where: "Sweden" },
  { label: "Warsaw", tz: "Europe/Warsaw", where: "Poland" },
  { label: "Athens", tz: "Europe/Athens", where: "Greece" },
  { label: "Istanbul", tz: "Europe/Istanbul", where: "Türkiye" },
  { label: "Cairo", tz: "Africa/Cairo", where: "Egypt" },
  { label: "Lagos", tz: "Africa/Lagos", where: "Nigeria" },
  { label: "Nairobi", tz: "Africa/Nairobi", where: "Kenya" },
  { label: "Johannesburg", tz: "Africa/Johannesburg", where: "South Africa" },
  { label: "Moscow", tz: "Europe/Moscow", where: "Russia" },
  { label: "Dubai", tz: "Asia/Dubai", where: "UAE" },
  { label: "Karachi", tz: "Asia/Karachi", where: "Pakistan" },
  { label: "Bengaluru", tz: "Asia/Kolkata", where: "India" },
  { label: "Mumbai", tz: "Asia/Kolkata", where: "India" },
  { label: "Kathmandu", tz: "Asia/Kathmandu", where: "Nepal" },
  { label: "Dhaka", tz: "Asia/Dhaka", where: "Bangladesh" },
  { label: "Bangkok", tz: "Asia/Bangkok", where: "Thailand" },
  { label: "Jakarta", tz: "Asia/Jakarta", where: "Indonesia" },
  { label: "Singapore", tz: "Asia/Singapore", where: "Singapore" },
  { label: "Hong Kong", tz: "Asia/Hong_Kong", where: "China" },
  { label: "Shanghai", tz: "Asia/Shanghai", where: "China" },
  { label: "Taipei", tz: "Asia/Taipei", where: "Taiwan" },
  { label: "Seoul", tz: "Asia/Seoul", where: "South Korea" },
  { label: "Tokyo", tz: "Asia/Tokyo", where: "Japan" },
  { label: "Sydney", tz: "Australia/Sydney", where: "Australia" },
  { label: "Melbourne", tz: "Australia/Melbourne", where: "Australia" },
  { label: "Auckland", tz: "Pacific/Auckland", where: "New Zealand" },
];

/** Is this a timezone the runtime actually knows? */
function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Asia/Hong_Kong" -> "Hong Kong" — a decent label for an off-catalog zone. */
function labelFor(tz: string): string {
  const known = CATALOG.find((c) => c.tz.toLowerCase() === tz.toLowerCase());
  if (known) return known.label;
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

/**
 * Resolve whatever a human or an agent typed into a zone: a catalog city
 * ("tokyo"), a raw IANA id ("Asia/Tokyo"), or a prefix/substring of either.
 */
function resolveZone(input: string): Zone | null {
  const q = input.trim();
  if (!q) return null;
  const lc = q.toLowerCase();
  const exact = CATALOG.find((c) => c.label.toLowerCase() === lc || c.tz.toLowerCase() === lc);
  if (exact) return { tz: exact.tz, label: exact.label };
  if (q.includes("/") && validTz(q)) return { tz: q, label: labelFor(q) };
  const partial = CATALOG.find((c) => c.label.toLowerCase().startsWith(lc)) ?? CATALOG.find((c) => matches(c, lc));
  if (partial) return { tz: partial.tz, label: partial.label };
  return validTz(q) ? { tz: q, label: labelFor(q) } : null;
}

function matches(c: City, lc: string): boolean {
  return (
    c.label.toLowerCase().includes(lc) ||
    c.where.toLowerCase().includes(lc) ||
    c.tz.toLowerCase().replace(/_/g, " ").includes(lc)
  );
}

/** The catalog rows the picker shows for the current query. */
function catalogFor(query: string): City[] {
  const lc = query.trim().toLowerCase();
  if (!lc) return CATALOG;
  return CATALOG.filter((c) => matches(c, lc));
}

/** Everything the view (and an agent) wants to know about one zone right now. */
interface Reading {
  tz: string;
  label: string;
  time: string; // "08:04" or "8:04 AM"
  seconds: number; // 0..59
  hour: number; // 0..23, for day/night tinting
  date: string; // "Tue 1 Sep"
  offset: string; // "UTC+9", "UTC-7:30", "UTC"
  offsetMinutes: number;
  dayDelta: number; // -1 / 0 / +1 vs. the machine's own day
}

function partsOf(tz: string, at: number): Record<string, string> {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
}

/** Minutes east of UTC, derived by reading the wall clock in that zone. */
function offsetMinutes(tz: string, at: number): number {
  const p = partsOf(tz, at);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60000);
}

function fmtOffset(mins: number): string {
  if (mins === 0) return "UTC";
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Read one zone at `at`. Pure — same inputs, same output, no ambient clock. */
function read(zone: Zone, at: number, hour12: boolean): Reading {
  const p = partsOf(zone.tz, at);
  const h24 = +p.hour! % 24;
  const minute = +p.minute!;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const time = hour12
    ? `${h12}:${String(minute).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`
    : `${String(h24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const utcNoon = Date.UTC(+p.year!, +p.month! - 1, +p.day!);
  const localNoon = new Date(at);
  const hereDay = Date.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate());
  return {
    tz: zone.tz,
    label: zone.label,
    time,
    seconds: +p.second!,
    hour: h24,
    date: `${DAYS[new Date(utcNoon).getUTCDay()]} ${+p.day!} ${MONTHS[+p.month! - 1]}`,
    offset: fmtOffset(offsetMinutes(zone.tz, at)),
    offsetMinutes: offsetMinutes(zone.tz, at),
    dayDelta: Math.round((utcNoon - hereDay) / 86_400_000),
  };
}

/** Border/hero color from the local hour: night, morning, day, evening. */
function tint(hour: number): Color {
  if (hour < 6) return NIGHT;
  if (hour < 11) return MORNING;
  if (hour < 18) return DAY;
  if (hour < 22) return EVENING;
  return NIGHT;
}

/** "+1d" / "-1d" when that city isn't on the same date you are. */
function dayChip(delta: number): string {
  if (delta === 0) return "";
  return delta > 0 ? `+${delta}d` : `${delta}d`;
}

const SEED = ["San Francisco", "New York", "London", "Berlin", "Tokyo"].map((c) => {
  const z = resolveZone(c)!;
  return { tz: z.tz, label: z.label };
});

function clampCursor(state: ClockState) {
  state.cursor = Math.min(Math.max(0, state.zones.length - 1), Math.max(0, state.cursor));
}

export default defineApplet<ClockState>({
  id: "clock",
  title: "World Clock",
  summary: "Every city you care about, at a glance. Add zones by hand or by agent.",
  initialState: {
    zones: SEED,
    cursor: 0,
    now: 0,
    hour12: false,
    picker: false,
    query: "",
    pick: 0,
  },

  verbs: {
    /**
     * Read the board without changing it — the verb an agent wants when the
     * question is just "what time is it in Kathmandu?". `tz` reads any zone,
     * on the board or not.
     */
    list(args, { state }) {
      const at = state.now || Date.now();
      const one = typeof args.tz === "string" ? args.tz : typeof args.city === "string" ? args.city : "";
      if (one) {
        const z = resolveZone(one);
        if (!z) return { error: `unknown zone: ${one}` };
        return { zones: [read(z, at, state.hour12)] };
      }
      return { zones: state.zones.map((z) => read(z, at, state.hour12)) };
    },

    add(args, { state, emit }) {
      const input = String(args.city ?? args.tz ?? args.zone ?? args.q ?? "");
      const zone = resolveZone(input);
      if (!zone) return { error: `unknown zone: ${input}` };
      if (typeof args.label === "string" && args.label) zone.label = args.label;
      const existing = state.zones.findIndex((z) => z.tz === zone.tz && z.label === zone.label);
      state.cursor = existing >= 0 ? existing : state.zones.push(zone) - 1;
      state.picker = false;
      state.query = "";
      state.pick = 0;
      emit();
      return { added: existing >= 0 ? null : zone, zones: state.zones.length };
    },

    remove(args, { state, emit }) {
      const byName = typeof args.city === "string" ? args.city : typeof args.tz === "string" ? args.tz : "";
      const idx = byName
        ? state.zones.findIndex(
            (z) => z.label.toLowerCase() === byName.toLowerCase() || z.tz.toLowerCase() === byName.toLowerCase(),
          )
        : typeof args.index === "number"
          ? args.index
          : state.cursor;
      const gone = state.zones[idx];
      if (!gone) return { error: "no such zone" };
      state.zones.splice(idx, 1);
      clampCursor(state);
      emit();
      return { removed: gone, zones: state.zones.length };
    },

    /** Order the board west -> east, the way a wall of clocks is hung. */
    sort(_args, { state, emit }) {
      const at = state.now || Date.now();
      const selected = state.zones[state.cursor];
      state.zones.sort(
        (a, b) => offsetMinutes(a.tz, at) - offsetMinutes(b.tz, at) || a.label.localeCompare(b.label),
      );
      if (selected) state.cursor = Math.max(0, state.zones.indexOf(selected));
      emit();
      return { zones: state.zones.map((z) => z.label) };
    },

    /** 24-hour by default; `format({hour12:true})` or the `t` key flips it. */
    format(args, { state, emit }) {
      state.hour12 = typeof args.hour12 === "boolean" ? args.hour12 : !state.hour12;
      emit();
      return { hour12: state.hour12 };
    },

    /** Open the catalog picker (also how `a` and `→` behave on the board). */
    pick(args, { state, emit }) {
      state.picker = true;
      state.query = typeof args.q === "string" ? args.q : "";
      state.pick = 0;
      emit();
      return { matches: catalogFor(state.query).length };
    },

    /** `/` — filter the catalog. Opens the picker if it isn't already open. */
    find(args, { state, emit }) {
      state.query = String(args.q ?? "");
      state.picker = true;
      state.pick = 0;
      emit();
      return { query: state.query, matches: catalogFor(state.query).length };
    },

    close(_args, { state, emit }) {
      state.picker = false;
      state.query = "";
      state.pick = 0;
      emit();
    },

    /** → / enter: add the highlighted city, or open the picker from the board. */
    choose(_args, { state, emit }) {
      if (!state.picker) {
        state.picker = true;
        state.query = "";
        state.pick = 0;
        emit();
        return { picker: true };
      }
      const city = catalogFor(state.query)[state.pick];
      if (!city) return { error: "nothing to add" };
      const existing = state.zones.findIndex((z) => z.tz === city.tz && z.label === city.label);
      state.cursor = existing >= 0 ? existing : state.zones.push({ tz: city.tz, label: city.label }) - 1;
      state.picker = false;
      state.query = "";
      state.pick = 0;
      emit();
      return { added: existing >= 0 ? null : city.label, zones: state.zones.length };
    },

    up(_args, { state, emit }) {
      if (state.picker) state.pick = Math.max(0, state.pick - 1);
      else state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },

    down(_args, { state, emit }) {
      if (state.picker) state.pick = Math.min(Math.max(0, catalogFor(state.query).length - 1), state.pick + 1);
      else state.cursor = Math.min(Math.max(0, state.zones.length - 1), state.cursor + 1);
      emit();
    },
  },

  // One `now` for the whole board: the tick stamps it, every zone is derived
  // from it, so all the clocks agree and view() stays pure.
  init({ state, emit }) {
    state.now = Date.now();
    clampCursor(state);
    emit();
  },

  tickMs: 1000,
  tick({ state, emit }) {
    state.now = Date.now();
    emit();
  },

  keymap: {
    a: { verb: "pick", label: "add city" },
    d: { verb: "remove", label: "remove" },
    t: { verb: "format", label: "12/24h" },
    s: { verb: "sort", label: "sort by offset" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "choose",
    selectLabel: "add",
    back: "close",
    backLabel: "board",
    canBack: (s) => s.picker,
  },

  search: { verb: "find", placeholder: "city or zone (e.g. tokyo, asia/, brazil)" },

  crumb: (s) => (s.picker ? "add a city" : null),

  accent(state) {
    const z = state.zones[state.cursor];
    if (!z) return DIM;
    return tint(read(z, state.now || Date.now(), state.hour12).hour);
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const at = state.now || Date.now();

    // --- picker: the catalog, filtered by `/`
    if (state.picker) {
      const hits = catalogFor(state.query);
      const nodes: ViewNode[] = [
        text(state.query ? `add a city  ·  "${state.query}"  ·  ${hits.length} match${hits.length === 1 ? "" : "es"}` : "add a city", { color: FG }),
        divider(W - 1),
      ];
      if (!hits.length) {
        nodes.push(text("nothing matches — press / to search again, ← to go back", { dim: true }));
        return [col(nodes)];
      }
      hits.forEach((c, i) => {
        const r = read({ tz: c.tz, label: c.label }, at, state.hour12);
        const on = state.zones.some((z) => z.tz === c.tz && z.label === c.label);
        nodes.push(
          recordRow(
            [
              { text: `${on ? "✓" : " "} ${c.label}`, grow: true },
              { text: c.where, width: Math.min(16, Math.floor(W * 0.2)) },
              { text: r.time, width: 8, align: "right" },
              { text: r.offset, width: 9, align: "right" },
            ],
            { width: W, selected: state.pick === i, accent: tint(r.hour), color: on ? DIM : FG },
          ),
        );
      });
      return [col(nodes)];
    }

    // --- board: hero for the selected zone, one record row per zone
    if (!state.zones.length) {
      return [
        col(
          [
            text("no zones", { color: DIM }),
            spacer(),
            text("press `a` to add a city, or ask an agent:", { dim: true }),
            text("kona call clock add '{\"city\":\"Tokyo\"}'", { color: FG }),
          ],
          { align: "center", justify: "center", grow: true },
        ),
      ];
    }

    const hero = read(state.zones[Math.min(state.cursor, state.zones.length - 1)]!, at, state.hour12);
    const color = tint(hero.hour);
    const chip = dayChip(hero.dayDelta);
    const nodes: ViewNode[] = [
      col(
        [
          big(hero.time, color, "block"),
          progress(hero.seconds / 60, { color, width: Math.min(28, W - 4) }),
          spacer(),
          text(
            `${hero.label}  ·  ${hero.date}${chip ? ` (${chip})` : ""}  ·  ${hero.offset}`,
            { color },
          ),
        ],
        { align: "center" },
      ),
      spacer(),
      divider(W - 1),
    ];

    state.zones.forEach((z, i) => {
      const r = read(z, at, state.hour12);
      nodes.push(
        recordRow(
          [
            { text: r.label, grow: true },
            { text: r.date.slice(0, 3), width: 4 },
            { text: r.time, width: 8, align: "right" },
            { text: dayChip(r.dayDelta), width: 4, align: "right" },
            { text: r.offset, width: 9, align: "right" },
          ],
          { width: W, selected: i === state.cursor, accent: tint(r.hour), color: FG },
        ),
      );
    });

    return [col(nodes)];
  },
});
