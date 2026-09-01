import {
  appletAccent,
  appletList,
  appletString,
  theme,
  type AnyApplet,
  type AppletState,
  type DashCard,
} from "../../sdk/index.ts";

/**
 * How the cockpit sources its rows.
 *
 * The dash used to know what a song, a countdown and an unread count were, and
 * grew a branch per applet. It doesn't any more: every applet answers
 * `dash(state)` about ITSELF (see `DashCard` in the SDK) and this file is the
 * only thing that knows there is a board at all — it asks each loaded applet,
 * keeps the cards that say they have something live, applies the human's
 * `[applets.dash]` preferences, and sorts by urgency.
 *
 * So a new applet with a `dash` card appears on the dashboard with no edit
 * here, and an applet with nothing to say costs exactly one function call.
 */

/** A card, resolved: where it came from, what to draw, where -> goes. */
export interface DashRow {
  /** The applet that contributed it. */
  applet: string;
  /** `<applet>` or `<applet>:<card id>` — what `hide`/`pin` name. */
  key: string;
  text: string;
  note: string;
  color: string;
  priority: number;
  /** Applet the row jumps into. */
  navigate: string;
}

/** A card with no opinion about urgency sits with the ambient stuff. */
const DEFAULT_PRIORITY = 20;

/**
 * `compact` keeps only the cards that want something from you — the urgent
 * half — and trims the GitHub list; `full` (the default) shows everything live.
 */
export type Density = "full" | "compact";
const COMPACT_FLOOR = 40;
const GH_ROWS = { full: 12, compact: 5 } as const;

export function density(): Density {
  return appletString("dash", "density", "full") === "compact" ? "compact" : "full";
}

/** How many GitHub rows the board draws. Read by the view AND by `open`, so a
 * click can never land on a row the density hid. */
export function ghLimit(): number {
  return GH_ROWS[density()];
}

/**
 * Ask every loaded applet what it has to say, and order the answers.
 *
 * Nothing here is applet-specific: `applets` is whatever the daemon loaded
 * (`ctx.applets()`), `peek` is that applet's own live state, and a card that
 * throws costs its applet a row rather than taking the cockpit down with it.
 */
export function collectCards(
  applets: AnyApplet[],
  peek: (id: string) => AppletState | undefined,
): DashRow[] {
  const hidden = new Set(appletList("dash", "hide"));
  const pinned = appletList("dash", "pin");
  const floor = density() === "compact" ? COMPACT_FLOOR : -Infinity;
  const fg = theme().fg;
  const rows: DashRow[] = [];

  for (const a of applets) {
    if (!a.dash) continue;
    const state = peek(a.id);
    if (!state) continue;
    let cards: Array<DashCard | null | undefined>;
    try {
      const out = a.dash(state);
      cards = Array.isArray(out) ? out : [out];
    } catch {
      continue;
    }
    for (const card of cards) {
      // `show: false` and a null card are the same sentence: nothing is live.
      if (!card || card.show === false || !card.text) continue;
      const key = card.id ? `${a.id}:${card.id}` : a.id;
      if (hidden.has(key) || hidden.has(a.id)) continue;
      const priority = Number.isFinite(card.priority) ? card.priority! : DEFAULT_PRIORITY;
      if (priority < floor) continue;
      rows.push({
        applet: a.id,
        key,
        text: card.text,
        note: card.note ?? "",
        // A row wears its applet's brand, so the board reads as contributed.
        color: card.color ?? appletAccent(a.id, a.tint ?? fg),
        priority,
        navigate: card.navigate ?? a.id,
      });
    }
  }

  // Pinned first, in the order they were pinned; then urgency; then the key, so
  // two equally calm cards don't swap places every tick.
  const rank = (r: DashRow) => {
    const i = pinned.indexOf(r.key);
    return i >= 0 ? i : pinned.indexOf(r.applet) >= 0 ? pinned.indexOf(r.applet) : pinned.length;
  };
  return rows.sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || a.key.localeCompare(b.key));
}
