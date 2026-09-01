import type { AnyApplet } from "../sdk/index.ts";
import { toolsForApplet } from "../sdk/index.ts";
import { appletSection, recipeBlock } from "./skill.ts";

/**
 * "Copy prompt" — the on-demand sibling of the generated skill.
 *
 * `core/skill.ts` renders the durable document you install once
 * (`.claude/skills/kona/SKILL.md`). This renders the thing you want at 3pm with
 * an applet open in front of you: a blurb you paste into an agent that teaches
 * it to drive THIS surface, right now — the verbs, their example args, the key
 * you'd press for each, and the two seams (CLI and HTTP) it can call them
 * through.
 *
 * Both come out of the same live manifest (`toolsForApplet`) and share the same
 * renderers, so what you paste can't describe a verb this machine doesn't have,
 * and can't drift from the skill either.
 */

export interface PromptOpts {
  /** Base URL to document for the HTTP seam. Defaults to the standard port. */
  base?: string;
}

const DEFAULT_BASE = "http://localhost:4177";

/** The bimodal model in the fewest words that still explain the stakes. */
const MODEL = `kona applets are bimodal: what a human browses in the terminal and what you
call verbs on are one object over one state. Firing a verb repaints their
screen — that is the point, not a side effect, so leave state coherent and
prefer small named verbs over sweeping mutations.`;

/** The seams, as a caller sees them. Same four calls the skill documents. */
function seams(base: string, id?: string): string {
  const applet = id ?? "<applet>";
  // Pad the comments to the widest command, so the block lines up whatever the
  // applet is called.
  const cli: Array<[string, string]> = [
    [`kona call ${applet} <verb> '<json>'`, "fire a verb → { ok, result, state }"],
    [`kona state ${applet}`, "read state"],
    ["kona tools --json", "the whole manifest, every applet"],
  ];
  const w = Math.max(...cli.map(([cmd]) => cmd.length));
  const http: Array<[string, string]> = [
    [`POST ${base}/applets/${applet}/verbs/<verb>`, "JSON body = args"],
    [`GET  ${base}/applets/${applet}/state`, ""],
    [`GET  ${base}/events`, "SSE: snapshot, then state"],
  ];
  const hw = Math.max(...http.map(([route]) => route.length));
  return [
    "```sh",
    ...cli.map(([cmd, note]) => `${cmd.padEnd(w)}   # ${note}`),
    "```",
    "",
    "Over HTTP, same entry point:",
    "",
    "```",
    ...http.map(([route, note]) => (note ? `${route.padEnd(hw)}   (${note})` : route)),
    "```",
  ].join("\n");
}

/** How to read what comes back — the two rules an agent gets wrong first. */
const RULES = `A verb answers with the applet's whole state, so read the result instead of
polling. Applets report failure in a state field (\`error\`, \`status\`) rather
than throwing, and verbs that act on a selection take \`id\`/\`label\`/\`index\` —
use those rather than moving the human's cursor with \`up\`/\`down\`.`;

/**
 * The blurb for ONE applet — what the host copies when you press the
 * copy-prompt key with that applet open.
 */
export function appletPrompt(def: AnyApplet, opts: PromptOpts = {}): string {
  const base = opts.base ?? DEFAULT_BASE;
  const verbs = toolsForApplet(def).filter((t) => !t.nav).length;
  return [
    `# Drive the kona applet \`${def.id}\` (${def.title})`,
    "",
    MODEL,
    "",
    seams(base, def.id),
    "",
    appletSection(def, 2),
    ...(def.recipes?.length ? ["", "## Worked examples", "", def.recipes.map(recipeBlock).join("\n\n")] : []),
    "",
    RULES,
    "",
    `${verbs} verb${verbs === 1 ? "" : "s"} on \`${def.id}\`; \`kona tools --json\` lists every applet installed here.`,
    "",
  ].join("\n");
}

/**
 * The blurb for the WHOLE surface set — what the launcher copies, since the
 * launcher isn't standing in front of any one applet.
 */
export function surfacePrompt(applets: AnyApplet[], opts: PromptOpts = {}): string {
  const base = opts.base ?? DEFAULT_BASE;
  const ids = applets.map((a) => `\`${a.id}\``).join(", ");
  return [
    `# Drive kona (${applets.length} applet${applets.length === 1 ? "" : "s"} on this machine)`,
    "",
    MODEL,
    "",
    seams(base),
    "",
    `Installed: ${ids}.`,
    "",
    applets.map((a) => appletSection(a, 2)).join("\n\n"),
    "",
    RULES,
    "",
  ].join("\n");
}
