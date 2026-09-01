import { isAbsolute, join, relative } from "node:path";
import { REPO_ROOT } from "./load.ts";

/**
 * `kona new <id>` — the scaffolder.
 *
 * It writes a whole applet PACKAGE: the applet, its snapshot fixtures, its
 * unit test and its docs, all under one new directory. That is the point of the
 * plugin boundary in one command — everything the platform needs to know about
 * an applet it reads out of this directory, so nothing outside it is touched
 * and two people scaffolding two applets can never conflict.
 */

export interface ScaffoldFile {
  /** Path relative to the new package directory. */
  path: string;
  content: string;
}

/** Applet ids are URL and filesystem safe: they name a route and a directory. */
export function validId(id: string): boolean {
  return /^[a-z][a-z0-9-]{0,23}$/.test(id);
}

/** `hello-world` -> `Hello World` */
function titleize(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The import prefix a package at `dir` uses to reach kona's SDK. In-repo that
 * is `../../sdk`; a plugin living elsewhere gets a path back to this checkout.
 */
export function sdkPrefix(dir: string): string {
  if (!inRepo(dir)) return join(REPO_ROOT, "sdk"); // a plugin elsewhere: absolute
  const rel = relative(dir, REPO_ROOT).replaceAll("\\", "/");
  const base = rel === "" ? "." : rel.startsWith(".") ? rel : `./${rel}`;
  return `${base}/sdk`;
}

/** Is this package inside the kona checkout (an applet) or outside it (a plugin)? */
export function inRepo(dir: string): boolean {
  const rel = relative(REPO_ROOT, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Every file a new applet package starts life with. */
export function scaffoldApplet(id: string, dir: string, title = titleize(id)): ScaffoldFile[] {
  const sdk = sdkPrefix(dir);
  const index = `import { defineApplet, big, text, spacer, col, theme } from "${sdk}/index.ts";

/**
 * ${title} — one applet, two callers.
 *
 * \`view\` is what a human sees; \`verbs\` are what an agent calls. They are the
 * same state, so a keypress and an HTTP call are indistinguishable here.
 */
interface ${titleize(id).replace(/ /g, "")}State {
  count: number;
}

export default defineApplet<${titleize(id).replace(/ /g, "")}State>({
  id: "${id}",
  title: "${title}",
  summary: "TODO: one line for the launcher.",
  labels: [],
  initialState: { count: 0 },

  verbs: {
    /** Bump the counter. \`{ "by": 5 }\` bumps by five. */
    bump: (args, { state, emit }) => {
      const by = typeof args.by === "number" ? args.by : 1;
      state.count += by;
      emit();
      return { count: state.count };
    },
    reset: (_args, { state, emit }) => {
      state.count = 0;
      emit();
    },
  },

  // What an agent reads in \`kona tools\` — written where the verb is written,
  // so the manifest and the generated skill can never drift from the code.
  docs: {
    bump: { doc: "Bump the counter.", args: { by: 5 } },
    reset: "Back to zero.",
  },

  view: (state) => [
    spacer(),
    big(String(state.count), theme().accent),
    spacer(),
    col([
      text(\`count: \${state.count}\`),
      text("+ / - to count, r to reset", { dim: true }),
    ]),
  ],

  keymap: {
    "+": { verb: "bump", args: { by: 1 }, label: "up" },
    "-": { verb: "bump", args: { by: -1 }, label: "down" },
    r: "reset",
  },
});
`;

  const snapshots = `import { defineSnapshots } from "${sdk}/testing.ts";

/**
 * Rendering regressions, discovered by tests/snapshot.test.ts because they sit
 * next to the applet — there is no central list to add them to.
 */
export default defineSnapshots([
  { name: "starts at zero", contains: ["count: 0", "r to reset"] },
  { name: "shows a count", state: { count: 42 }, contains: ["count: 42"] },
]);
`;

  const test = `import { test, expect } from "bun:test";
import applet from "./index.ts";

/** Verbs are a pure reducer over state — drive them exactly like the daemon does. */
test("bump adds to the count and emits", () => {
  const state = structuredClone(applet.initialState);
  let emits = 0;
  applet.verbs.bump!({ by: 5 }, { state, emit: () => void emits++ });
  expect(state.count).toBe(5);
  expect(emits).toBe(1);
});
`;

  const readme = `# ${id}

TODO: what this applet is, in a paragraph.

\`\`\`sh
kona ${id}                       # open it
kona call ${id} bump '{"by":5}'  # ...and what an agent does instead
\`\`\`

| key | verb | what it does |
| --- | --- | --- |
| \`+\` / \`-\` | \`bump\` | count up or down |
| \`r\` | \`reset\` | back to zero |
`;

  const files: ScaffoldFile[] = [
    { path: "index.ts", content: index },
    { path: "snapshots.ts", content: snapshots },
    { path: `${id}.test.ts`, content: test },
    { path: "README.md", content: readme },
  ];
  // In the repo, tests/snapshot.test.ts discovers `snapshots.ts` for you. A
  // plugin outside it is not in that scan, so it runs its own fixtures.
  if (!inRepo(dir)) {
    files.push({
      path: "snapshots.test.ts",
      content: `import { testSnapshots } from "${sdk}/testing.ts";
import applet from "./index.ts";
import snapshots from "./snapshots.ts";

await testSnapshots(applet, snapshots);
`,
    });
  }
  return files;
}
