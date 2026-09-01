import { test, expect, afterEach } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPackages, REPO_ROOT } from "../core/load.ts";
import { resetConfig } from "../core/config.ts";
import {
  installPlugin,
  isGitSource,
  listPlugins,
  pluginName,
  pluginsDir,
  pluginsFile,
  readRecords,
  removePlugin,
  validPluginName,
} from "../core/plugins.ts";

/**
 * `kona plugin install` — the step before discovery.
 *
 * Loading a package out of `~/.config/kona/plugins/` was already covered
 * (plugin.test.ts); what these pin is GETTING one there: a clone, a copy or a
 * symlink lands a directory the loader then finds by its own rules, an install
 * that produced no package undoes itself, and removing one takes the directory
 * without touching the checkout a `--link` points at.
 *
 * Nothing here reaches the network: the "remote" is a real git repo made in a
 * temp dir, which is what `git clone` is given.
 */

const dirs: string[] = [];
const prevConfig = process.env.KONA_CONFIG_DIR;

/** A throwaway config dir, so installs land somewhere the test owns. */
function konaHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "kona-home-"));
  dirs.push(dir);
  process.env.KONA_CONFIG_DIR = dir;
  resetConfig();
  return dir;
}

afterEach(() => {
  if (prevConfig === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = prevConfig;
  delete process.env.KONA_PLUGINS;
  process.env.KONA_NO_PLUGINS = "1"; // tests/setup.ts's default
  resetConfig();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An applet package on disk — what someone else would have published. */
function sourcePackage(id: string, extra = ""): string {
  const root = mkdtempSync(join(tmpdir(), "kona-src-"));
  dirs.push(root);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.ts"),
    `import { defineApplet } from "${join(REPO_ROOT, "sdk")}/index.ts";
     export default defineApplet({
       id: "${id}",
       title: "${id}",
       summary: "an installed plugin",
       initialState: { n: 0 },
       verbs: { bump: (_a, { state, emit }) => { (state as { n: number }).n++; emit(); } },
       view: () => "plugin",
       ${extra}
     });`,
  );
  // Things a copy should leave behind: a package's build output is not part of
  // the package.
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "junk", "index.js"), "// huge");
  return dir;
}

/**
 * Turn a directory into a git repo with one commit and hand back a URL to
 * clone it from. `file://` keeps the test offline while still going through
 * the real `git clone` — a plain path would be copied instead, since a
 * directory that exists always wins.
 */
async function gitRepo(dir: string): Promise<string> {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  };
  await run("init", "-q", "-b", "main");
  await run("config", "user.email", "test@kona");
  await run("config", "user.name", "kona test");
  await run("add", "-A");
  await run("commit", "-qm", "initial");
  return `file://${dir}`;
}

test("a local package is copied into the plugin dir, where the loader finds it", async () => {
  const home = konaHome();
  const src = sourcePackage("tome");

  const installed = await installPlugin(src, { deps: false });
  expect(installed).toMatchObject({ name: "tome", kind: "copy", ids: ["tome"], error: null });
  expect(installed.dir).toBe(join(home, "plugins", "tome"));
  expect(existsSync(join(installed.dir, "index.ts"))).toBe(true);
  // The copy is the source, not its build output.
  expect(existsSync(join(installed.dir, "node_modules"))).toBe(false);

  // ...and that is all it takes to be an applet: the loader's own rules pick it
  // up from the standard plugin dir, no registry touched.
  delete process.env.KONA_NO_PLUGINS;
  const pkg = (await loadPackages()).find((p) => p.def.id === "tome");
  expect(pkg?.source).toBe("plugin");
  expect(pkg?.dir).toBe(installed.dir);

  // Editing the source afterwards cannot change what is installed — a copy is a
  // copy.
  writeFileSync(join(src, "index.ts"), "export default {};");
  expect(readFileSync(join(installed.dir, "index.ts"), "utf8")).toContain(`id: "tome"`);
});

