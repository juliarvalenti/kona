import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startDaemon } from "../server/daemon.ts";
import { loadPackages, REPO_ROOT } from "../core/load.ts";
import { catalogLines } from "../core/catalog.ts";
import { linkApplet, linksFile, readLinks, unlinkApplet } from "../core/links.ts";
import { scaffoldApplet, SHEBANG } from "../core/scaffold.ts";

/**
 * Applet-as-executable: an applet module you run directly, rather than one kona
 * finds by scanning a directory. Two halves are pinned here — the LINK (running
 * a file remembers it, so every other client can reach the applet by id) and
 * the REGISTER (a running daemon learns the module now, not after a restart).
 */

const dirs: string[] = [];
const origConfigDir = process.env.KONA_CONFIG_DIR;

/** A throwaway applet module. Executable ones carry the shebang, as a real one would. */
function module(id: string, opts: { executable?: boolean; extra?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "kona-exe-"));
  dirs.push(dir);
  const entry = join(dir, `${id}.ts`);
  writeFileSync(
    entry,
    `${opts.executable ? `${SHEBANG}\n` : ""}import { defineApplet } from "${join(REPO_ROOT, "sdk")}/index.ts";
     export default defineApplet({
       id: "${id}",
       title: "${id}",
       summary: "an executable applet",
       initialState: { n: 0 },
       verbs: { bump: (_a, { state, emit }) => { (state as { n: number }).n++; emit(); return { n: (state as { n: number }).n }; } },
       docs: { bump: { doc: "Bump the counter.", args: { by: 1 } } },
       view: () => "executable",
       ${opts.extra ?? ""}
     });`,
  );
  if (opts.executable) chmodSync(entry, 0o755);
  return entry;
}

/** Point the links file at a throwaway config dir, and let links load at all. */
function useLinks(): void {
  const dir = mkdtempSync(join(tmpdir(), "kona-cfg-"));
  dirs.push(dir);
  process.env.KONA_CONFIG_DIR = dir;
  delete process.env.KONA_NO_PLUGINS;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (origConfigDir === undefined) delete process.env.KONA_CONFIG_DIR;
  else process.env.KONA_CONFIG_DIR = origConfigDir;
  process.env.KONA_NO_PLUGINS = "1"; // tests/setup.ts's default
});

test("running a module remembers it, by path", () => {
  useLinks();
  const entry = module("runner");
  linkApplet("runner", entry);
  expect(readLinks()).toEqual([{ id: "runner", entry }]);
  expect(existsSync(linksFile())).toBe(true);

  // Linking the same file twice is one link, not two — running an applet is
  // the common case and must stay idempotent.
  linkApplet("runner", entry);
  expect(readLinks()).toHaveLength(1);

  // ...and it can be forgotten by either name.
  expect(unlinkApplet("runner")?.entry).toBe(entry);
  expect(readLinks()).toEqual([]);
  linkApplet("runner", entry);
  expect(unlinkApplet(entry)?.id).toBe("runner");
  expect(unlinkApplet("nope")).toBeNull();
});

test("a linked module loads as an applet, wherever it lives", async () => {
  useLinks();
  const entry = module("linked", { executable: true });
  linkApplet("linked", entry);

  const pkgs = await loadPackages();
  const found = pkgs.find((p) => p.def.id === "linked");
  expect(found).toBeDefined();
  expect(found!.source).toBe("link");
  expect(found!.entry).toBe(entry); // a link is a FILE — it need not be index.ts
  // Alongside the built-ins, and marked for what it is.
  expect(pkgs.some((p) => p.def.id === "timer" && p.source === "repo")).toBe(true);
  expect(catalogLines(pkgs).find((l) => l.startsWith("linked"))).toContain("(linked)");
});

test("a link cannot shadow an applet that ships with kona", async () => {
  useLinks();
  linkApplet("timer", module("timer"));
  const timers = (await loadPackages()).filter((p) => p.def.id === "timer");
  expect(timers).toHaveLength(1);
  expect(timers[0]!.source).toBe("repo");
});

test("a link to a file that is gone is ignored, not fatal", async () => {
  useLinks();
  const entry = module("ghost");
  rmSync(entry);
  linkApplet("ghost", entry);
  expect((await loadPackages()).some((p) => p.def.id === "ghost")).toBe(false);
});

test("KONA_NO_PLUGINS keeps a run to the applets in this repo", async () => {
  useLinks();
  linkApplet("hermetic", module("hermetic"));
  process.env.KONA_NO_PLUGINS = "1";
  expect((await loadPackages()).some((p) => p.def.id === "hermetic")).toBe(false);
});

