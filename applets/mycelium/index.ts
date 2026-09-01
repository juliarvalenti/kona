import { defineApplet, text, spacer, col, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow, keyValue } from "../../sdk/components.ts";
import {
  listRooms,
  roomDetail,
  ago,
  SETUP_HINT,
  type Room,
  type RoomDetail,
  type Source,
} from "../../server/mycelium.ts";

/**
 * mycelium — a window onto the coordination layer. Rooms, the agents in them,
 * what they just said to each other, and the memory they share.
 *
 * The bimodal joke lands hardest here: YOU browse the swarm with j/k/l while an
 * AGENT calls `mycelium.rooms` / `mycelium.open` over HTTP to inspect the very
 * coordination state it is part of. Read-only — kona observes, it doesn't post.
 */

interface MyceliumState {
  rooms: Room[];
  cursor: number;
  open: RoomDetail | null;
  query: string;
  loading: boolean;
  error: string | null;
  source: Source;
  syncedAt: number;
}

const ACCENT = "#a586ff"; // spore violet
const LIVE = "#00d488";
const FG = "#d0d0d0";
const DIM = "#6a6a6a";
const AMBER = "#f0b000";

const REFRESH_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;

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

async function loadRooms(state: MyceliumState, emit: () => void) {
  if (inFlight) return;
  inFlight = true;
  state.loading = true;
  emit();
  try {
    const { rooms, source } = await listRooms();
    state.rooms = rooms;
    state.source = source;
    state.error = null;
    state.cursor = Math.min(state.cursor, Math.max(0, visible(state).length - 1));
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
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
}

export default defineApplet<MyceliumState>({
  id: "mycelium",
  title: "Mycelium",
  summary: "The coordination layer — rooms, agents, and what they share.",
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
      return { rooms: state.rooms.length, source: state.source, error: state.error };
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

    back(_args, { state, emit }) {
      state.open = null;
      emit();
    },

    /** Filter rooms by name, topic, or a member agent. */
    async search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "");
      state.open = null;
      state.cursor = 0;
      emit();
      return { query: state.query, matches: visible(state).length };
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
    void loadRooms(state, emit);
  },

  // Poll on the schedule loadRooms sets (10s healthy, exponential to 5min while
  // the backend is missing or erroring).
  tickMs: 2000,
  tick({ state, emit }) {
    if (inFlight || Date.now() < nextAt) return;
    nextAt = Date.now() + REFRESH_MS; // tentative; loadRooms sets the real time
    void loadRooms(state, emit);
    if (state.open) void loadDetail(state, state.open.room.id, emit);
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
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

    // One room, drilled into.
    if (state.open) {
      const d = state.open;
      // "planner (thinking), coder" — status when the backend reports one.
      const present = d.agents.length
        ? d.agents.map((a) => (a.status ? `${a.name} (${a.status})` : a.name))
        : d.room.agents;
      const nodes: ViewNode[] = [
        text(d.room.name, { color: ACCENT }),
        ...(d.room.topic ? [text(d.room.topic, { dim: true })] : []),
        keyValue("agents", present.length ? present.join(", ") : "none present", {
          color: present.length ? LIVE : DIM,
        }),
        divider(W - 1),
      ];

      if (!d.messages.length) {
        nodes.push(text("(no messages yet)", { dim: true }));
      }
      for (const m of d.messages) {
        nodes.push(
          recordRow(
            [
              { text: m.from, width: Math.min(16, Math.floor(W * 0.2)) },
              { text: m.text, grow: true },
              { text: ago(m.at), width: 5, align: "right" },
            ],
            { width: W, color: FG },
          ),
        );
      }

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
      : text(`${rows.length} room${rows.length === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : ""}${via}${synced}`, {
          dim: true,
        });

    const nodes: ViewNode[] = [header, divider(W - 1)];
    if (state.error) nodes.push(text(state.error.slice(0, W - 2), { color: AMBER }));

    if (!rows.length && !state.loading) {
      nodes.push(text(state.query ? "(no rooms match — press / to change the filter)" : "(no active rooms)", { dim: true }));
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
