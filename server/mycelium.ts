import { homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { constants, existsSync } from "node:fs";
import { access, appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { providerFetch } from "./transport.ts";

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
 * tested.
 *
 * kona JOINS the swarm: as well as reading, a backend may post a message,
 * create a room, set an agent's status and write shared memory. Writing is
 * best-effort per transport — the HTTP daemon and the CLI each spell their
 * write side differently, and a backend may not have one at all. That last case
 * is a first-class answer, not a failure: `WriteUnsupported` means "this really
 * is read-only", so the UI can say so instead of offering a dead composer.
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

/** What a room needs to exist. `id` is derived from the name when absent. */
export interface NewRoom {
  id?: string;
  name: string;
  topic?: string;
}

/**
 * A transport. `rooms`/`detail` are the read half every backend has; the four
 * write methods are optional — a backend that omits one cannot do it at all,
 * and `write()` moves on to the next transport instead of failing.
 */
interface Backend {
  kind: Source;
  rooms: () => Promise<Room[]>;
  detail: (id: string, limit: number) => Promise<Omit<RoomDetail, "source">>;
  /** True/false when the transport can know without writing; null = try and see. */
  writable?: () => Promise<boolean | null>;
  post?: (room: string, from: string, text: string) => Promise<Message>;
  create?: (room: NewRoom) => Promise<Room>;
  status?: (agent: string, status: string, room: string | null) => Promise<void>;
  remember?: (room: string, key: string, value: string) => Promise<Memo>;
}

/**
 * "This backend has no write side" — as opposed to "the write failed". The
 * difference is the whole read-only story: on a WriteUnsupported the applet
 * puts the composer away and says so, on any other error it keeps the composer
 * and shows what went wrong.
 */
export class WriteUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteUnsupported";
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A room id from a human name: "Ship kona!" -> "ship-kona". */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "room"
  );
}

// --- HTTP (local daemon / OpenAPI backend)