test("--link points at the checkout, and the loader follows it", async () => {
  konaHome();
  const src = sourcePackage("dev-applet");

  const installed = await installPlugin(src, { link: true });
  expect(installed.kind).toBe("link");
  expect(lstatSync(installed.dir).isSymbolicLink()).toBe(true);
  // Never `bun install` into somebody's working checkout.
  expect(installed.deps).toBe("skipped");

  // A symlinked package has to LOAD, or `--link` would be a worse copy.
  delete process.env.KONA_NO_PLUGINS;
  expect((await loadPackages()).find((p) => p.def.id === "dev-applet")?.source).toBe("plugin");

  // Removing it drops the link, never the checkout behind it.
  await removePlugin("dev-applet");
  expect(existsSync(installed.dir)).toBe(false);
  expect(existsSync(join(src, "index.ts"))).toBe(true);
});

test("a git url is cloned, and `--as` names the directory", async () => {
  const home = konaHome();
  const remote = await gitRepo(sourcePackage("shipped"));

  const installed = await installPlugin(remote, { as: "renamed", deps: false });
  expect(installed).toMatchObject({ name: "renamed", kind: "git", ids: ["shipped"] });
  expect(installed.dir).toBe(join(home, "plugins", "renamed"));
  expect(existsSync(join(installed.dir, ".git"))).toBe(true);

  // The applet id is the applet's, not the directory's: `kona call shipped`.
  delete process.env.KONA_NO_PLUGINS;
  expect((await loadPackages()).some((p) => p.def.id === "shipped")).toBe(true);

  // `kona plugin list` reads the DIR and reports where it came from.
  const [listed] = await listPlugins();
  expect(listed).toMatchObject({ name: "renamed", kind: "git", ids: ["shipped"], source: remote });
});

test("a failed clone leaves nothing behind", async () => {
  const home = konaHome();
  // A repo that isn't there — the failure git reports, not the network.
  await expect(installPlugin(`file://${join(tmpdir(), "kona-no-such-repo")}/nope.git`, { deps: false })).rejects.toThrow(
    /git clone failed/,
  );
  expect(existsSync(join(home, "plugins", "nope"))).toBe(false);
  expect(readRecords()).toEqual([]);
});

test("installing something that is not a package undoes itself", async () => {
  const home = konaHome();
  const empty = mkdtempSync(join(tmpdir(), "kona-empty-"));
  dirs.push(empty);
  writeFileSync(join(empty, "README.md"), "# not an applet");

  await expect(installPlugin(empty, { deps: false })).rejects.toThrow(/no applet package/);
  // Half an install is worse than none: the loader would ignore the directory
  // and `kona plugin list` would show a plugin that isn't one.
  expect(existsSync(join(home, "plugins", empty.split("/").pop()!))).toBe(false);
});

test("a plugin dir full of packages installs as one plugin", async () => {
  konaHome();
  const bundle = mkdtempSync(join(tmpdir(), "kona-bundle-"));
  dirs.push(bundle);
  for (const id of ["alpha", "beta"]) {
    const dir = join(bundle, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `import { defineApplet } from "${join(REPO_ROOT, "sdk")}/index.ts";
       export default defineApplet({ id: "${id}", title: "${id}", initialState: {}, verbs: {}, view: () => "x" });`,
    );
  }

  const installed = await installPlugin(bundle, { as: "bundle", deps: false });
  expect(installed.ids).toEqual(["alpha", "beta"]);
});

test("a name is only claimed once, and the second install says what to do", async () => {
  konaHome();
  const src = sourcePackage("tome");
  await installPlugin(src, { deps: false });
  await expect(installPlugin(src, { deps: false })).rejects.toThrow(/already exists/);
  // ...which `--as` answers.
  const second = await installPlugin(src, { as: "tome-2", deps: false });
  expect(second.name).toBe("tome-2");
  expect((await listPlugins()).map((p) => p.name)).toEqual(["tome", "tome-2"]);
});

test("remove deletes the package and forgets where it came from", async () => {
  konaHome();
  await installPlugin(sourcePackage("tome"), { deps: false });
  expect(readRecords().map((r) => r.name)).toEqual(["tome"]);

  const gone = await removePlugin("tome");
  expect(gone.ids).toEqual(["tome"]);
  expect(existsSync(gone.dir)).toBe(false);
  expect(readRecords()).toEqual([]);
  expect(await listPlugins()).toEqual([]);
  await expect(removePlugin("tome")).rejects.toThrow(/not installed/);
});

