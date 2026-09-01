import { defineApplet, text, spacer, col, theme, appletAccent, type AppletCtx, type ViewNode } from "../../sdk/index.ts";
import { divider, recordRow } from "../../sdk/components.ts";
import { openItems, type GhItem } from "../../server/github.ts";
import { notify, freshIds } from "../../server/notify.ts";
import { collectCards, ghLimit, type DashRow } from "./cards.ts";

/**
 * dash — an always-open cockpit, assembled from whatever else is installed.
 *
 * It owns almost no data. Every applet answers `dash(state)` about itself — a
 * song, a countdown, unread mail, a workflow about to fire — and the dash
 * collects those cards from the applets the daemon actually loaded
 * (`ctx.applets()` + `ctx.peek(id)`), keeps the ones that say they have
 * something LIVE, and sorts them by urgency. An applet with nothing going on
 * contributes nothing, so the board is only ever what needs you right now.
 *
 * Adding an applet with a card puts it on this screen with no edit to this
 * file. The one thing the dash fetches for itself is GitHub, below the cards.
 */

interface DashState {
  /** The contributed rows, already filtered and ordered. See ./cards.ts. */
  cards: DashRow[];
  gh: GhItem[];
  ghError: string | null;
  cursor: number; // index into the selectable targets (cards, then gh rows)
}

/** The selectable things on the dash, in render order. */
type Target = { kind: "card"; navigate: string } | { kind: "gh"; url: string };
function targets(s: DashState): Target[] {
  return [
    ...s.cards.map((c) => ({ kind: "card" as const, navigate: c.navigate })),
    ...ghRows(s).map((g) => ({ kind: "gh" as const, url: g.url })),
  ];
}

/** The GitHub rows actually drawn — density decides, and `open` agrees. */
function ghRows(s: DashState): GhItem[] {
  return s.gh.slice(0, ghLimit());
}

/**
 * The dash's own tint. It defaults to the Spotify green it has always worn, and
 * `[applets.dash] accent = "#..."` in ~/.config/kona/config.toml overrides it.
 * Everything else names a theme role — a CARD's color comes from the applet
 * that contributed it.
 */
const BRAND = "#1db954";
const palette = () => {
  const t = theme();
  return { GREEN: appletAccent("dash", BRAND), AMBER: t.warn, FG: t.fg, DIM: t.dim };
};

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

/**
 * Rebuild the board from the applets this daemon loaded. The whole aggregation
 * is now this: ask everyone, keep what's live. Nothing here names an applet.
 */
function aggregate(state: DashState, ctx: Pick<AppletCtx<DashState>, "peek" | "applets">) {
  state.cards = collectCards(ctx.applets?.() ?? [], ctx.peek ?? (() => undefined));
  state.cursor = Math.max(0, Math.min(state.cursor, Math.max(0, targets(state).length - 1)));
}

export default defineApplet<DashState>({
  id: "dash",
  title: "Dashboard",
  summary: "Live cockpit — whatever your applets say is happening right now.",
  icon: "▦",
  tint: "#7dcfff", // cockpit cyan
  labels: ["overview"],
  notifications: {
    "github.new": { summary: "a PR or issue involving you shows up", default: true },
  },
  configSample: `[applets.dash]
accent = "#1db954"
# density = "compact"        # only the cards that want something from you
# pin = ["timer", "email"]   # these first, in this order
# hide = ["weather", "timer:pomodoro"]`,
  ephemeral: true,
  initialState: { cards: [], gh: [], ghError: null, cursor: 0 },

  docs: {
    refresh: "Rebuild the board from every applet's live state, and refetch GitHub.",
    open: { doc: "Open a row: a GitHub PR/issue in the browser, or jump into the applet that contributed the card.", args: { index: 0 } },
  },

  recipes: [
    {
      title: "Ask what needs attention right now",
      steps: [
        "kona state dash",
        `kona call dash open '{"index":0}'`,
      ],
      note: "`cards` is exactly what is on the human's screen: one row per applet with something live, most urgent first.",
    },
  ],

  verbs: {
    refresh(_a, ctx) {
      aggregate(ctx.state, ctx);
      void refreshGh(ctx.state, ctx.emit);
    },
    up(_a, { state, emit }) {
      state.cursor = Math.max(0, state.cursor - 1);
      emit();
    },
    down(_a, { state, emit }) {
      state.cursor = Math.min(Math.max(0, targets(state).length - 1), state.cursor + 1);
      emit();
    },
    // open the selected target: a card jumps into the applet that contributed
    // it; a GitHub row opens the PR/issue in the browser. A mouse click passes
    // the clicked row's index — select it first, then open it.
    open(a, { state, emit }) {
      if (typeof a.index === "number") {
        state.cursor = Math.max(0, Math.min(targets(state).length - 1, a.index));
        emit();
      }
      const t = targets(state)[state.cursor];
      if (!t) return {};
      if (t.kind === "card") return { navigate: t.navigate };
      Bun.spawn(["open", t.url]);
      return { opened: t.url };
    },
  },

  init(ctx) {
    aggregate(ctx.state, ctx);
    nextGhAt = 0; // fetch on boot
    void refreshGh(ctx.state, ctx.emit);
  },

  // Cheap peeks every second (song position, countdown); GitHub on its own
  // rate-limited schedule (>=60s, 5min backoff on error).
  tickMs: 1000,
  tick(ctx) {
    aggregate(ctx.state, ctx);
    if (Date.now() >= nextGhAt && !ghInFlight) {
      nextGhAt = Date.now() + 60_000; // tentative; refreshGh sets the real time
      void refreshGh(ctx.state, ctx.emit);
    }
    ctx.emit();
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
    const { GREEN, AMBER, FG, DIM } = palette();
    const nodes: ViewNode[] = [];
    const gh = ghRows(state);

    // The contributed cards, most urgent first. Each is selectable: -> (or a
    // click) jumps into the applet that put it there.
    state.cards.forEach((card, i) => {
      nodes.push(
        recordRow(
          [
            { text: card.text, grow: true },
            ...(card.note ? [{ text: card.note, width: Math.min(14, Math.floor(W * 0.2)), align: "right" as const }] : []),
          ],
          { width: W, selected: state.cursor === i, accent: card.color, color: FG, index: i },
        ),
      );
    });

    // Nothing live anywhere, and nothing open on GitHub: say so and stop.
    if (!state.cards.length && !gh.length && !state.ghError) {
      nodes.push(text("all quiet", { color: GREEN }), text("nothing needs you right now", { dim: true }));
      return [col(nodes)];
    }

    if (!state.cards.length) nodes.push(text("all quiet across your applets", { dim: true }));

    // GitHub — the one source the dash fetches for itself. Hidden when there is
    // nothing open and nothing went wrong.
    if (gh.length || state.ghError) {
      const base = state.cards.length; // gh targets start after the cards
      nodes.push(spacer(), divider(W - 1), text(`GITHUB  ·  ${state.gh.length} open, involving you`, { color: GREEN }));
      if (state.ghError) {
        nodes.push(text(state.ghError, { color: AMBER }));
      }
      gh.forEach((n, i) => {
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
      if (state.gh.length > gh.length) {
        nodes.push(text(`  +${state.gh.length - gh.length} more`, { color: DIM }));
      }
    }

    return [col(nodes)];
  },
});
