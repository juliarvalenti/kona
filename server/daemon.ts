import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { AppletDef, AppletState, AppletCtx } from "../sdk/index.ts";
import { toolsForApplet } from "../sdk/index.ts";
import { loadApplets } from "../core/load.ts";

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
  const applets = await loadApplets();
  const byId = new Map<string, AppletDef>(applets.map((a) => [a.id, a]));

  // Applets marked ephemeral (e.g. email) never touch disk — mail stays in RAM.
  const ephemeral = new Set(applets.filter((a) => a.ephemeral).map((a) => a.id));

  // --- state, persisted so the daemon can restart without losing a countdown
  const states: StateMap = {};
  let saved: StateMap = {};
  try {
    saved = JSON.parse(await Bun.file(STATE_FILE).text()) as StateMap;
  } catch {
    saved = {};
  }
  for (const a of applets) {
    states[a.id] = ephemeral.has(a.id) ? { ...a.initialState } : { ...a.initialState, ...saved[a.id] };
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
      state: states[id],
      emit: () => {
        broadcast("state", { applet: id, state: states[id] });
        persist();
      },
    };
  }

  // --- the tick: internal caller, same state, same emit
  for (const a of applets) {
    if (a.tick && a.tickMs) {
      const iv = setInterval(() => {
        try {
          a.tick!(ctxFor(a.id));
        } catch (e) {
          console.error(`[tick:${a.id}]`, e);
        }
      }, a.tickMs);
      // the server keeps the daemon alive; ticks shouldn't pin the event loop
      iv.unref?.();
    }
  }

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

      // The manifest an agent reads to learn what it can call.
      if (path === "/tools" && req.method === "GET") {
        return json(applets.flatMap(toolsForApplet));
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

  console.error(`konad up on http://localhost:${server.port}  (${applets.length} applets)`);
  return server;
}