test("a package dropped in by hand lists like an installed one", async () => {
  const home = konaHome();
  const dir = join(home, "plugins", "byhand");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.ts"),
    `import { defineApplet } from "${join(REPO_ROOT, "sdk")}/index.ts";
     export default defineApplet({ id: "byhand", title: "byhand", initialState: {}, verbs: {}, view: () => "x" });`,
  );

  // The filesystem is the source of truth; plugins.json only adds provenance.
  const [listed] = await listPlugins();
  expect(listed).toMatchObject({ name: "byhand", kind: "copy", ids: ["byhand"], source: null });
  expect(existsSync(pluginsFile())).toBe(false);

  await removePlugin("byhand");
  expect(existsSync(dir)).toBe(false);
});

test("a plugin that doesn't load is listed with its reason, not hidden", async () => {
  const home = konaHome();
  const dir = join(home, "plugins", "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `throw new Error("boom");`);

  const [listed] = await listPlugins();
  expect(listed!.ids).toEqual([]);
  expect(listed!.error).toContain("boom");
});

test("a name is inferred from the source, and has to be a directory name", () => {
  expect(pluginName("https://github.com/me/kona-tome.git")).toBe("kona-tome");
  expect(pluginName("git@github.com:me/kona-tome.git")).toBe("kona-tome");
  expect(pluginName("/home/me/src/tome/")).toBe("tome");

  for (const ok of ["tome", "kona-tome", "tome.2"]) expect(validPluginName(ok)).toBe(true);
  for (const no of ["", ".hidden", "../escape", "a/b", "-lead"]) expect(validPluginName(no)).toBe(false);
});

test("git spellings are told apart from paths", () => {
  for (const url of [
    "https://github.com/me/x.git",
    "http://host/x",
    "ssh://git@host/x",
    "git@github.com:me/x",
    "/srv/mirror/x.git",
  ]) {
    expect(isGitSource(url)).toBe(true);
  }
  for (const path of ["/home/me/src/x", "./x", "~/src/x", "x"]) expect(isGitSource(path)).toBe(false);
});

test("a path that exists wins over a git-shaped name", async () => {
  konaHome();
  // `./thing.git` on disk is a directory to copy, not a URL to fetch.
  const src = sourcePackage("looksremote");
  const gitish = `${src}.git`;
  mkdirSync(gitish, { recursive: true });
  dirs.push(gitish);
  writeFileSync(
    join(gitish, "index.ts"),
    `import { defineApplet } from "${join(REPO_ROOT, "sdk")}/index.ts";
     export default defineApplet({ id: "gitish", title: "gitish", initialState: {}, verbs: {}, view: () => "x" });`,
  );

  const installed = await installPlugin(gitish, { deps: false });
  expect(installed.kind).toBe("copy");
  expect(installed.ids).toEqual(["gitish"]);
});

test("installing from the plugin dir into itself is refused", async () => {
  konaHome();
  const installed = await installPlugin(sourcePackage("tome"), { deps: false });
  await expect(installPlugin(installed.dir, { as: "copy-of-tome", deps: false })).rejects.toThrow(
    /already in the plugin dir/,
  );
});

test("--link needs a path, and a missing path says so", async () => {
  konaHome();
  await expect(installPlugin("https://github.com/me/x.git", { link: true })).rejects.toThrow(/--link needs a local path/);
  await expect(installPlugin("/nope/not/here", {})).rejects.toThrow(/no such directory/);
  expect(await listPlugins()).toEqual([]);
});

test("`bun install` runs when the package brings its own dependencies", async () => {
  konaHome();
  const src = sourcePackage("withdeps");
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "withdeps", version: "0.0.0" }));

  // No dependencies to fetch, so this stays offline — what it pins is that a
  // package.json is what decides, and that the result is reported.
  const installed = await installPlugin(src);
  expect(installed.deps).toBe("installed");
  expect(existsSync(join(installed.dir, "package.json"))).toBe(true);

  // ...and without one there is nothing to install.
  const plain = await installPlugin(sourcePackage("nodeps"));
  expect(plain.deps).toBe("none");
});

test("pluginsDir follows KONA_CONFIG_DIR, so an install never escapes the test", () => {
  const home = konaHome();
  expect(pluginsDir()).toBe(join(home, "plugins"));
  expect(pluginsFile()).toBe(join(home, "plugins.json"));
});
