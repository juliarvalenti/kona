import { defineApplet, text, spacer, col, row, input, appletString, type AppletCtx, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow, keyValue, modal, field as labelled, toast } from "../../sdk/components.ts";
import { notify } from "../../server/notify.ts";
import {
  listRooms,
  roomDetail,
  postMessage,
  createRoom,
  setStatus,
  remember,
  unconfirmed,
  slug,
  ago,
  WriteUnsupported,
  SETUP_HINT,
  type Room,
  type RoomDetail,
  type Source,
  type Pending,
} from "../../server/mycelium.ts";

/**
 * mycelium — the coordination layer, as a chat client.
 *
 * kona doesn't watch the swarm through glass: it is IN the room. You browse
 * rooms with j/k, drill in, and type into the composer at the bottom; enter
 * sends. Every one of those actions is a verb, so an agent does the same thing
 * with no terminal anywhere:
 *
 *   kona call mycelium post '{"room":"ship-kona","text":"picking up #38"}'
 *
 * The bimodal joke lands hardest here — you and the agent are peers in the same
 * room, firing the same verb, and neither the applet nor mycelium can tell you
 * apart (except by the name on the message).
 *
 * Writing needs a backend that can take a write (see server/mycelium.ts). When
 * none can, that is a first-class state, not a broken one: the composer is
 * replaced by a read-only notice that says what to connect.
 */

interface Dialog {
  /** Which form is up: a new room, a shared-memory entry, or my status. */
  kind: "room" | "memo" | "status";
  /** Which of its fields has the keyboard. */
  field: string;
  values: Record<string, string>;
}

interface MyceliumState {
  rooms: Room[];
  cursor: number;
  open: RoomDetail | null;
  query: string;
  loading: boolean;
  error: string | null;
  source: Source;
  syncedAt: number;

  // --- the chat half
  /** Who kona posts as. */
  me: string;
  /** The composer's text. Lives in state, so an agent can see (and set) it. */
  draft: string;
  /** Does the composer have the keyboard? */
  composing: boolean;
  sending: boolean;
  /** Sent but not yet echoed back by the backend — shown, dimmed, right away. */
  pending: Pending[];
  /** false once a backend has told us it cannot write. null = not tried yet. */
  writable: boolean | null;
  /** Transient banner: "sent", "room created", why a write failed. */
  notice: string | null;
  noticeAt: number;
  dialog: Dialog | null;
  /** room id -> when we last posted there; suppresses banners for our own words. */
  postedAt: Record<string, number>;
}

const ACCENT = "#a586ff"; // spore violet
const LIVE = "#00d488";
const FG = "#d0d0d0";
const DIM = "#6a6a6a";
const AMBER = "#f0b000";

const REFRESH_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;
const NOTICE_MS = 4000;
/** After you post, don't banner that room's own new messages back at you. */
const SELF_QUIET_MS = 15_000;

/** The fields each dialog collects, in tab order. */
const FIELDS: Record<Dialog["kind"], string[]> = {
  room: ["name", "topic"],
  memo: ["key", "value"],
  status: ["status"],
};

// Refresh schedule. A room list is cheap but the backend may be a CLI shelling
// out (or nothing at all), so failures back off exponentially instead of
// retrying every tick.
let nextAt = 0;
let backoff = 0;
let inFlight = false;

/** Rooms matching the current filter (name, topic, or an agent in the room). */
function visible(state: MyceliumState): Room[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.rooms;
  return state.rooms.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.topic.toLowerCase().includes(q) ||
      r.agents.some((a) => a.toLowerCase().includes(q)),
  );
}

/** Who kona is in the swarm: `[applets.mycelium] agent`, $MYCELIUM_AGENT, else "kona". */
function whoami(): string {
  return appletString("mycelium", "agent", process.env.MYCELIUM_AGENT ?? process.env.KONA_AGENT ?? "kona");
}

/** The room a verb acts on: named by an agent, else the open one, else the cursor. */
function targetRoom(state: MyceliumState, args: Record<string, unknown>): string | null {
  if (typeof args.room === "string" && args.room) return args.room;
  if (state.open) return state.open.room.id;
  return visible(state)[state.cursor]?.id ?? null;
}

