import {
  defineApplet,
  text,
  spacer,
  col,
  input,
  theme,
  appletAccent,
  appletNumber,
  type ViewNode,
} from "../../sdk/index.ts";
import { divider, recordRow, keyValue } from "../../sdk/components.ts";
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
  SETUP_HINT,
  type Space,
  type Message,
  type SeenMap,
} from "../../server/webex.ts";

/**
 * webex — your spaces in the terminal, and one verb that talks back.
 *
 * The list is spaces newest-first with an unread dot; → drills into a space and
 * shows its recent messages. The bimodal seam is the interesting part: `post` is
 * ONE verb with two callers. You press `c`, type into the field and hit enter;
 * an agent posts `{"space":"ship-kona","text":"deploy is green"}` with no
 * terminal in sight. Neither the applet nor Webex can tell which happened.
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
  /** spaceId -> the activity timestamp we have read up to. */
  seen: SeenMap;
  unread: number;
  query: string;
  /** True while the compose field owns the keyboard. */
  composing: boolean;
  draft: string;
  loading: boolean;
  error: string | null;
  authed: boolean;
  me: string;
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
        state.me = (await whoami()).displayName;
      } catch {
        /* a name is a nicety */
      }
    }
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
  emit();
  try {
    const messages = await listMessages(space.id, PAGE);
    state.open = { space, messages };
    // Read up to the newest thing we actually saw — the last message, or the
    // room's own activity stamp when the space is empty.
    const upTo = messages[messages.length - 1]?.at ?? space.lastActivity;
    state.seen = markSeen(space.id, Math.max(upTo, space.lastActivity));
    recount(state);
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    emit();
  }
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
    seen: {},
    unread: 0,
    query: "",
    composing: false,
    draft: "",
    loading: false,
    error: null,
    authed: false,
    me: "",
    syncedAt: 0,
    sent: null,
  },

  verbs: {
    async refresh(_args, { state, emit }) {
      await loadSpaces(state, emit);
      if (state.open) {
        const fresh = state.spaces.find((s) => s.id === state.open!.space.id) ?? state.open.space;
        await loadSpace(state, fresh, emit);
      }
      return { spaces: state.spaces.length, unread: state.unread, authed: state.authed };
    },

    /** Filter the space list by title. */
    search(args, { state, emit }) {
      state.query = String(args.q ?? args.query ?? "");
      state.open = null;
      state.cursor = 0;
      emit();
      return { query: state.query, matches: visible(state).length };
    },

    /** Drill into a space — by list index (a keypress or a click) or by id/title (an agent). */
    async open(args, { state, emit }) {
      const rows = visible(state);
      const { space: target, error } = targetSpace(state, args, rows[typeof args.index === "number" ? args.index : state.cursor]);
      if (!target) return { error };
      const idx = rows.findIndex((s) => s.id === target.id);
      if (idx >= 0) state.cursor = idx;
      await loadSpace(state, target, emit);
      return state.open
        ? { space: state.open.space.title, id: state.open.space.id, messages: state.open.messages.length }
        : { error: state.error };
    },

    back(_args, { state, emit }) {
      state.open = null;
      state.composing = false;
      state.draft = "";
      state.sent = null;
      emit();
    },

    /** Give the compose field the keyboard (`c`). Agents skip straight to `post`. */
    compose(_args, { state, emit }) {
      if (!state.open) return { error: "open a space first" };
      state.composing = true;
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
    selectLabel: "space",
    back: "back",
    backLabel: "spaces",
    canBack: (s) => !!s.open,
  },

  search: { verb: "search", placeholder: "filter spaces by name" },

  crumb: (s) => (s.open ? s.open.space.title : null),

  accent(state) {
    const { ACCENT, AMBER, RED } = palette();
    if (state.error && !state.authed) return AMBER;
    if (state.error) return RED;
    return ACCENT;
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

    // One space, drilled into.
    if (state.open) {
      const { space, messages } = state.open;
      const nodes: ViewNode[] = [
        text(space.title, { color: ACCENT }),
        keyValue(space.kind === "direct" ? "direct" : "space", `${messages.length} message${messages.length === 1 ? "" : "s"}`, { color: DIM }),
        divider(W - 1),
      ];

      if (!messages.length) nodes.push(text("(no messages yet)", { dim: true }));
      const fromW = Math.min(18, Math.max(10, Math.floor(W * 0.18)));
      for (const m of messages) {
        nodes.push(
          recordRow(
            [
              { text: m.from, width: fromW },
              { text: m.text, grow: true },
              { text: ago(m.at), width: 5, align: "right" },
            ],
            { width: W, color: m.from === state.me ? ACCENT : FG },
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
        // `focus` here is the scroll anchor, not a selection: a conversation is
        // read from the bottom, so the host keeps the newest messages (and this
        // line) in view rather than parking at the top of the backlog. While
        // composing, the focused field is the anchor instead.
        nodes.push(
          text(state.sent ? `sent: ${state.sent}` : "press c to write · agents call webex.post", {
            dim: true,
            focus: true,
          }),
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
      nodes.push(
        recordRow(
          [
            { text: unread ? "●" : " ", width: 1 },
            { text: s.title, grow: true },
            { text: s.kind === "direct" ? "direct" : "space", width: 6 },
            { text: ago(s.lastActivity), width: 5, align: "right" },
          ],
          { width: W, selected: i === state.cursor, accent: ACCENT, color: unread ? UNREAD : FG, index: i },
        ),
      );
    }

    return [col(nodes)];
  },
});
