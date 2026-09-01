import { theme } from "../core/config.ts";

/**
 * The page the browser lands on at the end of `kona login <provider>`.
 *
 * Every OAuth flow in here ends the same way: the provider redirects to a
 * loopback URL this process is listening on, we grab the code (or the error)
 * and the human is left staring at whatever that handler returned. Four
 * providers had grown four copies of the same bare sentence, so the last thing
 * you saw before flipping back to the terminal was a printer test page.
 *
 * One page, three outcomes, no assets and no network: the tab is talking to a
 * server that stops listening a few hundred milliseconds later, so everything
 * — palette, art, the auto-close — has to be in the bytes it already has.
 */

/** Who the human just signed in to, and how they'd retry. */
export interface CallbackProvider {
  /** Display name, as the service calls itself: "Google", "Spotify". */
  name: string;
  /** The `kona login <id>` id that started this: "gmail", "spotify". */
  login: string;
}

/**
 * `ok` — code in hand, `failed` — the provider said no (or the human did),
 * `waiting` — anything else that hits the loopback server (a favicon probe,
 * a stray refresh) while we're still waiting for the redirect.
 */
export type CallbackOutcome = "ok" | "failed" | "waiting";

/** Rotates so signing in twice doesn't feel like the same printout. */
const ALOHA: [greeting: string, mark: string][] = [
  ["aloha", "🌺"],
  ["e komo mai", "🌺"],
  ["mahalo", "🌴"],
  ["a hui hou", "🌊"],
  ["hang loose", "🤙"],
];

/**
 * Figlet-standard "kona". A wordmark you can select and paste, which is more
 * than a logo file would give you.
 */
const WORDMARK = [
  String.raw` _`,
  String.raw`| | _____  _ __   __ _`,
  // The one glyph that can't sit in a raw template: figlet's "a" carries a backtick.
  String.raw`| |/ / _ \| '_ \ / _` + "` |",
  String.raw`|   < (_) | | | | (_| |`,
  String.raw`|_|\_\___/|_| |_|\__,_|`,
].join("\n");

/** A sun, a palm and some surf — the whole reason we're here. */
const SURF = String.raw`
  \ | /              \\|//
   -O-              --\|/--
  / | \                ||
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`.slice(1);

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
}

interface Copy {
  /** The tab title — often all you see of this page in a tab strip. */
  title: string;
  /** The headline, with the provider's name already escaped into it. */
  line: string;
  hint: string;
  /** Only the happy path gets out of the way on its own. */
  autoClose: boolean;
}

function copy(provider: CallbackProvider, outcome: CallbackOutcome): Copy {
  const name = esc(provider.name);
  switch (outcome) {
    case "ok":
      return {
        title: `kona — signed in to ${provider.name}`,
        line: `✅ signed in to <b>${name}</b>`,
        hint: "you can close this tab and go back to kona",
        autoClose: true,
      };
    case "failed":
      return {
        title: `kona — ${provider.name} sign-in failed`,
        line: `🌊 auth didn't go through`,
        hint: `run <code>kona login ${esc(provider.login)}</code> again`,
        autoClose: false,
      };
    case "waiting":
      return {
        title: `kona — waiting for ${provider.name}`,
        line: `⏳ waiting for <b>${name}</b>…`,
        hint: "finish signing in over on the provider's tab",
        autoClose: false,
      };
  }
}

/**
 * The whole page as one self-contained string. Colors come from the user's
 * `[theme]` block, so retheming kona reaches the browser too; only the light
 * scheme carries literals of its own, because a terminal palette has no light
 * side to borrow.
 */
export function callbackHtml(
  provider: CallbackProvider,
  outcome: CallbackOutcome = "ok",
  detail?: string,
): string {
  const t = theme();
  const c = copy(provider, outcome);
  const accent = outcome === "failed" ? t.error : outcome === "ok" ? t.ok : t.warn;
  const [greeting, mark] = ALOHA[Math.floor(Math.random() * ALOHA.length)]!;
  const why = detail?.trim() ? `<p class="why">${esc(detail.trim())}</p>` : "";

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)}</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: ${t.bg};
    --panel: ${t.panel};
    --fg: ${t.fg};
    --dim: ${t.dim};
    --muted: ${t.muted};
    --accent: ${accent};
    --alt: ${t.alt};
    --line: ${t.field};
  }
  @media (prefers-color-scheme: light) {
    :root {
      /* Sand and ink: the one thing a terminal palette has nothing to say about.
         The roles keep their hue and just take enough ink to stay readable. */
      --bg: #fdf6ec;
      --panel: #fffdf8;
      --fg: #26221c;
      --dim: #6b6257;
      --muted: #8d8478;
      --line: #ece2d2;
      --accent: color-mix(in srgb, ${accent} 68%, #1c1917);
      --alt: color-mix(in srgb, ${t.alt} 55%, #1c1917);
    }
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem 1rem;
    background: radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--accent) 12%, var(--bg)), var(--bg));
    color: var(--fg);
    font: 15px/1.6 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  main {
    width: min(34rem, 100%);
    padding: 2rem 1.75rem 1.5rem;
    text-align: center;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 18px 50px -30px rgba(0, 0, 0, 0.85);
  }
  pre { margin: 0; font: inherit; white-space: pre; overflow-x: auto; }
  .wordmark {
    display: inline-block;
    text-align: left;
    font-size: clamp(10px, 3vw, 15px);
    line-height: 1.15;
    color: var(--alt);
  }
  .surf {
    display: inline-block;
    margin-top: 1.25rem;
    font-size: clamp(8px, 2.4vw, 12px);
    line-height: 1.2;
    color: var(--muted);
  }
  .greeting {
    margin: 0.35rem 0 1.5rem;
    color: var(--dim);
    letter-spacing: 0.18em;
    text-transform: lowercase;
  }
  .status { margin: 0; font-size: 1.15rem; color: var(--accent); }
  .status b { color: var(--fg); font-weight: 600; }
  .hint { margin: 0.6rem 0 0; color: var(--dim); }
  .why { margin: 0.4rem 0 0; color: var(--muted); font-size: 0.85rem; word-break: break-word; }
  code {
    padding: 0.1rem 0.4rem;
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--fg);
  }
  .closing { display: none; }
  body.autoclose .closing { display: block; }
  body.stuck .closing { display: none; }
  @keyframes sway { 50% { transform: translateY(-3px) rotate(-9deg); } }
  .lei { display: inline-block; animation: sway 2.6s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .lei { animation: none; } }
</style>
<main>
  <pre class="wordmark" aria-label="kona">${esc(WORDMARK)}</pre>
  <p class="greeting">${esc(greeting)} <span class="lei">${mark}</span></p>
  <p class="status">${c.line}</p>
  <p class="hint">${c.hint}</p>
  ${why}
  ${c.autoClose ? `<p class="hint closing">closing this tab in a moment…</p>` : ""}
  <pre class="surf" aria-hidden="true">${esc(SURF)}</pre>
</main>
${
  c.autoClose
    ? `<script>
  document.body.classList.add("autoclose");
  setTimeout(function () {
    window.close();
    // A tab kona didn't open itself can refuse: fall back to asking nicely.
    setTimeout(function () { document.body.classList.add("stuck"); }, 400);
  }, 2000);
</script>`
    : ""
}
</html>
`;
}

/** The same page, ready to return from a loopback `fetch` handler. */
export function callbackPage(
  provider: CallbackProvider,
  outcome: CallbackOutcome = "ok",
  detail?: string,
): Response {
  return new Response(callbackHtml(provider, outcome, detail), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