/** The first non-empty string among the arg spellings a caller might use. */
function argText(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function say(state: MyceliumState, notice: string) {
  state.notice = notice;
  state.noticeAt = Date.now();
}

/**
 * A write failed. WriteUnsupported is the answer "this backend is read-only" —
 * remember it, so the composer stands down instead of inviting another attempt.
 */
function writeFailed(state: MyceliumState, e: unknown, what: string): { error: string } {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof WriteUnsupported) state.writable = false;
  say(state, `couldn't ${what}: ${detail}`);
  return { error: detail };
}

/** Message counts as of the last sync. null until the first, which adopts. */
let counted: Map<string, number> | null = null;

/**
 * Banner rooms that gained messages while we weren't looking — the ambient half
 * of a chat client, since nobody watches a terminal all day. A daemon boot
 * adopts the swarm as it finds it (or every room would be "new"), and a room we
 * just posted to stays quiet: you don't need a banner for your own words.
 */
function announce(state: MyceliumState, rooms: Room[]) {
  const before = counted;
  counted = new Map(rooms.map((r) => [r.id, r.messages]));
  if (!before) return;
  const now = Date.now();
  for (const r of rooms) {
    const n = r.messages - (before.get(r.id) ?? 0);
    if (n <= 0) continue;
    if (now - (state.postedAt[r.id] ?? 0) < SELF_QUIET_MS) continue;
    void notify({
      event: "mycelium.message",
      key: `mycelium:${r.id}:${r.messages}`,
      title: r.name,
      body: `${n} new message${n === 1 ? "" : "s"}${r.agents.length ? `  ·  ${r.agents.join(", ")}` : ""}`,
    });
  }
}

async function loadRooms(state: MyceliumState, emit: () => void) {
  if (inFlight) return;
  inFlight = true;
  state.loading = true;
  emit();
  try {
    const { rooms, source, writable } = await listRooms();
    announce(state, rooms);
    state.rooms = rooms;
    // A backend that knows its own answer wins; one that can't know only
    // clears a remembered "read-only" when the transport itself changed.
    if (writable !== null) state.writable = writable;
    else if (source !== state.source) state.writable = null;
    state.source = source;
    state.error = null;
    state.cursor = Math.min(state.cursor, Math.max(0, visible(state).length - 1));
    // Time out sends for rooms nobody has open — only the open room gets
    // reconciled against real messages, and nothing should linger forever.
    state.pending = unconfirmed(state.pending, [], "");
    backoff = 0;
    nextAt = Date.now() + REFRESH_MS;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    backoff = backoff ? Math.min(backoff * 2, BACKOFF_MAX_MS) : REFRESH_MS;
    nextAt = Date.now() + backoff;
  } finally {
    inFlight = false;
    state.loading = false;
    state.syncedAt = Date.now();
    emit();
  }
}