async function getJson(base: string, paths: string[]): Promise<unknown> {
  let last = "";
  for (const p of paths) {
    try {
      const res = await providerFetch("mycelium", `${base}${p}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (res.ok) return await res.json();
      last = `${res.status} ${p}`;
    } catch (e) {
      last = msg(e);
    }
  }
  throw new Error(last || "no response");
}

/**
 * POST a body to the first path that answers. A 404/405/501 means "not that
 * route" and we keep looking; anything else (a 400, a refused connection) is a
 * real failure and is reported as one. Exhausting every route without a real
 * failure is what WriteUnsupported means: this daemon only reads.
 */
async function postJson(base: string, paths: string[], body: Rec): Promise<unknown> {
  let unsupported = true;
  let last = "";
  for (const p of paths) {
    try {
      const res = await providerFetch("mycelium", `${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.ok) return await res.json().catch(() => ({}));
      if (![404, 405, 501].includes(res.status)) unsupported = false;
      last = `${res.status} ${p}`;
    } catch (e) {
      unsupported = false;
      last = msg(e);
    }
  }
  throw unsupported
    ? new WriteUnsupported(last ? `no write endpoint (${last})` : "no write endpoint")
    : new Error(last || "write failed");
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

    async post(id, from, text) {
      const body = await postJson(base, [...room(id, "/messages"), ...room(id, "/post"), "/messages"], {
        room: id,
        from,
        text,
      });
      const rec = isRec(body) ? (isRec(body.message) ? body.message : body) : {};
      return normalizeMessage({ from, text, at: Date.now(), ...rec });
    },

    async create({ id, name, topic }) {
      const rid = id ?? slug(name);
      const body = await postJson(base, ["/rooms", "/api/rooms", "/v1/rooms"], { id: rid, name, topic: topic ?? "" });
      const rec = isRec(body) ? (isRec(body.room) ? body.room : body) : {};
      return normalizeRoom({ id: rid, name, topic: topic ?? "", ...rec }) ?? emptyRoom(rid);
    },

    async status(agent, status, id) {
      await postJson(
        base,
        [...(id ? room(id, "/agents") : []), `/agents/${encodeURIComponent(agent)}/status`, "/agents", "/status"],
        { ...(id ? { room: id } : {}), name: agent, agent, status },
      );
    },

    async remember(id, key, value) {
      await postJson(base, room(id, "/memory"), { room: id, key, value });
      return { key, value, at: Date.now() };
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

/**
 * Run a WRITE subcommand. Unlike runCli this judges ONLY the exit code: a write
 * that succeeded but printed prose (or nothing) must never be retried in
 * another spelling, or one post becomes two. For the same reason the cache
 * holds the winning FORM INDEX, not the argv — the argv carries the payload.
 */
const cliWriteWinner = new Map<string, number>();

function runCliWrite(bin: string, forms: string[][], slot: string): void {
  const won = cliWriteWinner.get(slot) ?? -1;
  const idx = [...forms.keys()];
  const order = won >= 0 && won < forms.length ? [won, ...idx.filter((i) => i !== won)] : idx;
  let last = "";
  for (const i of order) {
    const argv = forms[i]!;
    const r = Bun.spawnSync([bin, ...argv], { stderr: "pipe", stdout: "pipe" });
    if (r.exitCode === 0) {
      cliWriteWinner.set(slot, i);
      return;
    }
    last = r.stderr.toString().trim().split("\n")[0] ?? "";
  }
  // Every spelling was rejected: as far as we can tell this CLI cannot do it.
  throw new WriteUnsupported(last.slice(0, 120) || `mycelium CLI: no ${slot} subcommand`);
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

    async post(id, from, text) {
      runCliWrite(
        bin,
        [
          ["post", "--room", id, "--from", from, "--text", text],
          ["post", "--room", id, "--text", text],
          ["send", "--room", id, "--text", text],
          ["message", "send", "--room", id, "--text", text],
          ["post", id, text],
          ["send", id, text],
        ],
        "post",
      );
      return { id: `sent-${Date.now()}`, from, at: Date.now(), text };
    },

    async create({ id, name, topic }) {
      const rid = id ?? slug(name);
      const withTopic = topic ? ["--topic", topic] : [];
      runCliWrite(
        bin,
        [
          ["rooms", "create", rid, ...withTopic],
          ["room", "create", rid, ...withTopic],
          ["rooms", "add", rid],
          ["create", "room", rid],
        ],
        "create",
      );
      return { ...emptyRoom(rid), name: name || rid, topic: topic ?? "", lastAt: Date.now() };
    },

    async status(agent, status, id) {
      const inRoom = id ? ["--room", id] : [];
      runCliWrite(
        bin,
        [
          ["status", "set", status, "--agent", agent, ...inRoom],
          ["status", "set", status, ...inRoom],
          ["agent", "status", status],
          ["status", status],
        ],
        "status",
      );
    },

    async remember(id, key, value) {
      runCliWrite(
        bin,
        [
          ["memory", "set", key, value, "--room", id],
          ["memory", "put", "--room", id, key, value],
          ["remember", "--room", id, key, value],
          ["memory", "set", "--room", id, "--key", key, "--value", value],
        ],
        "remember",
      );
      return { key, value, at: Date.now() };
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

    // Room files are not a read-only mirror of somewhere else — they ARE the
    // room, so kona writes them in exactly the shape it reads them back in.
    async writable() {
      return access(dir, constants.W_OK).then(
        () => true,
        () => false,
      );
    },

    async post(id, from, text) {
      const at = Date.now();
      const record = { id: `m-${at}`, from, text, at: new Date(at).toISOString() };
      await appendRecord(await entryFor(id), MSG_FILES, "messages.jsonl", record);
      return { id: record.id, from, at, text };
    },

    async create({ id, name, topic }) {
      const rid = id ?? slug(name);
      const target = join(dir, rid);
      for (const p of [target, `${target}.jsonl`, `${target}.json`]) {
        if (existsSync(p)) throw new Error(`room exists: ${rid}`);
      }
      await mkdir(target, { recursive: true });
      await writeJson(join(target, "room.json"), {
        id: rid,
        name: name || rid,
        topic: topic ?? "",
        created_at: new Date().toISOString(),
      });
      await appendFile(join(target, "messages.jsonl"), "");
      return { ...emptyRoom(rid), name: name || rid, topic: topic ?? "", lastAt: Date.now() };
    },

    async status(agent, status, id) {
      if (!id) throw new WriteUnsupported("room files hold status per room — open a room first");
      const entry = await roomDir(await entryFor(id), "status");
      const file = join(entry, AGENT_FILES.find((f) => existsSync(join(entry, f))) ?? "agents.json");
      const rest = pickList((await readJson(file)) ?? []).filter(
        (r) => str(r, ["name", "id", "agent", "handle"]) !== agent,
      );
      await writeJson(file, [...rest, { name: agent, status, last_seen: new Date().toISOString() }]);
    },

    async remember(id, key, value) {
      const entry = await roomDir(await entryFor(id), "shared memory");
      const file = join(entry, MEM_FILES.find((f) => existsSync(join(entry, f))) ?? "memory.json");
      const at = Date.now();
      const stamped = { key, value, at: new Date(at).toISOString() };
      if (file.endsWith(".jsonl")) {
        await appendLine(file, JSON.stringify(stamped));
        return { key, value, at };
      }
      const current = await readJson(file);
      if (Array.isArray(current)) {
        const rest = current.filter((r) => !(isRec(r) && str(r, ["key", "name", "title", "id"]) === key));
        await writeJson(file, [...rest, stamped]);
      } else {
        // A plain {key: value} map — including the {memory: {...}} nesting the
        // reader understands, which must stay nested or it reads back wrong.
        const map = isRec(current) ? { ...current } : {};
        if (isRec(map.memory)) map.memory = { ...map.memory, [key]: value };
        else map[key] = value;
        await writeJson(file, map);
      }
      return { key, value, at };
    },
  };
}

/** A room's directory, or a clear "this shape can't hold that" for a bare log. */
async function roomDir(entry: string, what: string): Promise<string> {
  if ((await stat(entry)).isDirectory()) return entry;
  throw new WriteUnsupported(`${what} needs a room directory, not a bare log file`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Append one JSONL record, healing a log that was left without a trailing
 * newline — otherwise the append lands on the end of the last line and takes a
 * message down with it.
 */
async function appendLine(path: string, line: string): Promise<void> {
  const file = Bun.file(path);
  const size = (await file.exists()) ? file.size : 0;
  const needsBreak = size > 0 && (await file.slice(size - 1).text()) !== "\n";
  await appendFile(path, (needsBreak ? "\n" : "") + line + "\n");
}

/**
 * Append one record to a room, whatever shape the room is: a directory keeps
 * its existing log (or gets `fallback`), a bare `.jsonl` is appended to, and a
 * `.json` array is rewritten with the record on the end.
 */
async function appendRecord(entry: string, candidates: string[], fallback: string, record: Rec): Promise<void> {
  const isDir = (await stat(entry)).isDirectory();
  const target = isDir ? join(entry, candidates.find((f) => existsSync(join(entry, f))) ?? fallback) : entry;
  if (target.endsWith(".jsonl")) {
    await appendLine(target, JSON.stringify(record));
    return;
  }
  const current = await readJson(target);
  const list = Array.isArray(current) ? current : pickList(current);
  await writeJson(target, [...list, record]);
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

/**
 * Active rooms, newest activity first, which backend answered, and whether it
 * can be written to (`null` when the transport can't know without trying — the
 * composer stays open and a WriteUnsupported later settles it).
 */
export async function listRooms(): Promise<{ rooms: Room[]; source: Source; writable: boolean | null }> {
  const errors: string[] = [];
  for (const b of backends()) {
    try {
      const rooms = await b.rooms();
      const writable = b.writable ? await b.writable() : b.post ? null : false;
      return { rooms, source: b.kind, writable };
    } catch (e) {
      errors.push(`${b.kind}: ${msg(e)}`);
    }
  }
  if (errors.length) throw new Error(errors.join(" · ").slice(0, 200));
  return { rooms: [], source: "none", writable: false };
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

// -------------------------------------------------------------------- writing

/**
 * Run a write against the first backend that can do it. A backend without the
 * method, or one that answers WriteUnsupported, is skipped — the next transport
 * gets a go. Only if NOBODY could is the whole thing unsupported, which is what
 * lets the applet say "read-only" with confidence instead of guessing.
 */
async function write<T>(op: (b: Backend) => Promise<T> | undefined, what: string): Promise<{ value: T; source: Source }> {
  const errors: string[] = [];
  let real = false; // did any backend fail for a reason other than "can't"?
  for (const b of backends()) {
    const run = op(b);
    if (!run) {
      errors.push(`${b.kind}: cannot ${what}`);
      continue;
    }
    try {
      return { value: await run, source: b.kind };
    } catch (e) {
      if (!(e instanceof WriteUnsupported)) real = true;
      errors.push(`${b.kind}: ${msg(e)}`);
    }
  }
  const detail = errors.join(" · ").slice(0, 200) || `no mycelium backend can ${what}`;
  throw real ? new Error(detail) : new WriteUnsupported(detail);
}

/** Say something in a room. The message comes back as the backend stored it. */
export async function postMessage(room: string, from: string, text: string): Promise<{ message: Message; source: Source }> {
  const { value, source } = await write((b) => b.post?.(room, from, text), "post");
  return { message: value, source };
}

/** Open a new room. */
export async function createRoom(room: NewRoom): Promise<{ room: Room; source: Source }> {
  const { value, source } = await write((b) => b.create?.(room), "create a room");
  return { room: value, source };
}

/** Announce what this agent is doing ("thinking", "shipping #38", "afk"). */
export async function setStatus(agent: string, status: string, room: string | null = null): Promise<{ source: Source }> {
  const { source } = await write((b) => b.status?.(agent, status, room), "set a status");
  return { source };
}

/** Write one entry into a room's shared memory. */
export async function remember(room: string, key: string, value: string): Promise<{ memo: Memo; source: Source }> {
  const { value: memo, source } = await write((b) => b.remember?.(room, key, value), "write shared memory");
  return { memo, source };
}

// ------------------------------------------------------------------- optimism

/** A message posted from here that the backend hasn't echoed back yet. */
export interface Pending {
  room: string;
  from: string;
  text: string;
  at: number;
}

/** How long an unechoed message keeps showing before we stop claiming it. */
export const PENDING_TTL_MS = 20_000;

/**
 * The sends still waiting to appear. Your message shows the instant you press
 * enter; the next refresh brings the room back from the backend, and any
 * pending copy it now contains (same author, same text) is dropped so the room
 * never shows it twice. Anything older than PENDING_TTL_MS is dropped anyway —
 * a write we can't see land is not something to keep asserting.
 */
export function unconfirmed(pending: Pending[], messages: Message[], room: string, now = Date.now()): Pending[] {
  const seen = new Set(messages.map((m) => `${m.from}\u0000${m.text}`));
  return pending.filter(
    (p) => now - p.at < PENDING_TTL_MS && !(p.room === room && seen.has(`${p.from}\u0000${p.text}`)),
  );
}