test("`kona new --executable` writes a file that can run itself", () => {
  const plain = scaffoldApplet("pomodoro", join(REPO_ROOT, "applets", "pomodoro"));
  expect(plain[0]!.content.startsWith(SHEBANG)).toBe(false);

  const exe = scaffoldApplet("pomodoro", join(REPO_ROOT, "applets", "pomodoro"), { executable: true });
  expect(exe[0]!.path).toBe("index.ts");
  expect(exe[0]!.content.startsWith(`${SHEBANG}\n`)).toBe(true);
  expect(exe[0]!.content).toContain(`id: "pomodoro"`); // ...and still an ordinary applet
  expect(exe.find((f) => f.path === "README.md")!.content).toContain("./index.ts");
  // The third argument used to be the title; that spelling still works.
  expect(scaffoldApplet("pomodoro", "/tmp/x/pomodoro", "Tomato")[0]!.content).toContain(`title: "Tomato"`);
});

/** The daemon half: teaching a RUNNING konad about a module. */
let server: Server;
let url: string;

beforeAll(async () => {
  process.env.KONA_NO_WATCH = "1";
  process.env.KONA_STATE_DIR = mkdtempSync(join(tmpdir(), "kona-exe-state-"));
  server = await startDaemon(0);
  url = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const register = (entry: unknown) =>
  fetch(`${url}/applets/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry }),
  });

test("registering a module makes it a first-class applet, with no restart", async () => {
  const entry = module("live", { executable: true });
  const before = (await fetch(`${url}/applets/live/state`)).status;
  expect(before).toBe(404);

  const res = await register(entry);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, id: "live", added: true });

  // Everything a scanned applet gets, this one gets: the launcher, the
  // manifest an agent reads, its state slice, and its verbs.
  const applets = (await (await fetch(`${url}/applets`)).json()) as Array<{ id: string }>;
  expect(applets.some((a) => a.id === "live")).toBe(true);
  const tools = (await (await fetch(`${url}/tools`)).json()) as Array<{ name: string; doc?: string }>;
  expect(tools.find((t) => t.name === "live.bump")?.doc).toBe("Bump the counter.");
  expect(await (await fetch(`${url}/applets/live/state`)).json()).toEqual({ n: 0 });

  const call = await fetch(`${url}/applets/live/verbs/bump`, { method: "POST", body: "{}" });
  expect(await call.json()).toMatchObject({ ok: true, result: { n: 1 }, state: { n: 1 } });

  // Running the same file again is a no-op, not a second applet.
  expect(await (await register(entry)).json()).toMatchObject({ id: "live", added: false });
  expect(await (await fetch(`${url}/applets/live/state`)).json()).toEqual({ n: 1 });
});

test("a module cannot take over an id the daemon already serves", async () => {
  const res = await register(module("timer"));
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain(`already loaded`);
  // The real timer is untouched.
  const tools = (await (await fetch(`${url}/tools`)).json()) as Array<{ name: string }>;
  expect(tools.filter((t) => t.name === "timer.start")).toHaveLength(1);
});

test("registering something that isn't an applet fails loudly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kona-exe-"));
  dirs.push(dir);
  const notApplet = join(dir, "notes.ts");
  writeFileSync(notApplet, `export default { hello: "world" };`);
  const bad = await register(notApplet);
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("must default-export defineApplet");

  const missing = await register(join(dir, "nope.ts"));
  expect(missing.status).toBe(400);

  // A path the daemon can't resolve from its own cwd is refused outright.
  const relative = await register("applets/timer/index.ts");
  expect(relative.status).toBe(400);
  expect((await relative.json()).error).toContain("absolute path");
});

test("an applet package directory can be made executable in place", async () => {
  // The ergonomic the issue asks for: `applets/<id>/index.ts` with a shebang,
  // `chmod +x`, and `./index.ts` opens it. Nothing about the package changes —
  // it is still discovered by the scan, and its id still resolves to it.
  const dir = mkdtempSync(join(tmpdir(), "kona-exe-pkg-"));
  dirs.push(dir);
  mkdirSync(join(dir, "counter"), { recursive: true });
  for (const file of scaffoldApplet("counter", join(dir, "counter"), { executable: true })) {
    writeFileSync(join(dir, "counter", file.path), file.content);
  }
  chmodSync(join(dir, "counter", "index.ts"), 0o755);

  const entry = join(dir, "counter", "index.ts");
  const res = await register(entry);
  expect(await res.json()).toMatchObject({ ok: true, id: "counter", added: true });
  const call = await fetch(`${url}/applets/counter/verbs/bump`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ by: 5 }),
  });
  expect(await call.json()).toMatchObject({ ok: true, result: { count: 5 } });
});
