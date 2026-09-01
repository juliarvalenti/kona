import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPackages, pluginRoots, REPO_ROOT } from "../core/load.ts";
import { resolveConfig, resetConfig } from "../core/config.ts";
import { catalogLines, catalogMarkdown } from "../core/catalog.ts";
import { scaffoldApplet, sdkPrefix, inRepo, validId } from "../core/scaffold.ts";
import { failures } from "../sdk/testing.ts";
import { EVENTS, registerEvents, isEnabled } from "../server/notify.ts";

/**
 * The plugin boundary itself: an applet is a directory, and everything the
 * platform knows about one it reads out of that directory. These tests pin the
 * promise that makes a swarm of agents possible — a new applet touches no
 * shared file, and kona finds it anyway.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.KONA_PLUGINS;
  process.env.KONA_NO_PLUGINS = "1"; // tests/setup.ts's default
  resetConfig();
});

/** Write a throwaway plugin package and return the root it lives under. */
function plugin(id: string, extra = ""): string {
  const root = mkdtempSync(join(tmpdir(), "kona-plugins-"));
  dirs.push(root);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.ts"),
    `import { defineApplet } from "${join(REPO_ROOT, "sdk")}/index.ts";
     export default defineApplet({
       id: "${id}",
       title: "${id}",
       summary: "a plugin",
       initialState: { n: 0 },
       verbs: { bump: (_a, { state, emit }) => { (state as { n: number }).n++; emit(); } },
       view: () => "plugin",
       ${extra}
     });`,
  );
  return root;
}

test("an applet outside the repo loads from KONA_PLUGINS", async () => {
  const root = plugin("outsider");
  delete process.env.KONA_NO_PLUGINS;
  process.env.KONA_PLUGINS = root;

  const pkgs = await loadPackages();
  const found = pkgs.find((p) => p.def.id === "outsider");
  expect(found).toBeDefined();
  expect(found!.source).toBe("plugin");
  expect(found!.dir).toBe(join(root, "outsider"));
  // ...alongside the built-ins, not instead of them.
  expect(pkgs.some((p) => p.def.id === "timer" && p.source === "repo")).toBe(true);
  // `kona ls` says which is which.
  expect(catalogLines(pkgs).find((l) => l.startsWith("outsider"))).toContain("(plugin)");
});

test("a plugin cannot shadow an applet that is already loaded", async () => {
  const root = plugin("timer");
  delete process.env.KONA_NO_PLUGINS;
  process.env.KONA_PLUGINS = root;

  const pkgs = await loadPackages();
  const timers = pkgs.filter((p) => p.def.id === "timer");
  expect(timers).toHaveLength(1);
  expect(timers[0]!.source).toBe("repo");
});

test("KONA_NO_PLUGINS keeps a run to the applets in this repo", async () => {
  const root = plugin("hermetic");
  process.env.KONA_PLUGINS = root;
  process.env.KONA_NO_PLUGINS = "1";

  expect(pluginRoots()).toEqual([]);
  expect((await loadPackages()).some((p) => p.def.id === "hermetic")).toBe(false);
});

test("config.toml can name plugin roots, and `~` expands", () => {
  const cfg = resolveConfig({ plugins: ["~/src/mine", "./here"] }, { path: "/x", exists: true });
  expect(cfg.plugins).toEqual(["~/src/mine", "./here"]);
  expect(cfg.errors).toEqual([]);

  const bad = resolveConfig({ plugins: "nope" }, { path: "/x", exists: true });
  expect(bad.plugins).toEqual([]);
  expect(bad.errors).toHaveLength(1); // complained about, never fatal
});

test("an applet declares its own notification events", () => {
  registerEvents([
    { id: "outsider", notifications: { "outsider.ping": { summary: "a ping arrives" } } },
  ]);
  expect(EVENTS["outsider.ping"]).toEqual({ summary: "a ping arrives", default: false });
  // Nobody declared this one, so it can never fire.
  expect(EVENTS["outsider.nope"]).toBeUndefined();
  expect(isEnabled("outsider.nope")).toBe(false);
});

test("every banner an applet fires is one it declares", async () => {
  // Undeclared events are silently off, so a typo (or a forgotten declaration)
  // would mean a banner nobody can ever turn on. Read what the applets
  // actually pass to notify() and hold them to it.
  const pkgs = await loadPackages();
  registerEvents(pkgs.map((p) => p.def));
  for (const pkg of pkgs) {
    const source = await Bun.file(pkg.entry).text();
    for (const [, event] of source.matchAll(/event:\s*"([^"]+)"/g)) {
      expect({ applet: pkg.def.id, event, declared: !!EVENTS[event!] }).toEqual({
        applet: pkg.def.id,
        event,
        declared: true,
      });
    }
  }
});

test("the catalog is generated from the packages, not a hand-kept list", async () => {
  const pkgs = await loadPackages();
  const md = catalogMarkdown(pkgs);
  expect(md).toContain(`# Applets (${pkgs.length})`);
  expect(md).toContain("| `timer` |");
  expect(md).toContain("`focus`"); // the timer's labels
  expect(md).toContain("- `email` — a mailbox"); // what it needs
});

test("`kona new` writes a whole package and nothing outside it", () => {
  const files = scaffoldApplet("hello", join(REPO_ROOT, "applets", "hello"));
  expect(files.map((f) => f.path)).toEqual([
    "index.ts",
    "snapshots.ts",
    "hello.test.ts",
    "README.md",
  ]);
  const index = files[0]!.content;
  expect(index).toContain(`id: "hello"`);
  expect(index).toContain(`from "../../sdk/index.ts"`); // in-repo, a relative import
  expect(files[1]!.content).toContain("defineSnapshots");

  // Outside the repo the same package points back at this checkout, and brings
  // its own fixture runner — nothing here scans its directory.
  const outside = scaffoldApplet("hello", "/tmp/elsewhere/hello");
  expect(outside.map((f) => f.path)).toContain("snapshots.test.ts");
  expect(outside[0]!.content).toContain(`from "${join(REPO_ROOT, "sdk")}/index.ts"`);
  expect(inRepo("/tmp/elsewhere/hello")).toBe(false);
  expect(sdkPrefix(join(REPO_ROOT, "applets", "hello"))).toBe("../../sdk");
});

test("an applet id has to be a legal route and directory name", () => {
  for (const ok of ["timer", "hello-world", "x2"]) expect(validId(ok)).toBe(true);
  for (const no of ["", "Timer", "2fast", "has space", "../escape", "a".repeat(30)]) {
    expect(validId(no)).toBe(false);
  }
});

test("a fixture reports exactly what the frame failed to say", () => {
  const frame = "kona  timer\n  02:05 running";
  expect(failures(frame, { name: "x", contains: ["02:05"], excludes: ["paused"] })).toEqual([]);
  expect(failures(frame, { name: "x", contains: ["09:00"] })).toEqual([`missing "09:00"`]);
  expect(failures(frame, { name: "x", excludes: ["running"] })).toEqual([
    `should not contain "running"`,
  ]);
  // `collapsed` matches across the whitespace the layout inserts.
  expect(failures(frame, { name: "x", collapsed: ["kona timer"] })).toEqual([]);
});
