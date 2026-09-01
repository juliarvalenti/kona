import { homedir } from "node:os";
import { join } from "node:path";

/**
 * open-meteo — forecasts with no account, no key, no OAuth. That makes weather
 * the cheapest possible proof that a kona applet can be *live*: the daemon
 * polls, the TUI and any agent read the same reading.
 *
 * Three endpoints, all keyless:
 *   api.open-meteo.com            the forecast itself
 *   geocoding-api.open-meteo.com  place name -> lat/lon
 *   ipapi.co / ipwho.is           "where am I" when nothing is configured
 *
 * Everything below the fetches is pure: `parseForecast` turns the API's
 * column-oriented payload into row objects, and the code/wind formatters are
 * plain functions — so the interesting parts are testable without a network.
 */

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const CONFIG_FILE = join(homedir(), ".config", "kona", "weather.json");
const TIMEOUT_MS = 8000;

export type Units = "metric" | "imperial";

export interface Place {
  name: string;
  admin1: string;
  country: string;
  lat: number;
  lon: number;
  timezone: string;
}

export interface Current {
  time: string; // local ISO, e.g. "2026-09-01T14:30"
  temp: number;
  feelsLike: number;
  humidity: number;
  precipitation: number;
  code: number;
  windSpeed: number;
  windDir: number;
  isDay: boolean;
}

export interface Hour {
  time: string; // local ISO, e.g. "2026-09-01T15:00"
  temp: number;
  code: number;
  precipProb: number;
  isDay: boolean;
}

export interface Day {
  date: string; // "2026-09-01"
  code: number;
  hi: number;
  lo: number;
  precipProb: number;
  sunrise: string;
  sunset: string;
}

export interface Forecast {
  current: Current;
  hourly: Hour[];
  daily: Day[];
  timezone: string;
  tempUnit: string; // "°F" / "°C"
  windUnit: string; // "mph" / "km/h"
}

/** WMO weather interpretation codes -> a short human phrase. */
const WMO: Array<[number[], string]> = [
  [[0], "Clear sky"],
  [[1], "Mainly clear"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55], "Drizzle"],
  [[56, 57], "Freezing drizzle"],
  [[61], "Light rain"],
  [[63], "Rain"],
  [[65], "Heavy rain"],
  [[66, 67], "Freezing rain"],
  [[71], "Light snow"],
  [[73], "Snow"],
  [[75], "Heavy snow"],
  [[77], "Snow grains"],
  [[80, 81], "Rain showers"],
  [[82], "Violent showers"],
  [[85, 86], "Snow showers"],
  [[95], "Thunderstorm"],
  [[96, 99], "Thunderstorm + hail"],
];

export function describeCode(code: number): string {
  for (const [codes, label] of WMO) if (codes.includes(code)) return label;
  return "Unknown";
}

/**
 * A single-width glyph per condition. Deliberately BMP symbols, not emoji:
 * emoji render double-width in most terminals and would break column
 * alignment in the daily rows.
 */
export function iconForCode(code: number, isDay = true): string {
  if (code === 0 || code === 1) return isDay ? "☀" : "☾";
  if (code === 2) return "◐";
  if (code === 3) return "☁";
  if (code === 45 || code === 48) return "≡";
  if (code >= 51 && code <= 57) return "⋮";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "☂";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "❄";
  // ⚡ is East-Asian-wide and would break column alignment; ↯ is single-width.
  if (code >= 95) return "↯";
  return "·";
}

/** True for codes that mean falling water/ice — drives the accent color. */
export function isWet(code: number): boolean {
  return code >= 51 && code <= 99;
}

/** Compass arrow pointing the way the wind is blowing TO. */
export function windArrow(degrees: number): string {
  const arrows = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"];
  const i = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return arrows[i]!;
}

interface ForecastPayload {
  timezone?: string;
  current_units?: Record<string, string>;
  current?: Record<string, number | string>;
  hourly?: Record<string, Array<number | string>>;
  daily?: Record<string, Array<number | string>>;
}

const nums = (a: Array<number | string> | undefined): number[] => (a ?? []).map(Number);
const strs = (a: Array<number | string> | undefined): string[] => (a ?? []).map(String);

/**
 * The API is column-oriented ({time:[...], temperature_2m:[...]}); the applet
 * wants rows. Pure — feed it a captured payload in a test.
 */
