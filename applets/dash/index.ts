import { defineApplet, text, spacer, col, row, theme, appletAccent, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow } from "../../sdk/components.ts";
import { openItems, type GhItem } from "../../server/github.ts";
import { notify, freshIds } from "../../server/notify.ts";

/**
 * dash — an always-open cockpit. It doesn't own much data of its own; it PEEKS
 * the other applets' live state (spotify, timer, email — their ticks run in the
 * daemon regardless of what's on screen) and adds GitHub notifications. Leave it
 * open and it stays current: the song, the countdown, new PRs/issues.
 */

interface DashState {
  np: { track: string; artist: string; playing: boolean; shuffle: boolean } | null;
  timer: { remaining: number; running: boolean } | null;
  unread: number;
  emailAuthed: boolean;
  gh: GhItem[];
  ghError: string | null;
  cursor: number; // index into the selectable targets (now-playing + gh rows)
}

/** The selectable things on the dash, in render order. */
type Target = { kind: "spotify" } | { kind: "gh"; url: string };
function targets(s: DashState): Target[] {
  return [...(s.np ? [{ kind: "spotify" as const }] : []), ...s.gh.map((g) => ({ kind: "gh" as const, url: g.url }))];
}

/**
 * The dash's own tint. It defaults to the Spotify green it has always worn (the
 * now-playing row is the headline), and `[applets.dash] accent = "#..."` in
 * ~/.config/kona/config.toml overrides it. Everything else names a theme role.
 */
const BRAND = "#1db954";
const palette = () => {
  const t = theme();
  return { GREEN: appletAccent("dash", BRAND), BLUE: t.accent, AMBER: t.warn, FG: t.fg, DIM: t.dim };
};

