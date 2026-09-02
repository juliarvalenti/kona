import type { AnyApplet, Priority, Recipe, ToolSpec } from "../sdk/index.ts";
import { toolsForApplet } from "../sdk/index.ts";

/**
 * The agent skill, generated from the LIVE manifest.
 *
 * A hand-written skill file rots the moment someone drops a new applet into
 * applets/. So kona doesn't ship prose about its verbs — it ships this
 * generator: the daemon renders the skill from the applets it actually loaded
 * (`GET /skill`, `kona tools --skill`), so what an agent reads is what the
 * machine can do, always.
 *
 * The static half — the bimodal model, the four calls, the rules — is here;
 * the moving half (applets, verbs, args, keys, recipes) comes from
 * `toolsForApplet` and each applet's own `docs`/`recipes` blocks.
 */

export interface SkillOpts {
  /** Skill name (its directory, and how an agent refers to it). */
  name?: string;
  /** Base URL to document for the HTTP seam. */
  base?: string;
  /**
   * Would an agent's call be held for a human? Passed by a caller that has the
   * machine's `[security]` policy in hand (the daemon, the CLI), so the skill
   * marks the verbs that will actually wait HERE. Omitted, nothing is marked.
   */
  guard?: (ref: { applet: string; verb: string; priority: Priority }) => boolean;
}

/**
 * The frontmatter description decides when an agent reaches for this skill, so
 * it names the applets — but it names the INSTALLED ones, from the manifest.
 * Nothing here to update when an applet lands.
 */
function description(applets: AnyApplet[]): string {
  const named = applets.map((a) => {
    const title = a.title.toLowerCase();
    return title === a.id ? a.id : `${a.id} (${title})`;
  });
  return (
    "Drive kona applets as an agent: discover what is installed from the live " +
    "tool manifest, read applet state, fire verbs, and watch the event stream. " +
    "Use when asked to act on a kona applet from the command line" +
    (named.length ? ` — ${list(named)}` : "") +
    "."
  );
}

/** `["a","b","c"]` -> "a, b, c" */
const list = (xs: string[]) => xs.join(", ");

/** A pasteable CLI line for one tool entry. */
export function exampleCall(t: ToolSpec): string {
  const args = t.args && Object.keys(t.args).length ? ` '${JSON.stringify(t.args)}'` : "";
  return `kona call ${t.applet} ${t.verb}${args}`;
}

/**
 * One verb as a bullet: what it does, the command that fires it, and the key a
 * human presses for the same thing. Shared with the copy-prompt blurb
 * (core/prompt.ts) so both renderings of the manifest read identically.
 */
export function verbLine(t: ToolSpec): string {
  const bits = [`- \`${t.name}\``];
  // A verb you cannot fire unattended is the first thing to know about it.
  if (t.guarded) bits.push("**(needs approval)**");
  if (t.doc) bits.push(`— ${t.doc}`);
  const trail: string[] = [`\`${exampleCall(t)}\``];
  if (t.key) trail.push(`key \`${t.key}\``);
  return `${bits.join(" ")}  ·  ${list(trail)}`;
}

/** A worked flow, as the skill and a copied prompt both print it. */
export function recipeBlock(r: Recipe): string {
  const steps = ["```sh", ...r.steps, "```"].join("\n");
  return [`**${r.title}**`, "", steps, ...(r.note ? ["", r.note] : [])].join("\n");
}

/**
 * One applet's whole surface: its verbs, the cursor verbs an agent should leave
 * alone, and its search seam. `level` is the heading depth, so the skill can
 * nest it under "Applets on this machine" and a copied prompt can lead with it.
 */
export function appletSection(def: AnyApplet, level = 3, guard?: SkillOpts["guard"]): string {
  const tools = toolsForApplet(def, guard);
  const acting = tools.filter((t) => !t.nav);
  const cursor = tools.filter((t) => t.nav);
  const out: string[] = [`${"#".repeat(level)} ${def.id} — ${def.title}`, ""];
  if (def.summary) out.push(def.summary, "");
  out.push(...acting.map(verbLine));
  if (cursor.length) {
    out.push(
      "",
      `Cursor verbs (the keyboard's business — address a row by id or index instead): ${list(
        cursor.map((t) => `\`${t.verb}\``),
      )}.`,
    );
  }
  if (def.search) out.push("", `Searchable: \`${def.id}.${def.search.verb}\` takes \`{"q": "..."}\`.`);
  return out.join("\n");
}

/**
 * Render the whole skill. Pass the applets the daemon loaded; the result is a
 * complete `SKILL.md`, frontmatter included, ready to drop into
 * `.claude/skills/<name>/`.
 */