export function parseForecast(payload: ForecastPayload): Forecast {
  const c = payload.current ?? {};
  const h = payload.hourly ?? {};
  const d = payload.daily ?? {};

  const hTime = strs(h.time);
  const hTemp = nums(h.temperature_2m);
  const hCode = nums(h.weather_code);
  const hProb = nums(h.precipitation_probability);
  const hDay = nums(h.is_day);

  const dTime = strs(d.time);
  const dCode = nums(d.weather_code);
  const dHi = nums(d.temperature_2m_max);
  const dLo = nums(d.temperature_2m_min);
  const dProb = nums(d.precipitation_probability_max);
  const dRise = strs(d.sunrise);
  const dSet = strs(d.sunset);

  const rawWind = payload.current_units?.wind_speed_10m ?? "km/h";
  return {
    current: {
      time: String(c.time ?? ""),
      temp: Number(c.temperature_2m ?? 0),
      feelsLike: Number(c.apparent_temperature ?? c.temperature_2m ?? 0),
      humidity: Number(c.relative_humidity_2m ?? 0),
      precipitation: Number(c.precipitation ?? 0),
      code: Number(c.weather_code ?? 0),
      windSpeed: Number(c.wind_speed_10m ?? 0),
      windDir: Number(c.wind_direction_10m ?? 0),
      isDay: Number(c.is_day ?? 1) === 1,
    },
    hourly: hTime.map((time, i) => ({
      time,
      temp: Math.round(hTemp[i] ?? 0),
      code: hCode[i] ?? 0,
      precipProb: hProb[i] ?? 0,
      isDay: (hDay[i] ?? 1) === 1,
    })),
    daily: dTime.map((date, i) => ({
      date,
      code: dCode[i] ?? 0,
      hi: Math.round(dHi[i] ?? 0),
      lo: Math.round(dLo[i] ?? 0),
      precipProb: dProb[i] ?? 0,
      sunrise: dRise[i] ?? "",
      sunset: dSet[i] ?? "",
    })),
    timezone: payload.timezone ?? "",
    tempUnit: payload.current_units?.temperature_2m ?? "°",
    // open-meteo reports imperial wind as "mp/h"; say it the way people do.
    windUnit: rawWind === "mp/h" ? "mph" : rawWind,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as (T & { reason?: string }) | null;
  if (!res.ok) throw new Error(body?.reason ?? `${res.status} ${res.statusText}`);
  if (!body) throw new Error("bad response");
  return body;
}

/** Current conditions + hourly and daily series for a coordinate. */
export async function fetchForecast(lat: number, lon: number, units: Units = "metric"): Promise<Forecast> {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
    hourly: "temperature_2m,precipitation_probability,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    timezone: "auto",
    forecast_days: "7",
    ...(units === "imperial"
      ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch" }
      : {}),
  });
  return parseForecast(await getJson<ForecastPayload>(`${FORECAST_URL}?${q}`));
}

interface GeoPayload {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
    timezone?: string;
  }>;
}

/** Place name -> candidate coordinates (the search screen's rows). */
export async function geocode(query: string, count = 8): Promise<Place[]> {
  const q = new URLSearchParams({ name: query, count: String(count), language: "en", format: "json" });
  const body = await getJson<GeoPayload>(`${GEOCODE_URL}?${q}`);
  return (body.results ?? []).map((r) => ({
    name: r.name,
    admin1: r.admin1 ?? "",
    country: r.country ?? "",
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone ?? "",
  }));
}

/** "Seattle, Washington" — the one-line label for a place. */
export function placeLabel(p: Place): string {
  return [p.name, p.admin1 || p.country].filter(Boolean).join(", ");
}

interface IpPayload {
  city?: string;
  region?: string;
  country_name?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string | { id?: string };
  error?: boolean;
  success?: boolean;
}

/**
 * Where am I? Two keyless IP services, tried in order — the second covers the
 * first being rate-limited (both are free tiers).
 */
export async function locateByIp(): Promise<Place> {
  let lastError = "IP lookup failed";
  for (const url of ["https://ipapi.co/json/", "https://ipwho.is/"]) {
    try {
      const b = await getJson<IpPayload>(url);
      if (b.error || b.success === false) throw new Error("lookup refused");
      if (typeof b.latitude !== "number" || typeof b.longitude !== "number") throw new Error("no coordinates");
      const tz = typeof b.timezone === "string" ? b.timezone : (b.timezone?.id ?? "");
      return {
        name: b.city ?? "Here",
        admin1: b.region ?? "",
        country: b.country_name ?? b.country ?? "",
        lat: b.latitude,
        lon: b.longitude,
        timezone: tz,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastError);
}

export interface WeatherConfig {
  lat?: number;
  lon?: number;
  place?: string;
  units?: Units;
}

/**
 * A pinned location, so the applet can skip the IP guess entirely:
 *   env  KONA_WEATHER_LAT / KONA_WEATHER_LON / KONA_WEATHER_PLACE / KONA_WEATHER_UNITS
 *   file ~/.config/kona/weather.json  {"lat":47.6,"lon":-122.33,"place":"Seattle","units":"imperial"}
 */
export async function configuredLocation(): Promise<WeatherConfig | null> {
  let cfg: WeatherConfig = {};
  try {
    cfg = JSON.parse(await Bun.file(CONFIG_FILE).text()) as WeatherConfig;
  } catch {
    cfg = {};
  }
  const lat = process.env.KONA_WEATHER_LAT ? Number(process.env.KONA_WEATHER_LAT) : cfg.lat;
  const lon = process.env.KONA_WEATHER_LON ? Number(process.env.KONA_WEATHER_LON) : cfg.lon;
  const place = process.env.KONA_WEATHER_PLACE ?? cfg.place;
  const envUnits = process.env.KONA_WEATHER_UNITS;
  const units = envUnits === "metric" || envUnits === "imperial" ? envUnits : cfg.units;
  const has = Number.isFinite(lat) && Number.isFinite(lon);
  if (!has && !units) return null;
  return {
    ...(has ? { lat: Number(lat), lon: Number(lon), place: place ?? "Home" } : {}),
    ...(units ? { units } : {}),
  };
}