async function loadDetail(state: MyceliumState, id: string, emit: () => void) {
  state.loading = true;
  emit();
  try {
    state.open = await roomDetail(id);
    state.source = state.open.source;
    // Anything the backend now echoes back is no longer "pending".
    state.pending = unconfirmed(state.pending, state.open.messages, id);
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
}

/** The field an input payload names: `{ id: "room.name" }` -> "name". */
function fieldName(args: Record<string, unknown>): string {
  return String(args.id ?? "").split(".").pop() ?? "";
}

/**
 * The three participating actions, factored out of their verbs so the form can
 * commit through exactly the same code an agent's direct call runs. A dialog is
 * only ever a way to fill in the arguments.
 */
type Ctx = AppletCtx<MyceliumState>;

async function doCreate({ state, emit }: Ctx, name: string, topic: string) {
  if (!name) return { error: "a room needs a name" };
  try {
    const { room, source } = await createRoom({ id: slug(name), name, topic });
    state.dialog = null;
    state.source = source;
    state.writable = true;
    say(state, `created ${room.name}`);
    await loadRooms(state, emit);
    await loadDetail(state, room.id, emit);
    return { created: room.id, source };
  } catch (e) {
    state.dialog = null;
    emit();
    return writeFailed(state, e, "create the room");
  }
}

async function doStatus({ state, emit }: Ctx, agent: string, status: string) {
  if (!status) return { error: "a status needs some words" };
  try {
    const { source } = await setStatus(agent, status, state.open?.room.id ?? null);
    state.dialog = null;
    state.source = source;
    state.writable = true;
    say(state, `status: ${status}`);
    if (state.open) await loadDetail(state, state.open.room.id, emit);
    emit();
    return { agent, status, source };
  } catch (e) {
    state.dialog = null;
    emit();
    return writeFailed(state, e, "set your status");
  }
}

async function doRemember({ state, emit }: Ctx, room: string, key: string, value: string) {
  if (!key || !value) return { error: "shared memory needs a key and a value" };
  try {
    const { memo, source } = await remember(room, key, value);
    state.dialog = null;
    state.source = source;
    state.writable = true;
    say(state, `remembered ${memo.key}`);
    await loadDetail(state, room, emit);
    return { room, key: memo.key, value: memo.value, source };
  } catch (e) {
    state.dialog = null;
    emit();
    return writeFailed(state, e, "write shared memory");
  }
}

export default defineApplet<MyceliumState>({
  id: "mycelium",
  title: "Mycelium",
  summary: "The coordination layer — rooms, agents, and what you say to them.",
  icon: "✳",
  tint: ACCENT,
  labels: ["agents", "chat"],
  requires: ["a backend: MYCELIUM_URL, the `mycelium` CLI, or ~/.mycelium/rooms"],
  // `kona mycelium ship-kona` opens straight into that room.
  cli: {
    usage: "kona mycelium <room>",
    open: (args) => (args[0] ? { verb: "open", args: { room: args[0] } } : null),
  },
  notifications: {
    "mycelium.message": {
      summary: "a coordination room you watch gets new messages",
      default: false,
    },
  },
  configSample: `[applets.mycelium]
agent = "kona"       # the name your messages are posted under`,
  ephemeral: true, // a live view of someone else's state; nothing to persist
  initialState: {
    rooms: [],
    cursor: 0,
    open: null,
    query: "",
    loading: false,
    error: null,
    source: "none",
    syncedAt: 0,
    me: "kona",
    draft: "",
    composing: false,
    sending: false,
    pending: [],
    writable: null,
    notice: null,
    noticeAt: 0,
    dialog: null,
    postedAt: {},
  },

  docs: {
    refresh: "Re-read the room list (and the open room) from the backend.",
    open: { doc: "Drill into a room by `room` id — agents, recent messages, shared memory.", args: { room: "ship-kona" } },
    search: { doc: "Filter rooms by name, topic, or a member agent.", args: { q: "kona" } },
  },

  recipes: [
    {
      title: "Read a mycelium room",
      steps: [
        `kona call mycelium refresh                          # -> { rooms: 4, source: "http" }`,
        `kona call mycelium open '{"room":"ship-kona"}'      # -> agents, message count, memory keys`,
        `kona state mycelium                                  # the messages themselves`,
      ],
      note: "Read-only by design: kona observes the coordination layer, it does not post to it. Say something in a room with your own mycelium client; kona is the window, not the mouth.",
    },
  ],

  verbs: {
    async refresh(_args, { state, emit }) {
      await loadRooms(state, emit);
      if (state.open) await loadDetail(state, state.open.room.id, emit);
      return { rooms: state.rooms.length, source: state.source, writable: state.writable, error: state.error };
    },

    /** Drill into a room — by list index (the TUI) or by id (an agent). */
    async open(args, { state, emit }) {
      const rows = visible(state);
      const id =
        typeof args.room === "string"
          ? args.room
          : (rows[typeof args.index === "number" ? args.index : state.cursor]?.id ?? null);
      if (!id) return { error: "no such room" };
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) state.cursor = idx;
      await loadDetail(state, id, emit);
      const d = state.open;
      return d
        ? {
            room: d.room.id,
            agents: d.agents.length ? d.agents.map((a) => a.name) : d.room.agents,
            messages: d.messages.length,
            memory: d.memory.map((m) => m.key),
          }
        : { error: state.error };
    },

    /** Back out: first the composer, then the room. */
    back(_args, { state, emit }) {
      if (state.composing) state.composing = false;
      else state.open = null;
      emit();
    },

    /** Filter rooms by name, topic, or a member agent. */
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "");
      state.open = null;
      state.composing = false;
      state.cursor = 0;
      emit();
      return { query: state.query, matches: visible(state).length };
    },

    // --- composing ----------------------------------------------------------

    /** Give the composer the keyboard (a keypress), optionally in a given room. */
    async compose(args, { state, emit }) {
      const id = targetRoom(state, args);
      if (id && state.open?.room.id !== id) await loadDetail(state, id, emit);
      if (!state.open) return { error: "open a room first" };
      if (typeof args.text === "string") state.draft = args.text;
      state.composing = true;
      emit();
      return { room: state.open.room.id, draft: state.draft };
    },

    /** Every keystroke in the composer — the draft is state, so agents see it. */
    draft(args, { state, emit }) {
      state.draft = typeof args.value === "string" ? args.value : "";
      emit();
    },

    /** Leave the composer, keeping what's typed. */
    blur(_args, { state, emit }) {
      state.composing = false;
      emit();
    },

    /**
     * Say something. `text` (an agent) or `value` (the composer's enter) — one
     * verb, two callers. The message shows immediately and is reconciled with
     * the backend on the next refresh.
     */
    async post(args, { state, emit }) {
      const id = targetRoom(state, args);
      const body = argText(args, "text", "value", "message", "q");
      if (!id) return { error: "no room to post to" };
      if (!body) return { posted: false, reason: "empty message" };

      state.sending = true;
      state.draft = "";
      const at = Date.now();
      state.pending = [...state.pending, { room: id, from: state.me, text: body, at }];
      state.postedAt = { ...state.postedAt, [id]: at };
      emit();
      try {
        const { source } = await postMessage(id, state.me, body);
        state.source = source;
        state.writable = true;
        state.error = null;
        state.sending = false;
        emit();
        // Pull the room back so your message arrives the way everyone else's does.
        if (state.open?.room.id === id) await loadDetail(state, id, emit);
        return { posted: true, room: id, from: state.me, text: body, source };
      } catch (e) {
        state.sending = false;
        state.pending = state.pending.filter((p) => p.at !== at);
        state.draft = body; // don't eat what you typed
        emit();
        return writeFailed(state, e, "post");
      }
    },

    // --- participating ------------------------------------------------------

    /**
     * Open a room. With no arguments this opens the form (a keypress); with a
     * `name` it just makes the room (an agent). Same verb either way.
     */
    async create(args, ctx) {
      const name = argText(args, "name", "room", "title", "value");
      if (!name) {
        ctx.state.dialog = { kind: "room", field: "name", values: { name: "", topic: "" } };
        ctx.emit();
        return { dialog: "room" };
      }
      return doCreate(ctx, name, argText(args, "topic", "description"));
    },

    /** Announce what this agent is up to. No args opens the form. */
    async status(args, ctx) {
      const status = argText(args, "status", "state", "value", "q");
      if (!status) {
        ctx.state.dialog = { kind: "status", field: "status", values: { status: "" } };
        ctx.emit();
        return { dialog: "status" };
      }
      return doStatus(ctx, argText(args, "agent", "name") || ctx.state.me, status);
    },

    /** Write an entry into the open room's shared memory. No args opens the form. */
    async remember(args, ctx) {
      const id = targetRoom(ctx.state, args);
      const key = argText(args, "key", "name");
      const value = argText(args, "value", "text", "content");
      if (!id) return { error: "no room to write memory into" };
      if (!key || !value) {
        ctx.state.dialog = { kind: "memo", field: key ? "value" : "key", values: { key, value } };
        ctx.emit();
        return { dialog: "memo" };
      }
      return doRemember(ctx, id, key, value);
    },

    // --- the dialogs --------------------------------------------------------

    /** A keystroke in a dialog field: `{ id: "room.name", value }`. */
    field(args, { state, emit }) {
      const d = state.dialog;
      if (!d) return { error: "no dialog open" };
      const name = fieldName(args);
      if (!FIELDS[d.kind].includes(name)) return { error: `no such field: ${name}` };
      d.values[name] = typeof args.value === "string" ? args.value : "";
      d.field = name;
      emit();
      return { field: name, value: d.values[name] };
    },

    /** Tab: the next field of the open form. */
    next(_args, { state, emit }) {
      const d = state.dialog;
      if (!d) return;
      const fields = FIELDS[d.kind];
      d.field = fields[(fields.indexOf(d.field) + 1) % fields.length]!;
      emit();
    },

    /**
     * Enter in a dialog field. It commits the form — except the one case where
     * committing early would be useless: a memo with a key and no value yet
     * moves to the value instead.
     */
    async form(args, ctx) {
      const d = ctx.state.dialog;
      if (!d) return { error: "no dialog open" };
      const name = fieldName(args);
      if (FIELDS[d.kind].includes(name)) d.values[name] = typeof args.value === "string" ? args.value : "";
      const v = d.values;
      if (d.kind === "memo" && v.key && !v.value) {
        d.field = "value";
        ctx.emit();
        return { field: "value" };
      }
      if (d.kind === "room") return doCreate(ctx, v.name ?? "", v.topic ?? "");
      if (d.kind === "memo") {
        const room = ctx.state.open?.room.id;
        return room ? doRemember(ctx, room, v.key ?? "", v.value ?? "") : { error: "no room open" };
      }
      return doStatus(ctx, ctx.state.me, v.status ?? "");
    },

    /** Close the form without doing anything. */
    dismiss(_args, { state, emit }) {
      state.dialog = null;
      emit();
    },

    up(_args, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      state.cursor = Math.min(Math.max(0, visible(state).length - 1), state.cursor + 1);
      emit();
    },
  },

  init({ state, emit }) {
    nextAt = 0;
    backoff = 0;
    counted = null; // a fresh daemon adopts the swarm instead of bannering it
    state.me = whoami();
    void loadRooms(state, emit);
  },

  // Poll on the schedule loadRooms sets (10s healthy, exponential to 5min while
  // the backend is missing or erroring). The open room comes with it, so
  // someone else's message lands in front of you without a keypress.
  tickMs: 2000,
  tick({ state, emit }) {
    if (state.notice && Date.now() - state.noticeAt > NOTICE_MS) {
      state.notice = null;
      emit();
    }
    if (inFlight || Date.now() < nextAt) return;
    nextAt = Date.now() + REFRESH_MS; // tentative; loadRooms sets the real time
    void loadRooms(state, emit);
    if (state.open) void loadDetail(state, state.open.room.id, emit);
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
    n: { verb: "create", label: "new room" },
    s: { verb: "status", label: "my status" },
    m: { verb: "remember", label: "remember", when: (s) => !!s.open },
    // Enter in an open room means "say something" — there is no room left to
    // open, and a chat window that answers enter with a composer is the least
    // surprising thing a chat window can do.
    return: { verb: "compose", label: "write", when: (s) => !!s.open && !s.composing },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "room",
    back: "back",
    backLabel: "rooms",
    canBack: (s) => !!s.open,
  },

  search: { verb: "search", placeholder: "filter rooms (name, topic, agent)" },

  crumb: (s) => (s.open ? s.open.room.name : null),

  accent: (s) => (s.error && !s.rooms.length ? AMBER : ACCENT),

  // The forms: a floating card with a real text field in it. Enter belongs to
  // the field (it submits), tab moves between fields, esc closes.
  overlay: (state) => {
    const d = state.dialog;
    if (!d) return null;
    const box = (id: string, placeholder: string, width = 34): ViewNode =>
      input(`${d.kind}.${id}`, d.values[id] ?? "", {
        placeholder,
        width,
        focus: d.field === id,
        submit: "form",
        submitLabel: d.kind === "room" ? "create" : "save",
        cancel: "dismiss",
        cancelLabel: "cancel",
        change: "field",
        color: ACCENT,
      });
    const dialogs: Record<Dialog["kind"], { title: string; fields: ViewNode[]; footer: string }> = {
      room: {
        title: "new room",
        fields: [
          labelled("name ", box("name", "ship-kona"), { labelWidth: 6 }),
          labelled("topic", box("topic", "what it's for (optional)"), { labelWidth: 6 }),
        ],
        footer: `id will be “${slug(d.values.name ?? "")}”`,
      },
      memo: {
        title: "remember",
        fields: [
          labelled("key  ", box("key", "plan"), { labelWidth: 6 }),
          labelled("value", box("value", "what the swarm should know"), { labelWidth: 6 }),
        ],
        footer: "",
      },
      status: {
        title: "my status",
        fields: [labelled("status", box("status", "thinking, shipping #38, afk…", 32), { labelWidth: 6 })],
        footer: `posting as ${state.me}`,
      },
    };
    const spec = dialogs[d.kind];
    return {
      // The keys are on the hint bar already; the footer is for what only the
      // form can tell you (the id a name will get, who you're posting as).
      node: modal(spec.title, spec.fields, { width: 52, color: ACCENT, ...(spec.footer ? { footer: spec.footer } : {}) }),
      scrim: true,
      dismiss: "dismiss",
      keymap: { tab: { verb: "next", label: "next field" } },
    };
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);

    // Nothing to show and nowhere to look — explain how to connect.
    if (!state.rooms.length && !state.open && !state.loading && state.source === "none") {
      return [
        col([
          text("No coordination layer found", { color: AMBER }),
          spacer(),
          ...SETUP_HINT.map((line) => text(line, { dim: true })),
          ...(state.error ? [spacer(), text(state.error.slice(0, W - 2), { color: DIM })] : []),
        ]),
      ];
    }

    const banner = state.notice
      ? [toast(state.notice, state.notice.startsWith("couldn't") ? "warn" : "info", { width: W - 1 })]
      : [];

    // One room, drilled into: the chat.
    if (state.open) {
      const d = state.open;
      // "planner (thinking), coder" — status when the backend reports one.
      const present = d.agents.length
        ? d.agents.map((a) => (a.status ? `${a.name} (${a.status})` : a.name))
        : d.room.agents;
      const nodes: ViewNode[] = [
        ...banner,
        text(d.room.name, { color: ACCENT }),
        ...(d.room.topic ? [text(d.room.topic, { dim: true })] : []),
        keyValue("agents", present.length ? present.join(", ") : "none present", {
          color: present.length ? LIVE : DIM,
        }),
        divider(W - 1),
      ];

      const pending = state.pending.filter((p) => p.room === d.room.id);
      if (!d.messages.length && !pending.length) {
        nodes.push(text("(no messages yet — say something)", { dim: true }));
      }
      const NAME_W = Math.min(14, Math.max(8, Math.floor(W * 0.16)));
      const GUTTER = 2 + 5 + 2 + NAME_W + 2;
      const body = Math.max(16, W - GUTTER - 1);
      const speech = (from: string, at: number, message: string, color: string, dim = false): ViewNode[] => {
        const lines = wrap(message, body);
        return [
          row([
            text(`  ${(at ? clock(at) : "·").padEnd(5)}`, { dim: true }),
            text(`  ${from.slice(0, NAME_W).padEnd(NAME_W)}`, { color }),
            text(`  ${lines[0]}`, { color: dim ? DIM : FG, dim }),
          ]),
          ...lines.slice(1).map((line) => text(" ".repeat(GUTTER) + line, { color: dim ? DIM : FG, dim })),
        ];
      };

      // A chat reads from the bottom: keep the newest messages (and the
      // composer under them) on screen and roll the older ones off the top,
      // rather than opening a busy room on its first message from last Tuesday.
      const said = [
        ...d.messages.map((m) => speech(m.from, m.at, m.text, m.from === state.me ? ACCENT : LIVE)),
        ...pending.map((p) => speech(p.from, 0, `${p.text}   ⋯`, ACCENT, true)),
      ];
      const memoryLines = d.memory.length ? Math.min(12, d.memory.length) + 2 : 0;
      const foot = composer(state, d, W);
      // …minus what sits under them: the "N earlier" line, the spacer, the rule,
      // the composer itself, and a line of slack (the host's height hint lags
      // the hint bar by a render when it wraps to two lines).
      const budget = Math.max(4, (ctx?.height ?? 24) - nodes.length - memoryLines - foot.length - 5);
      let used = 0;
      let first = said.length;
      while (first > 0 && (first === said.length || used + said[first - 1]!.length <= budget)) {
        used += said[--first]!.length; // the newest message always shows, however long
      }
      if (first > 0) nodes.push(text(`  ⌃ ${first} earlier message${first === 1 ? "" : "s"}`, { dim: true }));
      for (const lines of said.slice(first)) nodes.push(...lines);

      if (d.memory.length) {
        nodes.push(spacer(), text(`SHARED MEMORY  ·  ${d.memory.length}`, { color: ACCENT }));
        for (const m of d.memory.slice(0, 12)) {
          nodes.push(
            recordRow(
              [
                { text: m.key, width: Math.min(20, Math.floor(W * 0.25)) },
                { text: m.value, grow: true },
              ],
              { width: W, color: FG },
            ),
          );
        }
      }

      // No blank line before the rule: on a short terminal every row between the
      // last message and the composer is a row of chat you can't see.
      nodes.push(divider(W - 1), ...foot);
      return [col(nodes)];
    }

    // The room list.
    const rows = visible(state);
    const via = state.source === "none" ? "" : `  ·  via ${state.source}`;
    const synced = state.syncedAt ? `  ·  ${ago(state.syncedAt)} ago` : "";
    // Only announce the first sync — the 10s poll shouldn't flicker the header.
    const header =
      state.loading && !state.rooms.length
        ? text("syncing…", { color: AMBER })
      : text(`${rows.length} room${rows.length === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : ""}  ·  as ${state.me}${via}${synced}`, {
          dim: true,
        });

    const nodes: ViewNode[] = [...banner, header, divider(W - 1)];
    if (state.error) nodes.push(text(state.error.slice(0, W - 2), { color: AMBER }));

    if (!rows.length && !state.loading) {
      nodes.push(
        text(state.query ? "(no rooms match — press / to change the filter)" : "(no active rooms)", { dim: true }),
        text("press n to open one · agents call mycelium.create", { color: DIM }),
      );
    }

    for (const [i, r] of rows.entries()) {
      const hot = r.lastAt > 0 && Date.now() - r.lastAt < 120_000; // chatter in the last 2 min
      nodes.push(
        recordRow(
          [
            { text: hot ? "●" : " ", width: 1 },
            { text: r.name, grow: true },
            { text: r.agents.length ? `${r.agents.length} agent${r.agents.length === 1 ? "" : "s"}` : "—", width: 9 },
            { text: r.messages ? `${r.messages} msg` : "", width: 8, align: "right" },
            { text: ago(r.lastAt), width: 5, align: "right" },
          ],
          { width: W, selected: i === state.cursor, accent: ACCENT, color: hot ? LIVE : FG },
        ),
      );
    }

    return [col(nodes)];
  },
});

