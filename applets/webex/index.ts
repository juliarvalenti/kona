import {
  defineApplet,
  text,
  spacer,
  col,
  row,
  input,
  theme,
  appletAccent,
  appletNumber,
  type ViewNode,
} from "../../sdk/index.ts";
import { divider, recordRow, keyValue } from "../../sdk/components.ts";
import { renderMarkdown } from "../../sdk/markdown.ts";
import { notify, freshIds } from "../../server/notify.ts";
import {
  listSpaces,
  listMessages,
  postMessage,
  me as whoami,
  readSeen,
  markSeen,
  isUnread,
  unreadCount,
  ago,
  presence as fetchPresence,
  lookupPerson,
  SETUP_HINT,
  type Space,
  type Message,
  type SeenMap,
  type Presence,
} from "../../server/webex.ts";

/**
 * webex — your spaces in the terminal, and one verb that talks back.
 *
 * Three levels, browser-like: the space list, one space's messages, and one
 * message read in full. → drills in, ← backs out. A row in a conversation is
 * one line however much was said, so the reader is where a long message
 * actually gets read — rendered through the shared markdown primitive, because
 * that is what Webex messages are written in.
 *
 * The bimodal seam is the interesting part: `post` is ONE verb with two
 * callers. You press `c`, type into the field and hit enter; an agent posts
 * `{"space":"ship-kona","text":"deploy is green"}` with no terminal in sight.
 * Neither the applet nor Webex can tell which happened. The reader is the same
 * shape — `open {"space":"ship-kona","message":"m3"}` hands an agent the whole
 * body that the human is looking at.
 *
 * Read-only plus post, as the issue scopes it: calls and meetings are not here.
 */

/** How many spaces to list, and how many messages to read per space. */
const SPACES = Math.max(1, Math.min(100, Math.round(appletNumber("webex", "spaces", 25))));
const PAGE = Math.max(1, Math.min(100, Math.round(appletNumber("webex", "page", 30))));

/** Webex's teal, retintable with `[applets.webex] accent`. Everything else is a role. */
const BRAND = "#00cfa0";
const palette = () => {
  const t = theme();
  return { ACCENT: appletAccent("webex", BRAND), FG: t.fg, DIM: t.dim, AMBER: t.warn, RED: t.error, UNREAD: t.ok };
};

interface WebexState {
  spaces: Space[];
  cursor: number;
  open: { space: Space; messages: Message[] } | null;
  /** Cursor over the OPEN space's messages — the row → reads. */
  mcursor: number;
  /** The message the reader is showing, by id. A space is always open under it. */
  reading: string | null;
  /** spaceId -> the activity timestamp we have read up to. */
  seen: SeenMap;
  /** personId -> whether Webex thinks they are around. The dots come from here. */
  presence: Record<string, Presence>;
  /** spaceId -> the other person in a 1:1, once we know who that is. */
  dm: Record<string, string>;
  unread: number;
  query: string;
  /** True while the compose field owns the keyboard. */
  composing: boolean;
  draft: string;
  loading: boolean;
  error: string | null;
  authed: boolean;
  me: string;
  /** Our own person id — the one presence we never need to ask about. */
  meId: string;
  syncedAt: number;
  /** Last post, echoed under the composer so a send is visibly acknowledged. */
  sent: string | null;
}

// Poll schedule. Spaces are one cheap call, but a missing credential should not
// be retried every two seconds, so failures back off exponentially.
const REFRESH_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;
let nextAt = 0;
let backoff = 0;
let inFlight = false;

/** Spaces matching the current filter (title only — that's what you can see). */
function visible(state: WebexState): Space[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.spaces;
  return state.spaces.filter((s) => s.title.toLowerCase().includes(q));
}

/** The message the cursor is on, if a space is open. */
function selectedMessage(state: WebexState): Message | null {
  return state.open?.messages[state.mcursor] ?? null;
}

/** The message the reader is showing — null unless one is open AND still there. */
function readingMessage(state: WebexState): Message | null {
  if (!state.reading || !state.open) return null;
  return state.open.messages.find((m) => m.id === state.reading) ?? null;
}

