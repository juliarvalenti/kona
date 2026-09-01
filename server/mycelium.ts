import { homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";

/**
 * Mycelium — the multi-agent coordination layer — read into kona.
 *
 * There is no single blessed transport, so this module is an ADAPTER: it tries
 * every place mycelium is known to live, in order, and uses the first that
 * answers.
 *
 *   1. HTTP    the local daemon / OpenAPI backend  (MYCELIUM_URL, else :8765)
 *   2. CLI     `mycelium ... --json`               (KONA_MYCELIUM_BIN, else PATH
 *                                                   or ~/.local/bin/mycelium)
 *   3. files   ~/.mycelium/rooms/                  (KONA_MYCELIUM_HOME)
 *
 * Each backend spells its fields slightly differently (`agents` vs `members`,
 * `ts` vs `created_at`), so nothing here trusts a shape: every payload goes
 * through the tolerant `normalize*` functions below, which are pure and unit
 * tested. Everything is READ-ONLY — kona observes coordination, it doesn't
 * join the swarm.
 */

export type Source = "http" | "cli" | "fs" | "none";

export interface Room {
  id: string;
  name: string;
  topic: string;
  agents: string[];
  messages: number;
  lastAt: number; // epoch ms, 0 = unknown
}

export interface Message {
  id: string;
  from: string;
  at: number;
  text: string;
}

export interface Agent {
  name: string;
  status: string;
  lastSeen: number;
}

/** One entry of a room's shared memory / knowledge store. */
export interface Memo {
  key: string;
  value: string;
  at: number;
}

export interface RoomDetail {
  room: Room;
  messages: Message[];
  agents: Agent[];
  memory: Memo[];
  source: Source;
}

const DEFAULT_URL = "http://127.0.0.1:8765";
const HTTP_TIMEOUT_MS = 2000;

const envUrl = () => process.env.KONA_MYCELIUM_URL ?? process.env.MYCELIUM_URL ?? null;
const fsRoot = () => process.env.KONA_MYCELIUM_HOME ?? join(homedir(), ".mycelium");

// ---------------------------------------------------------------- normalizing

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** First present key, in preference order. */
function pick(raw: Rec, keys: string[]): unknown {
  for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
  return undefined;
}

function str(raw: Rec, keys: string[]): string {
  const v = pick(raw, keys);
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function count(raw: Rec, keys: string[]): number | null {
  const v = pick(raw, keys);
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

/**
 * Pull the list out of a response: a bare array, or the array under the first
 * matching envelope key (`{rooms: [...]}`, `{data: [...]}`, …).
 */
export function pickList(json: unknown): Rec[] {
  if (Array.isArray(json)) return json.filter(isRec);
  if (isRec(json)) {
    for (const k of ["rooms", "messages", "agents", "memory", "items", "data", "results", "entries"]) {
      const v = json[k];
      if (Array.isArray(v)) return v.filter(isRec);
    }
  }
  return [];
}

/** Epoch ms from ms, seconds, or an ISO/RFC date string. 0 when unreadable. */
export function toMs(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? (v > 1e11 ? v : Math.round(v * 1000)) : 0;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return toMs(n);
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Compact relative age: "12s", "5m", "3h", "2d". Empty for unknown times. */
export function ago(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Message bodies arrive as a string, a content-block array, or {text}. */
export function flattenText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flattenText).filter(Boolean).join(" ");
  if (isRec(v)) return flattenText(pick(v, ["text", "content", "body", "value"]));
  return "";
}

/** Names out of an agent list: ["a"] or [{name}] / [{id}] / [{agent}]. */
export function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : isRec(x) ? str(x, ["name", "id", "agent", "handle"]) : ""))
    .filter(Boolean);
}

export function normalizeRoom(raw: Rec): Room | null {
  const id = str(raw, ["id", "room_id", "roomId", "slug", "room", "name"]);
  if (!id) return null;
  const agents = names(pick(raw, ["agents", "members", "participants", "peers"]));
  return {
    id,
    name: str(raw, ["name", "title", "room", "slug"]) || id,
    topic: str(raw, ["topic", "description", "summary", "purpose"]),
    agents,
    messages: count(raw, ["messages", "message_count", "messageCount", "count", "n_messages"]) ?? 0,
    lastAt: toMs(
      pick(raw, ["last_at", "lastAt", "last_message_at", "lastMessageAt", "updated_at", "updatedAt", "ts", "timestamp", "mtime"]),
    ),
  };
}