/**
 * The composer — or, when nothing here can write, an honest explanation of why
 * there isn't one. A dead text field that silently drops what you type would be
 * worse than no field at all.
 */
function composer(state: MyceliumState, room: RoomDetail, W: number): ViewNode[] {
  if (state.writable === false) {
    // One line, because the composer's slot is the composer's slot: on a short
    // terminal this must not be the thing that pushes the room off screen.
    return [text(" read-only — set MYCELIUM_URL or put `mycelium` on PATH to post", { color: AMBER })];
  }
  const width = Math.max(20, W - 8);
  return [
    row([
      text(state.sending ? " ⋯ " : " › ", { color: state.sending ? AMBER : ACCENT }),
      input("composer", state.draft, {
        placeholder: state.composing
          ? `message ${room.room.name}…`
          : "enter to write  ·  agents call mycelium.post",
        width,
        focus: state.composing,
        submit: "post",
        submitLabel: "send",
        cancel: "blur",
        cancelLabel: "leave composer",
        change: "draft",
        color: ACCENT,
      }),
    ]),
  ];
}

/** Wall-clock time a message was sent: "14:32". */
function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Greedy word wrap. Chat is prose, so a long message wraps under its sender
 * instead of being truncated with an ellipsis the way a list row would be; a
 * single unbroken token (a URL) is hard-split rather than allowed to overflow.
 */
export function wrap(body: string, width: number): string[] {
  const w = Math.max(8, width);
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of body.split(/\s+/).filter(Boolean)) {
    let token = word;
    while (token.length > w) {
      flush();
      lines.push(token.slice(0, w));
      token = token.slice(w);
    }
    if (!line) line = token;
    else if (line.length + 1 + token.length <= w) line += ` ${token}`;
    else {
      flush();
      line = token;
    }
  }
  flush();
  return lines.length ? lines : [""];
}