/**
 * Resolve a message the way `findSpace` resolves a space: by id, by row index,
 * or by what it says (substring, case-insensitive) — and, with nothing named at
 * all, whatever the cursor is on, which is what a keypress means.
 */
function findMessage(state: WebexState, args: Record<string, unknown>): Message | null {
  const messages = state.open?.messages ?? [];
  const want = args.message ?? args.messageId ?? args.id ?? args.index;
  if (typeof want === "number") return messages[want] ?? null;
  if (typeof want === "string" && want.trim()) {
    const q = want.trim().toLowerCase();
    return (
      messages.find((m) => m.id === want) ??
      messages.find((m) => m.text.toLowerCase().includes(q)) ??
      messages.find((m) => m.body.toLowerCase().includes(q)) ??
      null
    );
  }
  return selectedMessage(state);
}

/**
 * Move the message cursor. The reader FOLLOWS it, so ↑/↓ pages through the
 * conversation from inside a message exactly as it moves the highlight from
 * outside one — one selection, two views of it.
 */
function moveMessage(state: WebexState, delta: number, emit: () => void) {
  const messages = state.open?.messages ?? [];
  if (!messages.length) return { message: null };
  state.mcursor = Math.min(messages.length - 1, Math.max(0, state.mcursor + delta));
  const m = messages[state.mcursor]!;
  if (state.reading) state.reading = m.id;
  emit();
  return { message: m.id, from: m.from, index: state.mcursor, reading: !!state.reading };
}

/**
 * Open the reader on a message. The return value is the whole body, not a
 * summary: an agent asking to read the last message in a space gets the same
 * text the human is now looking at, in one call.
 */
function openReader(state: WebexState, args: Record<string, unknown>, emit: () => void) {
  const m = findMessage(state, args);
  if (!m) return { error: state.open?.messages.length ? "no such message" : "no messages to read" };
  state.mcursor = state.open!.messages.indexOf(m);
  state.reading = m.id;
  state.composing = false;
  emit();
  return {
    message: m.id,
    space: state.open!.space.title,
    from: m.from,
    at: m.at,
    ago: ago(m.at),
    files: m.files,
    text: m.body,
  };
}