export function skillMarkdown(applets: AnyApplet[], opts: SkillOpts = {}): string {
  const name = opts.name ?? "kona";
  const base = opts.base ?? "http://localhost:4177";
  const recipes = applets.flatMap((a) => a.recipes ?? []);
  const ids = applets.map((a) => a.id);
  // Which applets actually have a refresh verb is the manifest's business too.
  const refreshable = applets.filter((a) => "refresh" in a.verbs).map((a) => `\`${a.id}\``);
  // What THIS machine holds, from the same manifest the verbs come from — so
  // the skill can never promise an agent a verb it will actually have to wait
  // for, or warn about one it won't.
  const guarded = applets
    // The tray's own verbs are guarded too, but they are not YOURS to propose —
    // naming them here would read like a queue you could join.
    .filter((a) => a.id !== "approvals")
    .flatMap((a) => toolsForApplet(a, opts.guard).filter((t) => t.guarded).map((t) => t.name));

  const head = `---
name: ${name}
description: ${description(applets)}
---

# Driving kona

kona applets are **bimodal**: one applet is a view a human browses in a terminal
*and* a set of verbs you call — over one shared state, in one process. The human
presses \`space\` to pause a countdown; you call \`timer.pause\`; the applet cannot
tell the difference and does not care. There is nothing keyboard-only to work
around, text fields included.

A verb you fire repaints whatever the human is looking at, and can reach their
screen as a desktop notification. That is the point, not a side effect — but it
does mean you should leave state coherent, and prefer small named verbs over
sweeping mutations.

## The four calls

| What | CLI | HTTP |
| --- | --- | --- |
| Discover the verbs | \`kona tools --json\` | \`GET ${base}/tools\` |
| Read state | \`kona state <applet>\` | \`GET ${base}/applets/<id>/state\` |
| Fire a verb | \`kona call <applet> <verb> '<json>'\` | \`POST ${base}/applets/<id>/verbs/<verb>\` |
| Watch changes | — | \`GET ${base}/events\` (SSE: \`snapshot\`, then \`state\`) |

The daemon (\`konad\`) autostarts on the first CLI call. \`KONA_PORT\` moves the
port. A verb call answers with \`{ ok, result, state }\` — the applet's whole
state after the call — so you rarely need a follow-up read.

## Rules of engagement

1. **Discover, don't hardcode.** An applet is a directory — in kona's own
   \`applets/\`, or installed as a plugin — so a machine can have more (or
   fewer) than the ones below. Start from \`kona tools --json\` and
   act on what is actually installed. If this file and the manifest disagree,
   the manifest wins — regenerate with \`kona tools --skill\`.
2. **Address rows by name, not by cursor.** Verbs that act on a selection take
   \`id\`, \`label\`, or \`index\` as well; use them. Moving the cursor (\`up\`/\`down\`)
   is the human's affordance and races with them.
3. **Read the result.** The state a verb returns tells you whether it landed
   (e.g. a timer's \`status\`, an applet's \`error\` field). Applets report failure
   in state rather than throwing HTTP errors.
4. **Refresh before you read** an applet backed by a network service, unless its
   tick has been running${refreshable.length ? ` — \`refresh\` on ${list(refreshable)}` : ""}.
5. **A guarded verb is a proposal, not a failure.** See below.

## Verbs that need a human

You are not the human, and the daemon knows it: a keypress confirms itself,
your POST does not. So every verb carries a PRIORITY — \`low\` (reads and
kona-local state), \`medium\` (reversible remote effects: playback, mark-read),
\`high\` (acts as them: sends the mail, posts the message) or \`critical\` (does
not come back) — and this machine's \`[security]\` policy decides which of those
you may fire on your own.${
    guarded.length
      ? `

On this machine that holds ${list(guarded.slice(0, 6).map((n) => `\`${n}\``))}${
          guarded.length > 6 ? ` and ${guarded.length - 6} more` : ""
        } — every one of them marked **(needs approval)** in the list below.`
      : ""
  }

A held call comes back \`202\` with the verb NOT run:

\`\`\`json
{ "ok": false, "pending": "p3", "hint": "held for a human: high-priority verbs need a human" }
\`\`\`

What to do with that:

- **Wait, don't retry.** Poll \`GET ${base}/approvals/<id>\` (or watch the
  \`approval\` event on \`/events\`) — it answers \`pending\`, then \`ran\` with the
  verb's real result, or \`denied\`/\`expired\`. Firing it again just parks a
  second copy of the same proposal.
- **A denial is an answer.** Don't route around it, and never try to approve
  your own: \`approvals.approve\` refuses any caller but the human.
- **Say what you are proposing.** The human sees your exact args, so send the
  real message, not a placeholder you meant to fix up later.
- **Check first.** \`kona tools --json\` marks each verb's \`priority\`, and
  \`"guarded": true\` on the ones that will wait — plan the order of a job
  around them instead of discovering it halfway through.
- **A workflow pauses mid-run.** A run you start stops at its first guarded
  step and continues when that step is approved.

## Applets on this machine

Installed: ${list(ids.map((i) => `\`${i}\``))}.
`;

  const body = applets.map((a) => appletSection(a, 3, opts.guard)).join("\n\n");

  const tail = recipes.length
    ? `\n\n## Worked examples\n\n${recipes.map(recipeBlock).join("\n\n")}`
    : "";

  const foot = `

---

Generated from the live manifest by \`kona tools --skill\`. Re-run it after
adding an applet — \`kona tools --skill --out .claude/skills/${name}/SKILL.md\`.
`;

  return `${head}\n${body}${tail}${foot}`;
}