export function normalizeMessage(raw: Rec, i = 0): Message {
  const text = flattenText(pick(raw, ["text", "content", "body", "message", "msg"]));
  return {
    id: str(raw, ["id", "message_id", "messageId", "uuid"]) || `m${i}`,
    from: str(raw, ["from", "agent", "author", "sender", "role", "who", "name"]) || "?",
    at: toMs(pick(raw, ["at", "ts", "timestamp", "time", "created_at", "createdAt", "sent_at"])),
    text: text.replace(/\s+/g, " ").trim(),
  };
}

export function normalizeAgent(raw: Rec): Agent | null {
  const name = str(raw, ["name", "id", "agent", "handle"]);
  if (!name) return null;
  return {
    name,
    status: str(raw, ["status", "state", "activity", "role"]),
    lastSeen: toMs(pick(raw, ["last_seen", "lastSeen", "seen_at", "updated_at", "ts", "at"])),
  };
}

/** Shared memory is either a list of records or a plain `{key: value}` map. */
export function normalizeMemory(json: unknown): Memo[] {
  const list = pickList(json);
  if (list.length) {
    return list
      .map((raw) => ({
        key: str(raw, ["key", "name", "title", "id"]),
        value: flattenText(pick(raw, ["value", "content", "text", "body", "data"])).replace(/\s+/g, " ").trim(),
        at: toMs(pick(raw, ["at", "ts", "updated_at", "updatedAt", "created_at"])),
      }))
      .filter((m) => m.key || m.value);
  }
  if (isRec(json)) {
    const inner = isRec(json.memory) ? json.memory : isRec(json.knowledge) ? json.knowledge : json;
    return Object.entries(inner)
      .filter(([, v]) => typeof v !== "object" || v === null || !Array.isArray(v))
      .map(([key, v]) => ({ key, value: flattenText(v) || String(v ?? ""), at: 0 }));
  }
  return [];
}

/** Rooms the payload described, newest activity first. */
export function normalizeRooms(json: unknown): Room[] {
  const rooms = pickList(json)
    .map(normalizeRoom)
    .filter((r): r is Room => r !== null);
  rooms.sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name));
  return rooms;
}

export function normalizeMessages(json: unknown): Message[] {
  const msgs = pickList(json).map(normalizeMessage);
  msgs.sort((a, b) => a.at - b.at); // oldest first; the view tails the end
  return msgs;
}

/** Parse a JSONL log (one message per line); bad lines are skipped. */
export function parseJsonl(textBody: string): Rec[] {
  const out: Rec[] = [];
  for (const line of textBody.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (isRec(v)) out.push(v);
    } catch {}
  }
  return out;
}

// -------------------------------------------------------------------- sources