/** "14:32" today, "1 Sep 14:32" before that — the reader's timestamp. */
function stamp(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  const now = new Date();
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${time}`;
}

// Spaces we have already bannered, keyed by space + activity so each new burst
// of chatter announces once. null until the first load: signing in shouldn't
// banner every space that was already waiting.
let announced: Set<string> | null = null;

function announce(spaces: Space[], seen: SeenMap) {
  const unread = spaces.filter((s) => isUnread(s, seen));
  const { seen: next, fresh } = freshIds(announced, unread.map((s) => `${s.id}:${s.lastActivity}`));
  announced = next;
  if (!fresh.length) return;
  const rows = fresh.map((k) => unread.find((s) => `${s.id}:${s.lastActivity}` === k)!).filter(Boolean);
  if (rows.length > 3) {
    void notify({
      event: "webex.message",
      title: "Webex",
      body: `${rows.length} spaces have new messages`,
      key: `webex.message:batch:${rows.length}:${rows[0]!.id}`,
    });
    return;
  }
  for (const s of rows) {
    void notify({
      event: "webex.message",
      title: "Webex",
      body: `New messages in ${s.title}`,
      key: `webex.message:${s.id}:${s.lastActivity}`,
      dedupeMs: 6 * 3_600_000, // one banner per burst, not one per re-sync
    });
  }
}

function recount(state: WebexState) {
  state.unread = unreadCount(state.spaces, state.seen);
}

// Presence rides its own, slower schedule than the space list: it is one call
// for everyone on screen, and nobody's status changes fast enough to be worth
// a poll every 30 seconds.
const PRESENCE_MS = 60_000;
let presenceAt = 0;
let presenceInFlight = false;

/** Everyone we would draw a dot for: the people we DM, and the open space's authors. */
function watched(state: WebexState): string[] {
  const ids = new Set(Object.values(state.dm));
  for (const m of state.open?.messages ?? []) if (m.personId && m.personId !== state.meId) ids.add(m.personId);
  ids.delete(state.meId);
  return [...ids].filter(Boolean);
}

/**
 * Refresh the dots. Presence is a nicety — another org, a person who turned
 * status sharing off, a lookup that fails — so every path here ends in "no
 * dot" rather than in an error on screen. The only thing it may never do is
 * make the space list look broken.
 */
async function loadPresence(state: WebexState, emit: () => void, force = false) {
  if (presenceInFlight) return;
  // Off the schedule for somebody NEW — a space just opened, a stranger just
  // spoke — because a face with no dot beside it reads as "offline".
  const unknown =
    state.spaces.some((s) => s.kind === "direct" && !state.dm[s.id]) ||
    watched(state).some((id) => !state.presence[id]);
  if (!force && !unknown && Date.now() < presenceAt) return;
  presenceInFlight = true;
  try {
    // A 1:1 carries no person id, so we have to work out who it is with. An
    // open space hands us that for free (whoever wrote the messages); for the
    // rest, the title is their display name and the directory knows it. One
    // lookup per unmatched DM, in parallel — after the first pass they are all
    // remembered.
    const unmatched = state.spaces.filter((s) => s.kind === "direct" && !state.dm[s.id]);
    await Promise.all(
      unmatched.map(async (space) => {
        const p = await lookupPerson(space.title);
        if (p) state.dm[space.id] = p.id;
      }),
    );
    const ids = watched(state);
    if (ids.length) {
      for (const [id, p] of await fetchPresence(ids, force ? 0 : PRESENCE_MS)) state.presence[id] = p;
    }
  } catch {
    /* the dots just don't appear */
  } finally {
    presenceInFlight = false;
    presenceAt = Date.now() + PRESENCE_MS;
    emit();
  }
}

/** The presence to draw beside a space — a 1:1's counterpart, or nobody. */
function spacePresence(state: WebexState, space: Space): Presence | null {
  if (space.kind !== "direct") return null;
  const id = state.dm[space.id];
  return (id && state.presence[id]) || null;
}

/** `●` around, `○` idle, a blank when Webex won't say. */
function dot(p: Presence | null): string {
  return p?.status === "active" ? "●" : p?.status === "idle" ? "○" : " ";
}

/** "active now" / "last seen 12m ago" — empty when there is nothing to claim. */
function seenLine(p: Presence | null): string {
  if (!p?.status) return "";
  if (p.status === "active") return "active now";
  const since = ago(p.lastActivity);
  return since ? `last seen ${since} ago` : "idle";
}

/**
 * The list's status column. A dot on its own can't say whether it means unread
 * or present — the two markers sit near each other — so in a 1:1 this column
 * spells the same answer out, and carries the last-seen time while it is at it.
 */
function statusCell(space: Space, p: Presence | null): string {
  if (space.kind !== "direct") return "space";
  if (!p?.status) return "direct";
  if (p.status === "active") return "active";
  const since = ago(p.lastActivity);
  return since ? `seen ${since}` : "idle";
}

async function loadSpaces(state: WebexState, emit: () => void) {
  if (inFlight) return;
  inFlight = true;
  state.loading = true;
  emit();
  try {
    state.spaces = await listSpaces(SPACES);
    state.seen = readSeen();
    state.authed = true;
    state.error = null;
    recount(state);
    announce(state.spaces, state.seen);
    state.cursor = Math.min(state.cursor, Math.max(0, visible(state).length - 1));
    backoff = 0;
    nextAt = Date.now() + REFRESH_MS;
    if (!state.me) {
      try {
        const who = await whoami();
        state.me = who.displayName;
        state.meId = who.id;
      } catch {
        /* a name is a nicety */
      }
    }
    emit(); // paint the spaces before going off to ask who is around
    await loadPresence(state, emit);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.error = msg;
    if (/signed in|credential|not configured/i.test(msg)) state.authed = false;
    backoff = backoff ? Math.min(backoff * 2, BACKOFF_MAX_MS) : REFRESH_MS;
    nextAt = Date.now() + backoff;
  } finally {
    inFlight = false;
    state.loading = false;
    state.syncedAt = Date.now();
    emit();
  }
}

/** Load a space's messages and mark it read up to its newest message. */
async function loadSpace(state: WebexState, space: Space, emit: () => void) {
  state.loading = true;
  // Re-reading the space we already have open must not move the human's place
  // in it, so remember the selection by id: a poll that brings two new messages
  // shifts every index, and an id doesn't.
  const held = state.open?.space.id === space.id ? (state.reading ?? selectedMessage(state)?.id) : null;
  emit();
  try {
    const messages = await listMessages(space.id, PAGE);
    state.open = { space, messages };
    // A conversation is read from the bottom: a space opens on its newest
    // message, and a reload lands back on the one we were holding.
    const at = held ? messages.findIndex((m) => m.id === held) : -1;
    state.mcursor = at >= 0 ? at : Math.max(0, messages.length - 1);
    // Reading something Webex no longer has (deleted, or off the end of the
    // page) drops you back to the conversation rather than to a blank frame.
    if (state.reading && at < 0) state.reading = null;
    // Read up to the newest thing we actually saw — the last message, or the
    // room's own activity stamp when the space is empty.
    const upTo = messages[messages.length - 1]?.at ?? space.lastActivity;
    state.seen = markSeen(space.id, Math.max(upTo, space.lastActivity));
    // Whoever else spoke here IS the other half of a 1:1 — an exact answer,
    // where the directory lookup is only a good guess at a display name.
    if (space.kind === "direct") {
      const them = messages.find((m) => m.personId && m.personId !== state.meId)?.personId;
      if (them) state.dm[space.id] = them;
    }
    recount(state);
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
  await loadPresence(state, emit);
}

/** Resolve an agent's `space` argument: an id, or a title (substring, case-insensitive). */
function findSpace(state: WebexState, want: unknown): Space | null {
  if (typeof want !== "string" || !want.trim()) return null;
  const q = want.trim().toLowerCase();
  return (
    state.spaces.find((s) => s.id === want) ??
    state.spaces.find((s) => s.title.toLowerCase() === q) ??
    state.spaces.find((s) => s.title.toLowerCase().includes(q)) ??
    null
  );
}

/**
 * The space a verb acts on. A NAMED space must resolve: an agent that misspells
 * a room gets an error, never a message posted into whatever row the cursor
 * happened to be sitting on. Only when no name was given do we fall back to the
 * selection (which is what a keypress means).
 */
function targetSpace(
  state: WebexState,
  args: Record<string, unknown>,
  fallback: Space | null | undefined,
): { space: Space; error?: undefined } | { space?: undefined; error: string } {
  const want = args.space ?? args.room ?? args.title;
  if (typeof want === "string" && want.trim()) {
    const found = findSpace(state, want);
    return found ? { space: found } : { error: `no such space: ${want}` };
  }
  return fallback ? { space: fallback } : { error: "no such space" };
}

export default defineApplet<WebexState>({
  id: "webex",
  title: "Webex",
  summary: "Spaces, their messages, and a verb that posts back.",
  icon: "◎",
  tint: BRAND,
  labels: ["chat", "network"],
  requires: ["a Webex token or OAuth client: `kona login webex`"],
  auth: { webex: () => import("../../server/webex.ts") },
  notifications: {
    "webex.message": { summary: "a Webex space gets new messages", default: false },
  },
  configSample: `[applets.webex]
spaces = 25          # how many spaces to list
page   = 30          # messages per space`,
  ephemeral: true, // messages live in RAM; only read receipts touch disk
  initialState: {
    spaces: [],
    cursor: 0,
    open: null,
    mcursor: 0,
    reading: null,
    seen: {},
    presence: {},
    dm: {},
    unread: 0,
    query: "",
    composing: false,
    draft: "",
    loading: false,
    error: null,
    authed: false,
    me: "",
    meId: "",
    syncedAt: 0,
    sent: null,
  },

  docs: {
    refresh: "Re-read the space list, the unread count and who is around.",
    search: { doc: "Filter the space list by title — local, no refetch.", args: { q: "ship" } },
    open: {
      doc: "Drill in one level: a space by name (or `index`), then a message by id, `index` or what it says — `{space, message}` does both at once, and a bare call from inside a space reads the newest. Returns the whole body; `back` climbs out again.",
      args: { space: "ship-kona", message: "m3" },
    },
    post: { doc: "Post a message. Names the space, so nothing needs to be open.", args: { space: "ship-kona", text: "deploy is green" } },
    read: { doc: "Mark a space read — or every space with `{\"all\":true}`.", args: { space: "ship-kona" } },
    presence: {
      doc: "Is this person around? `active`/`idle` plus when Webex last saw them; no args lists everyone we watch.",
      args: { person: "Grace Hopper" },
    },
    compose: "Give the compose field the keyboard (agents call `post` instead).",
    cancel: "Drop the draft and leave the composer.",
  },

  recipes: [
    {
      title: "Read me the last message in ship-kona",
      steps: [
        `kona call webex open '{"space":"ship-kona"}'`,
        `kona call webex open`,
        `kona call webex up`,
      ],
      note: "A space opens on its newest message, so a bare `open` reads that one in full — markdown and all, never truncated. `up` walks back through the conversation without leaving the reader; `back` leaves it.",
    },
    {
      title: "Is Grace around before I ping her?",
      steps: [
        `kona call webex presence '{"person":"Grace Hopper"}'`,
        `kona call webex post '{"space":"Grace Hopper","text":"got a minute?"}'`,
      ],
      note: "Presence is same-org and coarse: `active`/`idle`, or `unknown` when Webex won't say.",
    },
  ],

  verbs: {
    async refresh(_args, { state, emit }) {
      await loadSpaces(state, emit);
      if (state.open) {
        const fresh = state.spaces.find((s) => s.id === state.open!.space.id) ?? state.open.space;
        await loadSpace(state, fresh, emit);
      }
      return {
        spaces: state.spaces.length,
        unread: state.unread,
        authed: state.authed,
        active: Object.values(state.presence).filter((p) => p.status === "active").length,
      };
    },

    /** Filter the space list by title. */
    search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "");
      state.open = null;
      state.reading = null;
      state.mcursor = 0;
      state.cursor = 0;
      emit();
      return { query: state.query, matches: visible(state).length };
    },

    /**
     * Drill in one level. `open` means "the space under the cursor" from the
     * list and "the message under the cursor" from inside a space, so → is one
     * key all the way down and a bare call from an agent does the same thing.
     *
     * Named, it skips the levels: `{"space":"ship-kona"}` opens that space,
     * `{"message":"m3"}` reads that message, and the two together do both in
     * one call. `index` is the row the mouse clicked — a space from the list,
     * a message from inside one.
     */
    async open(args, { state, emit }) {
      const named = args.space ?? args.room ?? args.title;
      const wantsSpace = typeof named === "string" && !!named.trim();

      // Already inside a space, and not being sent to another one: this is the
      // reader.
      if (state.open && !wantsSpace) return openReader(state, args, emit);

      const rows = visible(state);
      const { space: target, error } = targetSpace(state, args, rows[typeof args.index === "number" ? args.index : state.cursor]);
      if (!target) return { error };
      const idx = rows.findIndex((s) => s.id === target.id);
      if (idx >= 0) state.cursor = idx;
      state.reading = null;
      await loadSpace(state, target, emit);
      if (!state.open) return { error: state.error };
      // `{space, message}`: an agent that knows exactly what it wants to read.
      if (args.message !== undefined || args.messageId !== undefined) return openReader(state, args, emit);
      return { space: state.open.space.title, id: state.open.space.id, messages: state.open.messages.length };
    },

    /** Back out one level: the open message, then the space, then the launcher. */
    back(_args, { state, emit }) {
      if (state.reading) {
        state.reading = null;
        emit();
        return { at: "space", space: state.open?.space.title };
      }
      state.open = null;
      state.mcursor = 0;
      state.composing = false;
      state.draft = "";
      state.sent = null;
      emit();
      return { at: "spaces" };
    },

    /** Give the compose field the keyboard (`c`). Agents skip straight to `post`. */
    compose(_args, { state, emit }) {
      if (!state.open) return { error: "open a space first" };
      state.composing = true;
      state.reading = null; // you write to the space, not into the message you were reading
      state.sent = null;
      emit();
      return { composing: true, space: state.open.space.title };
    },

    /** Esc out of the composer without sending. */
    cancel(_args, { state, emit }) {
      state.composing = false;
      state.draft = "";
      emit();
      return { composing: false };
    },

    /**
     * Post a message. The host sends `{ value }` from the compose field; an
     * agent sends `{ text, space }` and needn't have anything open. Same verb.
     */
    async post(args, { state, emit }) {
      const body = String(args.text ?? args.message ?? args.value ?? args.q ?? "").trim();
      const { space: target, error } = targetSpace(state, args, state.open?.space);
      if (!target) return { error: error === "no such space" ? "no space to post to" : error };
      if (!body) return { posted: false, error: "empty message" };

      state.composing = false;
      state.draft = "";
      state.loading = true;
      emit();
      try {
        await postMessage(target.id, body);
        state.sent = body;
        state.error = null;
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
        state.loading = false;
        emit();
        return { posted: false, error: state.error };
      }
      state.loading = false;
      emit();
      // Our own message is the newest activity; reload so it appears and the
      // space doesn't come back unread because of something we just said.
      if (state.open?.space.id === target.id) await loadSpace(state, target, emit);
      else state.seen = markSeen(target.id);
      recount(state);
      emit();
      return { posted: true, space: target.title, text: body };
    },

    /** Mark a space (or every space) read without opening it. */
    read(args, { state, emit }) {
      if (args.all === true || args.space === "all") {
        for (const s of state.spaces) state.seen = markSeen(s.id, Math.max(s.lastActivity, 1));
        recount(state);
        emit();
        return { read: state.spaces.map((s) => s.title), unread: state.unread };
      }
      const { space, error } = targetSpace(state, args, visible(state)[state.cursor]);
      if (!space) return { error };
      const targets = [space];
      for (const s of targets) state.seen = markSeen(s.id, Math.max(s.lastActivity, 1));
      recount(state);
      emit();
      return { read: targets.map((s) => s.title), unread: state.unread };
    },

    /**
     * Who is around. `{"person":"Grace"}` answers "is Grace online?" — for
     * someone we DM, for anyone in the space that is open, and, failing both,
     * for whoever the org directory says that name is. No argument answers for
     * everyone we are watching.
     */
    async presence(args, { state, emit }) {
      await loadPresence(state, emit, true);
      const want = String(args.person ?? args.who ?? args.name ?? args.q ?? "").trim().toLowerCase();
      const answer = (p: Presence) => ({
        person: p.name,
        email: p.email,
        status: p.status ?? "unknown",
        lastSeen: ago(p.lastActivity),
        at: p.lastActivity,
      });
      const known = Object.values(state.presence);
      if (!want) {
        return {
          active: known.filter((p) => p.status === "active").length,
          people: known.map(answer).sort((a, b) => b.at - a.at),
        };
      }
      const hit =
        known.find((p) => p.name.toLowerCase() === want || p.email.toLowerCase() === want) ??
        known.find((p) => p.name.toLowerCase().includes(want));
      if (hit) return answer(hit);
      // Not on screen anywhere — ask the directory before saying we don't know.
      const found = await lookupPerson(String(args.person ?? args.who ?? args.name ?? args.q ?? ""));
      if (!found) return { error: `no presence for ${want}`, status: "unknown" };
      state.presence[found.id] = found;
      emit();
      return answer(found);
    },

    // One pair of cursor verbs, two lists: spaces out here, messages inside a
    // space (where the reader, if it is open, follows along).
    up(_args, { state, emit }) {
      if (state.open) return moveMessage(state, -1, emit);
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_args, { state, emit }) {
      if (state.open) return moveMessage(state, 1, emit);
      state.cursor = Math.min(Math.max(0, visible(state).length - 1), state.cursor + 1);
      emit();
    },
  },

  init({ state, emit }) {
    nextAt = 0;
    backoff = 0;
    state.seen = readSeen();
    void loadSpaces(state, emit);
  },

  // Poll on the schedule loadSpaces sets (30s healthy, exponential to 5min
  // while the credential is missing or Webex is unhappy).
  tickMs: 5_000,
  tick({ state, emit }) {
    if (inFlight || state.composing || Date.now() < nextAt) return;
    nextAt = Date.now() + REFRESH_MS; // tentative; loadSpaces sets the real one
    void loadSpaces(state, emit);
    if (state.open) {
      const fresh = state.spaces.find((s) => s.id === state.open!.space.id) ?? state.open.space;
      void loadSpace(state, fresh, emit);
    }
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
    c: { verb: "compose", label: "write", when: (s) => !!s.open && !s.composing },
    a: { verb: "read", args: { all: true }, label: "mark all read", when: (s) => !s.open && s.unread > 0 },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "open",
    back: "back",
    backLabel: "back",
    canBack: (s) => !!s.open,
  },

  search: { verb: "search", placeholder: "filter spaces by name" },

  crumb: (s) => {
    if (!s.open) return null;
    const m = readingMessage(s);
    return m ? `${s.open.space.title}  ›  ${m.from}` : s.open.space.title;
  },

  accent(state) {
    const { ACCENT, AMBER, RED } = palette();
    if (state.error && !state.authed) return AMBER;
    if (state.error) return RED;
    return ACCENT;
  },

  /**
   * Two things this applet knows that a dashboard wants: what is waiting, and
   * who is around to answer.
   */
  dash: (s) => {
    if (!s.authed) return null;
    const { UNREAD, DIM } = palette();
    const active = Object.values(s.presence).filter((p) => p.status === "active").length;
    return [
      ...(s.unread
        ? [
            {
              id: "unread",
              priority: 45,
              text: `◇ ${s.unread} space${s.unread === 1 ? "" : "s"} with new messages`,
              note: `${s.spaces.length} total`,
              color: UNREAD,
            },
          ]
        : []),
      ...(active
        ? [
            {
              id: "presence",
              priority: 15, // ambient: nice to know, never urgent
              text: `● ${active} ${active === 1 ? "person" : "people"} active`,
              note: "on Webex",
              color: DIM,
            },
          ]
        : []),
    ];
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const { ACCENT, FG, DIM, AMBER, UNREAD } = palette();

    // Nothing to authenticate with — say exactly how to fix that.
    if (!state.authed && !state.loading && !state.spaces.length) {
      return [
        col([
          text("Not connected to Webex", { color: AMBER }),
          spacer(),
          ...SETUP_HINT.map((line) => text(line || " ", { dim: true })),
          ...(state.error ? [spacer(), text(state.error.slice(0, W - 2), { color: DIM })] : []),
        ]),
      ];
    }

    // One message, read in full. A row in the conversation is one line however
    // much was said; this is where the rest of it lives — rendered as markdown,
    // which is what Webex messages are written in, and wrapped rather than cut.
    const reading = readingMessage(state);
    if (state.open && reading) {
      const them = state.presence[reading.personId] ?? null;
      const body = renderMarkdown(reading.body, { width: W - 1, breaks: true, color: FG });
      const meta = [
        state.open.space.title,
        stamp(reading.at),
        ago(reading.at) ? `${ago(reading.at)} ago` : "",
        reading.files ? `${reading.files} attachment${reading.files === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      const who = text(reading.from, { color: reading.from === state.me ? ACCENT : FG });
      return [
        col([
          them?.status
            ? row([text(`${dot(them)} `, { color: them.status === "active" ? UNREAD : DIM }), who])
            : who,
          text(meta.join("  ·  "), { color: DIM }),
          divider(W - 1),
          spacer(),
          ...(body.length ? body : [text("(no text — attachments only)", { dim: true })]),
          spacer(),
          text("← back to the space  ·  ↑/↓ the message before or after", { dim: true }),
        ]),
      ];
    }

    // One space, drilled into.
    if (state.open) {
      const { space, messages } = state.open;
      // In a 1:1 the title IS a person, so the header answers the question the
      // space is really asking: are they there?
      const them = spacePresence(state, space);
      const seen = seenLine(them);
      const nodes: ViewNode[] = [
        them?.status
          ? row([
              text(`${dot(them)} `, { color: them.status === "active" ? UNREAD : DIM }),
              text(space.title, { color: ACCENT }),
            ])
          : text(space.title, { color: ACCENT }),
        keyValue(
          space.kind === "direct" ? "direct" : "space",
          [seen, `${messages.length} message${messages.length === 1 ? "" : "s"}`].filter(Boolean).join("  ·  "),
          { color: DIM },
        ),
        divider(W - 1),
      ];

      if (!messages.length) nodes.push(text("(no messages yet)", { dim: true }));
      const fromW = Math.min(18, Math.max(10, Math.floor(W * 0.18)));
      for (const [i, m] of messages.entries()) {
        nodes.push(
          recordRow(
            [
              { text: dot(state.presence[m.personId] ?? null), width: 1 },
              { text: m.from, width: fromW },
              { text: m.text, grow: true },
              { text: ago(m.at), width: 5, align: "right" },
            ],
            {
              width: W,
              // While the composer has the keyboard IT is the anchor: a
              // highlighted row above it would scroll the field off screen.
              selected: i === state.mcursor && !state.composing,
              accent: ACCENT,
              color: m.from === state.me ? ACCENT : FG,
              index: i,
            },
          ),
        );
      }

      // The composer. Focused, it takes every key until enter (post) or esc
      // (cancel) — which is exactly what `post` does for an agent, minus the
      // keyboard.
      nodes.push(spacer());
      if (state.composing) {
        nodes.push(
          input("compose", state.draft, {
            placeholder: `message ${space.title}…`,
            width: Math.min(W - 4, 72),
            focus: true,
            submit: "post",
            cancel: "cancel",
            color: ACCENT,
          }),
        );
      } else {
        // The selected row carries the scroll anchor (and a space opens on its
        // newest message), so the host keeps the bottom of the backlog in view
        // rather than parking at the top of it. With nothing to select — an
        // empty space — this line is the anchor instead.
        nodes.push(
          text(
            state.sent ? `sent: ${state.sent}` : "enter reads a message · c writes one · agents call webex.open",
            { dim: true, focus: !messages.length },
          ),
        );
      }
      return [col(nodes)];
    }

    // The space list.
    const rows = visible(state);
    const synced = state.syncedAt ? `  ·  ${ago(state.syncedAt)} ago` : "";
    const who = state.me ? `  ·  ${state.me}` : "";
    const header =
      state.loading && !state.spaces.length
        ? text("syncing…", { color: AMBER })
        : text(
            `${rows.length} space${rows.length === 1 ? "" : "s"}${state.query ? ` matching “${state.query}”` : ""}` +
              `${state.unread ? `  ·  ${state.unread} unread` : ""}${who}${synced}`,
            { dim: true },
          );

    const nodes: ViewNode[] = [header, divider(W - 1)];
    if (state.error) nodes.push(text(state.error.slice(0, W - 2), { color: AMBER }));

    if (!rows.length && !state.loading) {
      nodes.push(text(state.query ? "(no spaces match — press / to change the filter)" : "(no spaces)", { dim: true }));
    }

    for (const [i, s] of rows.entries()) {
      const unread = isUnread(s, state.seen);
      const them = spacePresence(state, s);
      nodes.push(
        recordRow(
          [
            { text: unread ? "●" : " ", width: 1 },
            { text: dot(them), width: 1 },
            { text: s.title, grow: true },
            { text: statusCell(s, them), width: 8 },
            { text: ago(s.lastActivity), width: 5, align: "right" },
          ],
          { width: W, selected: i === state.cursor, accent: ACCENT, color: unread ? UNREAD : FG, index: i },
        ),
      );
    }

    return [col(nodes)];
  },
});