function fmt(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Which GitHub items we have already announced. null until the first fetch
// lands: a daemon boot ADOPTS whatever is open rather than bannering twelve
// PRs you already know about.
let announced: Set<string> | null = null;

/** Banner anything that appeared since the last fetch; batch a flood into one. */
function announceGh(items: GhItem[]) {
  const { seen, fresh } = freshIds(announced, items.map((i) => i.url));
  announced = seen;
  if (!fresh.length) return;
  const rows = fresh.map((url) => items.find((i) => i.url === url)!).filter(Boolean);
  if (rows.length > 3) {
    void notify({
      event: "github.new",
      title: "GitHub",
      body: `${rows.length} new items involve you`,
      key: `github.new:batch:${rows.length}:${rows[0]!.url}`,
    });
    return;
  }
  for (const r of rows) {
    void notify({
      event: "github.new",
      title: `${r.type === "PullRequest" ? "PR" : "Issue"}  ·  ${r.repo}`,
      body: r.title,
      url: r.url,
      key: r.url,
      dedupeMs: 6 * 3_600_000, // an item that drops off the list and returns stays quiet
    });
  }
}

// GitHub search is rate-limited (~30/min). Refresh at most once a minute, and
// back off for 5 min on error (rate limit) so we don't hammer it.
let nextGhAt = 0;
let ghInFlight = false;
async function refreshGh(state: DashState, emit: () => void) {
  if (ghInFlight) return;
  ghInFlight = true;
  try {
    state.gh = await openItems(12);
    state.ghError = null;
    announceGh(state.gh);
    nextGhAt = Date.now() + 60_000;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    state.ghError = /rate limit|403/i.test(m) ? "GitHub rate-limited — backing off" : m;
    nextGhAt = Date.now() + 300_000;
  } finally {
    ghInFlight = false;
    emit();
  }
}

// Pull the live bits out of the other applets' state.
function aggregate(state: DashState, peek?: (id: string) => Record<string, unknown> | undefined) {
  const sp = peek?.("spotify") as { track?: string; artist?: string; playing?: boolean; shuffle?: boolean } | undefined;
  state.np = sp?.track ? { track: sp.track, artist: sp.artist ?? "", playing: !!sp.playing, shuffle: !!sp.shuffle } : null;

  const tm = peek?.("timer") as { remaining?: number; running?: boolean } | undefined;
  state.timer = tm && ((tm.remaining ?? 0) > 0 || tm.running) ? { remaining: tm.remaining ?? 0, running: !!tm.running } : null;

  const em = peek?.("email") as { threads?: Array<{ unread?: boolean }>; authed?: boolean } | undefined;
  state.emailAuthed = !!em?.authed;
  state.unread = (em?.threads ?? []).filter((t) => t.unread).length;
}

export default defineApplet<DashState>({
  id: "dash",
  title: "Dashboard",
  summary: "Live cockpit — now playing, timer, mail, GitHub. Leave it open.",
  ephemeral: true,
  initialState: { np: null, timer: null, unread: 0, emailAuthed: false, gh: [], ghError: null, cursor: 0 },

  verbs: {
    refresh(_a, { state, emit, peek }) {
      aggregate(state, peek);
      void refreshGh(state, emit);
    },
    up(_a, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_a, { state, emit }) {
      state.cursor = Math.min(Math.max(0, targets(state).length - 1), state.cursor + 1);
      emit();
    },
    // open the selected target: now-playing jumps to the Spotify applet;
    // a GitHub row opens the PR/issue in the browser. A mouse click passes the
    // clicked row's index — select it first, then open it.
    open(a, { state, emit }) {
      if (typeof a.index === "number") {
        state.cursor = Math.max(0, Math.min(targets(state).length - 1, a.index));
        emit();
      }
      const t = targets(state)[state.cursor];
      if (!t) return {};
      if (t.kind === "spotify") return { navigate: "spotify" };
      Bun.spawn(["open", t.url]);
      return { opened: t.url };
    },
  },

  init({ state, emit, peek }) {
    aggregate(state, peek);
    nextGhAt = 0; // fetch on boot
    void refreshGh(state, emit);
  },

  // Cheap peeks every second (song position, countdown); GitHub on its own
  // rate-limited schedule (>=60s, 5min backoff on error).
  tickMs: 1000,
  tick({ state, emit, peek }) {
    aggregate(state, peek);
    if (Date.now() >= nextGhAt && !ghInFlight) {
      nextGhAt = Date.now() + 60_000; // tentative; refreshGh sets the real time
      void refreshGh(state, emit);
    }
    emit();
  },

  keymap: {
    r: { verb: "refresh", label: "refresh" },
  },

  nav: {
    up: "up",
    down: "down",
    select: "open",
    selectLabel: "open",
  },

  view(state, ctx): ViewNode[] {
    const W = Math.max(40, ctx?.width ?? 80);
    const { GREEN, BLUE, AMBER, FG, DIM } = palette();
    const nodes: ViewNode[] = [];

    // Now playing (selectable — jumps into the Spotify applet). Target 0.
    if (state.np) {
      const flags = `${state.np.playing ? "▶" : "⏸"}${state.np.shuffle ? " ⤮" : ""}`;
      nodes.push(
        recordRow(
          [
            { text: `♪ ${state.np.track} — ${state.np.artist}`, grow: true },
            { text: flags, width: 6, align: "right" },
          ],
          { width: W, selected: state.cursor === 0, accent: GREEN, color: FG, index: 0 },
        ),
      );
    } else {
      nodes.push(text("♪ nothing playing", { dim: true }));
    }

    // Timer (only when active)
    if (state.timer) {
      nodes.push(text(`⏲ ${fmt(state.timer.remaining)}${state.timer.running ? "" : "  (paused)"}`, { color: AMBER }));
    }

    // Mail
    nodes.push(
      state.emailAuthed
        ? text(`✉ ${state.unread} unread`, { color: state.unread ? BLUE : DIM })
        : text("✉ mail not connected", { dim: true }),
    );

    // GitHub
    nodes.push(spacer(), divider(W - 1), text(`GITHUB  ·  ${state.gh.length} open, involving you`, { color: GREEN }));
    if (state.ghError) {
      nodes.push(text(state.ghError, { color: AMBER }));
    } else if (!state.gh.length) {
      nodes.push(text("nothing open involving you", { dim: true }));
    } else {
      const base = state.np ? 1 : 0; // gh targets start after the now-playing row
      state.gh.forEach((n, i) => {
        nodes.push(
          recordRow(
            [
              { text: `${n.type === "PullRequest" ? "PR" : "issue"}  ${n.title}`, grow: true },
              { text: n.repo.split("/").pop() ?? n.repo, width: Math.min(18, Math.floor(W * 0.2)) },
              { text: n.age, width: 5, align: "right" },
            ],
            { width: W, selected: state.cursor === base + i, accent: GREEN, color: FG, index: base + i },
          ),
        );
      });
    }

    return [col(nodes)];
  },
});