interface Backend {
  kind: Source;
  rooms: () => Promise<Room[]>;
  detail: (id: string, limit: number) => Promise<Omit<RoomDetail, "source">>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- HTTP (local daemon / OpenAPI backend)

async function getJson(base: string, paths: string[]): Promise<unknown> {
  let last = "";
  for (const p of paths) {
    try {
      const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (res.ok) return await res.json();
      last = `${res.status} ${p}`;
    } catch (e) {
      last = msg(e);
    }
  }
  throw new Error(last || "no response");
}

function httpBackend(base: string): Backend {
  const room = (id: string, tail: string) =>
    [`/rooms/${id}${tail}`, `/api/rooms/${id}${tail}`, `/v1/rooms/${id}${tail}`];
  return {
    kind: "http",
    async rooms() {
      return normalizeRooms(await getJson(base, ["/rooms", "/api/rooms", "/v1/rooms"]));
    },
    async detail(id, limit) {
      const body = await getJson(base, room(id, ""));
      const meta = isRec(body) ? (isRec(body.room) ? body.room : body) : {};
      const messages = normalizeMessages(
        isRec(body) && Array.isArray(body.messages) ? body.messages : await getJson(base, room(id, "/messages")).catch(() => []),
      ).slice(-limit);
      const agentsRaw =
        isRec(body) && (Array.isArray(body.agents) || Array.isArray(body.members))
          ? body
          : await getJson(base, room(id, "/agents")).catch(() => []);
      const memoryRaw =
        isRec(body) && body.memory !== undefined ? body.memory : await getJson(base, room(id, "/memory")).catch(() => []);
      return {
        room: normalizeRoom({ id, ...meta }) ?? emptyRoom(id),
        messages,
        agents: pickList(agentsRaw)
          .map(normalizeAgent)
          .filter((a): a is Agent => a !== null),
        memory: normalizeMemory(memoryRaw),
      };
    },
  };
}

// --- CLI (`mycelium ... --json`)

/** The subcommand spelling is version-dependent, so try a few and cache the winner. */
const cliWinner = new Map<string, string[]>();

function runCli(bin: string, forms: string[][], slot: string): unknown {
  const won = cliWinner.get(slot);
  const tries = won ? [won, ...forms.filter((f) => f !== won)] : forms;
  let last = "";
  for (const argv of tries) {
    const r = Bun.spawnSync([bin, ...argv], { stderr: "pipe", stdout: "pipe" });
    if (r.exitCode === 0) {
      const out = r.stdout.toString().trim();
      if (!out) return [];
      try {
        const json = JSON.parse(out);
        cliWinner.set(slot, argv);
        return json;
      } catch {
        const lines = parseJsonl(out); // some subcommands stream JSONL
        if (lines.length) {
          cliWinner.set(slot, argv);
          return lines;
        }
        last = `${argv[0]}: unparseable output`;
        continue;
      }
    }
    last = r.stderr.toString().trim().split("\n")[0] ?? `${argv.join(" ")} failed`;
  }
  throw new Error(last.slice(0, 120) || "mycelium CLI: no usable subcommand");
}

function cliBackend(bin: string): Backend {
  return {
    kind: "cli",
    async rooms() {
      return normalizeRooms(
        runCli(bin, [["rooms", "--json"], ["rooms", "list", "--json"], ["room", "list", "--json"], ["ls", "--json"]], "rooms"),
      );
    },
    async detail(id, limit) {
      const messages = normalizeMessages(
        runCli(
          bin,
          [
            ["messages", "--room", id, "--json"],
            ["messages", "list", "--room", id, "--json"],
            ["room", "show", id, "--json"],
            ["read", id, "--json"],
          ],
          "messages",
        ),
      ).slice(-limit);
      const agents = pickList(
        tryCli(bin, [["agents", "--room", id, "--json"], ["agents", "--json"], ["room", "agents", id, "--json"]], "agents"),
      )
        .map(normalizeAgent)
        .filter((a): a is Agent => a !== null);
      const memory = normalizeMemory(
        tryCli(bin, [["memory", "--room", id, "--json"], ["knowledge", "--room", id, "--json"], ["memory", "list", id, "--json"]], "memory"),
      );
      const room = normalizeRoom({
        id,
        agents: agents.length ? agents.map((a) => a.name) : distinctSenders(messages),
        messages: messages.length,
        lastAt: messages.at(-1)?.at ?? 0,
      });
      return { room: room ?? emptyRoom(id), messages, agents, memory };
    },
  };
}

/** Optional CLI data (agents/memory): absent is fine, don't fail the drill-in. */
function tryCli(bin: string, forms: string[][], slot: string): unknown {
  try {
    return runCli(bin, forms, slot);
  } catch {
    return [];
  }
}

function myceliumBin(): string | null {
  const explicit = process.env.KONA_MYCELIUM_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const local = join(homedir(), ".local", "bin", "mycelium");
  if (existsSync(local)) return local;
  const which = Bun.spawnSync(["which", "mycelium"], { stderr: "ignore" });
  const path = which.exitCode === 0 ? which.stdout.toString().trim() : "";
  return path || null;
}

// --- files (~/.mycelium/rooms/)

const MSG_FILES = ["messages.jsonl", "messages.json", "log.jsonl", "transcript.jsonl"];
const META_FILES = ["room.json", "meta.json", "info.json"];
const MEM_FILES = ["memory.json", "memory.jsonl", "knowledge.json"];
const AGENT_FILES = ["agents.json", "members.json"];

async function readJson(path: string): Promise<unknown> {
  try {
    const body = await Bun.file(path).text();
    if (path.endsWith(".jsonl")) return parseJsonl(body);
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** First of `candidates` that exists inside `dir`, parsed. */
async function readFirst(dir: string, candidates: string[]): Promise<unknown> {
  for (const f of candidates) {
    const p = join(dir, f);
    if (existsSync(p)) {
      const v = await readJson(p);
      if (v !== null) return v;
    }
  }
  return null;
}

async function fsMessages(entry: string): Promise<Message[]> {
  const stats = await stat(entry).catch(() => null);
  const raw = stats?.isDirectory() ? await readFirst(entry, MSG_FILES) : await readJson(entry);
  return normalizeMessages(raw ?? []);
}

function distinctSenders(messages: Message[]): string[] {
  return [...new Set(messages.map((m) => m.from).filter((f) => f && f !== "?"))];
}

function fsBackend(root: string): Backend {
  const dir = join(root, "rooms");
  const entryFor = async (id: string): Promise<string> => {
    const d = join(dir, id);
    if (existsSync(d)) return d;
    for (const ext of [".jsonl", ".json"]) if (existsSync(d + ext)) return d + ext;
    throw new Error(`no such room: ${id}`);
  };

  return {
    kind: "fs",
    async rooms() {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const rooms: Room[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const isDir = e.isDirectory();
        if (!isDir && ![".json", ".jsonl"].includes(extname(e.name))) continue;
        const path = join(dir, e.name);
        const id = isDir ? e.name : basename(e.name, extname(e.name));
        const meta = isDir ? ((await readFirst(path, META_FILES)) ?? {}) : {};
        const messages = await fsMessages(path);
        const mtime = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
        const room = normalizeRoom({
          id,
          mtime,
          messages: messages.length,
          agents: distinctSenders(messages),
          ...(isRec(meta) ? meta : {}),
          lastAt: messages.at(-1)?.at || (isRec(meta) ? pick(meta, ["last_at", "lastAt", "updated_at"]) : 0) || mtime,
        });
        if (room) rooms.push(room);
      }
      rooms.sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name));
      return rooms;
    },
    async detail(id, limit) {
      const entry = await entryFor(id);
      const isDir = (await stat(entry)).isDirectory();
      const meta = isDir ? ((await readFirst(entry, META_FILES)) ?? {}) : {};
      const messages = (await fsMessages(entry)).slice(-limit);
      const agentsRaw = isDir ? await readFirst(entry, AGENT_FILES) : null;
      const agents = pickList(agentsRaw ?? [])
        .map(normalizeAgent)
        .filter((a): a is Agent => a !== null);
      const memory = normalizeMemory(isDir ? ((await readFirst(entry, MEM_FILES)) ?? []) : []);
      const room = normalizeRoom({
        id,
        agents: agents.length ? agents.map((a) => a.name) : distinctSenders(messages),
        messages: messages.length,
        lastAt: messages.at(-1)?.at ?? 0,
        ...(isRec(meta) ? meta : {}),
      });
      return { room: room ?? emptyRoom(id), messages, agents, memory };
    },
  };
}

function emptyRoom(id: string): Room {
  return { id, name: id, topic: "", agents: [], messages: 0, lastAt: 0 };
}

/**
 * The backends worth trying, in order. An explicitly configured URL wins; then
 * the CLI and the on-disk rooms if they exist; the default localhost daemon is
 * the last resort (a refused connection is cheap).
 */
export function backends(): Backend[] {
  const list: Backend[] = [];
  const url = envUrl();
  if (url) list.push(httpBackend(url.replace(/\/$/, "")));
  const bin = myceliumBin();
  if (bin) list.push(cliBackend(bin));
  const root = fsRoot();
  if (existsSync(join(root, "rooms"))) list.push(fsBackend(root));
  if (!url) list.push(httpBackend(DEFAULT_URL));
  return list;
}

/** How to point kona at mycelium, shown when nothing answered. */
export const SETUP_HINT = [
  "No mycelium backend answered. kona looks for, in order:",
  "  • MYCELIUM_URL — the local daemon / OpenAPI backend",
  "  • the mycelium CLI (PATH, or ~/.local/bin/mycelium)",
  "  • room files under ~/.mycelium/rooms/",
];

// ------------------------------------------------------------------ public API

/** Active rooms, newest activity first, plus which backend answered. */
export async function listRooms(): Promise<{ rooms: Room[]; source: Source }> {
  const errors: string[] = [];
  for (const b of backends()) {
    try {
      return { rooms: await b.rooms(), source: b.kind };
    } catch (e) {
      errors.push(`${b.kind}: ${msg(e)}`);
    }
  }
  if (errors.length) throw new Error(errors.join(" · ").slice(0, 200));
  return { rooms: [], source: "none" };
}

/** One room drilled into: recent messages, agents present, shared memory. */
export async function roomDetail(id: string, limit = 50): Promise<RoomDetail> {
  const errors: string[] = [];
  for (const b of backends()) {
    try {
      return { ...(await b.detail(id, limit)), source: b.kind };
    } catch (e) {
      errors.push(`${b.kind}: ${msg(e)}`);
    }
  }
  throw new Error(errors.join(" · ").slice(0, 200) || "no mycelium backend");
}
