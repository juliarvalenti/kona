import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mkdirSync, watch } from "node:fs";
import type { AppletDef, AppletState, AppletCtx } from "../sdk/index.ts";
import { toolsForApplet } from "../sdk/index.ts";
import { loadPackages, pluginRoots, APPLETS_DIR } from "../core/load.ts";
import { skillMarkdown } from "../core/skill.ts";
import { CronScheduler } from "./cron.ts";
import { registerEvents } from "./notify.ts";

export const DEFAULT_PORT = Number(process.env.KONA_PORT ?? 4177);

// Overridable so tests can point at a throwaway dir instead of the real state.
const stateDir = () => process.env.KONA_STATE_DIR ?? join(homedir(), ".local", "state", "kona");

type StateMap = Record<string, AppletState>;

/**
 * konad — the one process that owns application state. The TUI is a client;
 * an agent is a client; a cron tick is an internal caller. All of them route
 * through the same verbs against the same state.
 */
export async function startDaemon(port = DEFAULT_PORT) {
  const STATE_DIR = stateDir();
  const STATE_FILE = join(STATE_DIR, "state.json");
  // SSE keepalive knobs. Bun caps idleTimeout at 255s; heartbeat must be well
  // under it. Both env-tunable so tests can force an idle timeout in ~1s.
  const IDLE_TIMEOUT = Math.min(255, Number(process.env.KONA_IDLE_TIMEOUT ?? 120));
  const HEARTBEAT_MS = Number(process.env.KONA_HEARTBEAT_MS ?? 15_000);
  // How often the cron scheduler asks "what is due?". Cron is minute-granular,
  // but `@every 5s` isn't, so the pass is cheap and frequent.
  const SCHEDULER_MS = Number(process.env.KONA_SCHEDULER_MS ?? 1_000);
  const packages = await loadPackages();
  // Mutable: `POST /applets/register` teaches a RUNNING daemon about an applet
  // module (an executable applet, see core/links.ts) without a restart, and
  // everything downstream — /applets, /tools, /skill, cron — reads this array
  // on each request or pass, so a late arrival is a first-class applet.
  const applets: AppletDef[] = packages.map((p) => p.def);
  const byId = new Map<string, AppletDef>(applets.map((a) => [a.id, a]));
  // Which module each id came from, so re-registering the same file is a no-op
  // and a DIFFERENT file claiming a loaded id is refused rather than shadowing
  // it — the loader's first-come rule, held at runtime.
  const entryById = new Map<string, string>(packages.map((p) => [p.def.id, p.entry]));
  // Applets declare the banners they can raise; nothing central lists them.
  registerEvents(applets);

  // `bun --watch` only reloads files already in the module graph; applets are
  // imported dynamically, so a BRAND-NEW applet file never triggers a restart
  // and the daemon goes stale ("no such applet"). Watch the dir ourselves and
  // exit on change — the client respawns a fresh daemon that re-scans. unref so
  // this never keeps a test process alive.
  if (!process.env.KONA_NO_WATCH) {
    // Plugin roots get the same treatment as the repo's applets/, so an applet
    // installed outside this checkout is just as live.
    for (const dir of [APPLETS_DIR, ...pluginRoots()]) {
      try {
        const w = watch(dir, { recursive: true }, (_e, file) => {
          if (file && file.endsWith(".ts")) {
            console.error(`applets changed (${file}) — restarting`);
            process.exit(0);
          }
        });
        w.unref?.();
      } catch {
        /* absent or unwatchable (a plugin dir may not exist) — manual restart */
      }
    }
  }

  // Applets marked ephemeral (e.g. email) never touch disk — mail stays in RAM.
  const ephemeral = new Set(applets.filter((a) => a.ephemeral).map((a) => a.id));

  /** One heartbeat per applet, whether it arrived at boot or was registered later. */
  const ticks = new Map<string, ReturnType<typeof setInterval>>();

  // --- state, persisted so the daemon can restart without losing a countdown
  const states: StateMap = {};
  let saved: StateMap = {};
  try {
    saved = JSON.parse(await Bun.file(STATE_FILE).text()) as StateMap;
  } catch {
    saved = {};
  }
  // Deep-copy: a shallow spread would hand every applet's own module the array
  // (or object) inside its `initialState` to mutate, so a running daemon would
  // edit the applet's declared defaults in place.
  const fresh = (a: (typeof applets)[number]): AppletState => {
    try {
      return structuredClone(a.initialState) as AppletState;
    } catch {
      return { ...a.initialState };
    }
  };
  for (const a of applets) {
    states[a.id] = ephemeral.has(a.id) ? fresh(a) : { ...fresh(a), ...saved[a.id] };
  }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        const onDisk = Object.fromEntries(Object.entries(states).filter(([id]) => !ephemeral.has(id)));
        Bun.write(STATE_FILE, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
      } catch {}
    }, 400);
  }

  // --- subscribers (SSE): each is a function that pushes an event string
  const subscribers = new Set<(chunk: string) => void>();
  function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const push of subscribers) push(payload);
  }
  function ctxFor(id: string): AppletCtx {
    return {
      state: states[id]!,
      emit: () => {
        broadcast("state", { applet: id, state: states[id] });
        persist();
      },
      peek: (other) => states[other], // read another applet's live state
      // ...and what there IS to peek at. The array is the daemon's live one, so
      // an applet registered a second ago is in it; `dash` reads this instead
      // of naming the applets it knows how to summarise.
      applets: () => applets,
      // Fire another applet's verb through the SAME entry point HTTP uses, so
      // an applet composing others (workflows) is just one more caller. The
      // HTTP layer's 404 Response becomes a plain rejection here — a caller in
      // the daemon wants an error it can read, not a status code.
      call: async (other, verb, callArgs) => {
        try {
          return await invoke(other, verb, callArgs ?? {});
        } catch (e) {
          if (e instanceof Response) throw new Error(`${other}.${verb}: ${await e.text()}`);
          throw e;
        }
      },
    };
  }

  /** An applet's one-shot init. A throwing applet is logged, never fatal. */
  function initApplet(a: AppletDef) {
    if (!a.init) return;
    try {
      a.init(ctxFor(a.id));
    } catch (e) {
      console.error(`[init:${a.id}]`, e);
    }
  }

  /** Start an applet's heartbeat — the internal caller, same state, same emit. */
  function startTick(a: AppletDef) {
    clearInterval(ticks.get(a.id)); // never two heartbeats for one applet
    ticks.delete(a.id);
    if (!a.tick || !a.tickMs) return;
    const iv = setInterval(() => {
      try {
        a.tick!(ctxFor(a.id));
      } catch (e) {
        console.error(`[tick:${a.id}]`, e);
      }
    }, a.tickMs);
    iv.unref?.(); // the server keeps the daemon alive; ticks shouldn't pin it
    ticks.set(a.id, iv);
  }

  /**
   * Load an applet module into the RUNNING daemon — state slice, notification
   * events, init and tick — and hand it the same seam everything else has.
   * This is what makes an executable applet (`#!/usr/bin/env kona`) usable the
   * moment you run it: without it the file would only be an applet after the
   * next daemon restart, and `kona call` in between would 404.
   *
   * Registering the same module twice is a no-op; a DIFFERENT module claiming a
   * loaded id is refused. That is the loader's first-come rule (a plugin can
   * never shadow a built-in) held at runtime, and it is why an executable file
   * cannot quietly replace `timer` for every other client of this daemon.
   */
  async function register(entry: string): Promise<{ id: string; added: boolean }> {
    const known = [...entryById].find(([, e]) => e === entry)?.[0];
    if (known) return { id: known, added: false };

    let def: AppletDef | undefined;
    try {
      def = ((await import(entry)) as { default?: AppletDef }).default;
    } catch (e) {
      throw new Response(`could not load ${entry}: ${e instanceof Error ? e.message : String(e)}`, { status: 400 });
    }
    if (!def?.id || !def.verbs || !def.view) {
      throw new Response(`not an applet: ${entry} must default-export defineApplet(...)`, { status: 400 });
    }
    const claimed = entryById.get(def.id);
    if (claimed) throw new Response(`applet id "${def.id}" is already loaded from ${claimed}`, { status: 409 });

    applets.push(def);
    byId.set(def.id, def);
    entryById.set(def.id, entry);
    if (def.ephemeral) ephemeral.add(def.id);
    states[def.id] = def.ephemeral ? fresh(def) : { ...fresh(def), ...saved[def.id] };
    registerEvents([def]);
    initApplet(def);
    startTick(def);
    // Everyone watching gets the new slice; the launcher and the manifest pick
    // it up on their next read.
    broadcast("snapshot", states);
    console.error(`registered ${def.id} from ${entry}`);
    return { id: def.id, added: true };
  }

  // init + ticks run AFTER the port is bound (below) — a duplicate daemon that
  // can't bind must exit BEFORE hitting any applet init (which calls APIs),
  // otherwise a spawn storm becomes an API storm.

  async function invoke(id: string, verb: string, args: Record<string, unknown>) {
    const def = byId.get(id);
    if (!def) throw new Response("no such applet", { status: 404 });
    const fn = def.verbs[verb];
    if (!fn) throw new Response("no such verb", { status: 404 });
    return await fn(args ?? {}, ctxFor(id));
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });

  const server = Bun.serve({
    port,
    idleTimeout: IDLE_TIMEOUT,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") return json({ ok: true, applets: applets.length });

      // The launcher's menu.
      if (path === "/applets" && req.method === "GET") {
        return json(
          applets.map((a) => ({ id: a.id, title: a.title, summary: a.summary ?? "" })),
        );
      }

      // Hand the daemon an applet module to load right now. The caller is a
      // `kona <path>` on this machine and the body is a local file path: konad
      // binds localhost and already imports whatever `applets/`, the plugin
      // roots and `links.json` name, so this widens WHEN a module is loaded,
      // not WHOSE — anything that can reach this port can already write to
      // those directories as you.
      if (path === "/applets/register" && req.method === "POST") {
        let entry: unknown;
        try {
          entry = ((await req.json()) as { entry?: unknown }).entry;
        } catch {
          return json({ error: "bad json body" }, 400);
        }
        if (typeof entry !== "string" || !isAbsolute(entry)) {
          return json({ error: "entry must be an absolute path to an applet module" }, 400);
        }
        try {
          return json({ ok: true, ...(await register(entry)) });
        } catch (e) {
          if (e instanceof Response) return json({ error: await e.text() }, e.status);
          return json({ error: String(e) }, 500);
        }
      }

      // The manifest an agent reads to learn what it can call.
      if (path === "/tools" && req.method === "GET") {
        return json(applets.flatMap(toolsForApplet));
      }

      // The same manifest as a drop-in agent skill. Generated here, from the
      // applets this daemon actually loaded, so it can never describe verbs the
      // machine doesn't have. `kona tools --skill` is a thin client for it.
      if (path === "/skill" && req.method === "GET") {
        return new Response(skillMarkdown(applets, { base: `${url.protocol}//${url.host}` }), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }

      // Current state of one applet (host initial paint; agent read).
      let m = path.match(/^\/applets\/([^/]+)\/state$/);
      if (m && req.method === "GET") {
        const id = m[1];
        if (!states[id]) return json({ error: "no such applet" }, 404);
        return json(states[id]);
      }

      // Fire a verb. YOU (via host) and the AGENT both land here.
      m = path.match(/^\/applets\/([^/]+)\/verbs\/([^/]+)$/);
      if (m && req.method === "POST") {
        const [, id, verb] = m;
        let args: Record<string, unknown> = {};
        try {
          const body = await req.text();
          if (body) args = JSON.parse(body);
        } catch {
          return json({ error: "bad json body" }, 400);
        }
        try {
          const result = await invoke(id, verb, args);
          return json({ ok: true, result, state: states[id] });
        } catch (e) {
          if (e instanceof Response) return json({ error: await e.text() }, e.status);
          return json({ error: String(e) }, 500);
        }
      }

      // Live state stream. The TUI subscribes; so can an agent that wants to watch.
      if (path === "/events") {
        let push!: (chunk: string) => void;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            push = (chunk) => {
              try {
                controller.enqueue(enc.encode(chunk));
              } catch {}
            };
            subscribers.add(push);
            // greet with a full snapshot so a fresh client paints immediately
            push(`event: snapshot\ndata: ${JSON.stringify(states)}\n\n`);
            // Heartbeat: an idle applet (paused/stopped timer) emits no state for
            // a while; without traffic Bun's idleTimeout closes the socket and the
            // client sees "socket was closed unexpectedly". A comment line keeps
            // the connection warm without waking the applet. It must fire more
            // often than idleTimeout.
            heartbeat = setInterval(() => push(":hb\n\n"), HEARTBEAT_MS);
            heartbeat.unref?.();
          },
          cancel() {
            subscribers.delete(push);
            if (heartbeat) clearInterval(heartbeat);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  // We bound the port (Bun.serve throws on EADDRINUSE) — safe to do work now.

  // --- init: one-shot on boot (e.g. email's first inbox load).
  for (const a of applets) initApplet(a);

  // --- ticks: internal caller, same state, same emit
  for (const a of applets) startTick(a);

  // --- the scheduler: the tick, generalized from a heartbeat to a calendar.
  // Applets declare cron jobs from their own live state (`cron(state)`), so a
  // workflow scheduled a second ago is picked up on the next pass and one that
  // was deleted stops firing — the daemon never learns what a workflow is.
  const scheduler = new CronScheduler();
  const jobsNow = () =>
    applets
      .filter((a) => a.cron)
      .flatMap((a) =>
        (a.cron!(states[a.id]!) ?? []).map((job) => ({ key: `${a.id}:${job.id}:${job.cron}`, applet: a.id, job })),
      );

  const scheduleTick = () => {
    let entries: ReturnType<typeof jobsNow>;
    try {
      entries = jobsNow();
    } catch (e) {
      console.error("[cron] collecting jobs", e);
      return;
    }
    const due = new Set(scheduler.due(entries.map(({ key, job }) => ({ key, cron: job.cron }))));
    for (const { key, applet, job } of entries) {
      if (!due.has(key)) continue;
      void Promise.resolve(invoke(applet, job.verb, { ...(job.args ?? {}) })).catch((e) =>
        console.error(`[cron:${key}]`, e instanceof Response ? e.status : e),
      );
    }
  };

  const schedIv = setInterval(scheduleTick, SCHEDULER_MS);
  schedIv.unref?.();

  console.error(`konad up on http://localhost:${server.port}  (${applets.length} applets)`);
  return server;
}
