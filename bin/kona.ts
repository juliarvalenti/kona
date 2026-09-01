#!/usr/bin/env bun
import { ensureDaemon, api, callVerb, base } from "../core/client.ts";
import { startDaemon } from "../server/daemon.ts";
import { loadConfig, configPath, defaultConfigToml, appletString, resetConfig } from "../core/config.ts";

const [cmd, ...rest] = process.argv.slice(2);

// Auth providers: name -> module exposing login()/logout(). Add a provider here.
const AUTH_PROVIDERS: Record<string, string> = {
  gmail: "../server/google.ts",
  spotify: "../server/spotify.ts",
};

/** Minimal arrow-key selector for the CLI (↑/↓/j/k, enter, esc). */
async function select(prompt: string, options: string[]): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(`${prompt}\n`);
  let idx = 0;
  const draw = (first = false) => {
    if (!first) process.stdout.write(`\x1b[${options.length}A`); // cursor up N lines
    for (const [i, o] of options.entries()) {
      const sel = i === idx;
      process.stdout.write(`\x1b[2K${sel ? "\x1b[36m▸ " : "  "}${o}\x1b[0m\n`);
    }
  };
  draw(true);
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    const done = (v: string | null) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
      if (v === null) process.exit(0);
      resolve(v);
    };
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      if (s === "\x1b[A" || s === "k") idx = (idx - 1 + options.length) % options.length;
      else if (s === "\x1b[B" || s === "j") idx = (idx + 1) % options.length;
      else if (s === "\r" || s === "\n") return done(options[idx]!);
      else if (s === "\x03" || s === "q") return done(null);
      else return;
      draw();
    };
    stdin.on("data", onData);
  });
}

function usage() {
  console.log(`kona — bimodal terminal applets

  kona                     the configured default applet, else the launcher
  kona launcher            always the launcher: pick an app
  kona <applet> [args]     open an applet's TUI  (e.g. kona timer 5m,
                           kona timer pomodoro)
  kona ls                  list applets
  kona tools               list agent-callable verbs (the manifest)
  kona state <applet>      print an applet's current state
  kona call <applet> <verb> [json]   fire a verb (this is what the agent does)
  kona config [init]       show the resolved config (init writes a starter file)
  kona login [gmail|spotify]  connect an account (default gmail)
  kona notify              desktop notifications: list / on / off / test
  kona daemon              run konad in the foreground
`);
}

switch (cmd) {
  case "daemon": {
    await startDaemon();
    await new Promise(() => {});
    break;
  }

  case "dev": {
    // Foreground, auto-reloading daemon with logs. Edit an applet/server file
    // and it restarts; the TUI reconnects on its own.
    const konad = new URL("./konad.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", "--watch", konad], { stdio: ["inherit", "inherit", "inherit"] });
    await proc.exited;
    break;
  }

  case "login": {
    const svc = rest[0] ?? (await select("sign in to:", Object.keys(AUTH_PROVIDERS)));
    const mod = AUTH_PROVIDERS[svc];
    if (!mod) {
      console.error(`unknown provider: ${svc} (have: ${Object.keys(AUTH_PROVIDERS).join(", ")})`);
      process.exit(1);
    }
    try {
      const { login } = await import(mod);
      const who = await login();
      console.log(`signed in as ${who}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    break;
  }

  case "logout": {
    const svc = rest[0] ?? "gmail";
    const mod = AUTH_PROVIDERS[svc];
    if (!mod) {
      console.error(`unknown provider: ${svc} (have: ${Object.keys(AUTH_PROVIDERS).join(", ")})`);
      process.exit(1);
    }
    const { logout } = await import(mod);
    logout();
    console.log(`removed ${svc} token from the keychain`);
    break;
  }

  case "ls": {
    await ensureDaemon();
    const applets = (await api("/applets")) as Array<{ id: string; title: string; summary: string }>;
    for (const a of applets) console.log(`${a.id.padEnd(12)} ${a.summary}`);
    break;
  }

  case "tools": {
    await ensureDaemon();
    const tools = (await api("/tools")) as Array<{ name: string }>;
    for (const t of tools) console.log(t.name);
    break;
  }

  case "state": {
    await ensureDaemon();
    console.log(JSON.stringify(await api(`/applets/${rest[0]}/state`), null, 2));
    break;
  }

  case "call": {
    await ensureDaemon();
    const [id, verb, ...jsonParts] = rest;
    if (!id || !verb) {
      console.error("usage: kona call <applet> <verb> [json]");
      process.exit(1);
    }
    let args: Record<string, unknown> = {};
    const raw = jsonParts.join(" ").trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        console.error("args must be JSON, e.g. '{\"seconds\":300}'");
        process.exit(1);
      }
    }
    console.log(JSON.stringify(await callVerb(id, verb, args), null, 2));
    break;
  }

  case "config": {
    const cfg = loadConfig();
    if (rest[0] === "init") {
      if (await Bun.file(cfg.path).exists()) {
        console.error(`${cfg.path} already exists — not overwriting`);
        process.exit(1);
      }
      await Bun.write(cfg.path, defaultConfigToml());
      resetConfig();
      console.log(`wrote ${cfg.path}`);
      break;
    }
    console.log(`${cfg.path}${cfg.exists ? "" : "  (absent — using defaults)"}\n`);
    console.log(`default   ${cfg.defaultApplet ?? "(launcher)"}`);
    console.log("\ntheme");
    for (const [role, hex] of Object.entries(cfg.theme)) console.log(`  ${role.padEnd(8)} ${hex}`);
    const blocks = Object.entries(cfg.applets);
    if (blocks.length) {
      console.log("\napplets");
      for (const [id, block] of blocks) console.log(`  [${id}] ${JSON.stringify(block)}`);
    }
    if (cfg.errors.length) {
      console.log("\nproblems (ignored, defaults used)");
      for (const e of cfg.errors) console.log(`  ! ${e}`);
    }
    break;
  }

  // Desktop notifications are opt-in per event; this is the switchboard.
  // The daemon re-reads the config file within a second, so toggles are live.
  case "notify": {
    const { EVENTS, CONFIG_FILE, readConfig, isEnabled, setEvent, setEnabled, notify } =
      await import("../server/notify.ts");
    const [action, which] = rest;

    const list = () => {
      const cfg = readConfig();
      console.log(`config: ${CONFIG_FILE()}${cfg.enabled === false ? "   (all notifications OFF)" : ""}\n`);
      for (const [event, spec] of Object.entries(EVENTS)) {
        const on = isEnabled(event);
        console.log(`${on ? "\x1b[32mon \x1b[0m" : "\x1b[90moff\x1b[0m"}  ${event.padEnd(14)} ${spec.summary}`);
      }
      console.log(`\nkona notify on|off <event>|all      kona notify test`);
    };

    switch (action) {
      case undefined:
      case "list":
        list();
        break;
      case "on":
      case "off": {
        const on = action === "on";
        if (!which || which === "all") setEnabled(on);
        else if (EVENTS[which]) setEvent(which, on);
        else {
          console.error(`unknown event: ${which} (have: ${Object.keys(EVENTS).join(", ")})`);
          process.exit(1);
        }
        list();
        break;
      }
      case "test": {
        const event = which ?? "kona.test";
        const result = await notify({
          event,
          title: "kona",
          body: "Desktop notifications are working.",
          key: `test:${Date.now()}`,
        });
        console.log(result === "sent" ? "sent" : `not sent: ${result}`);
        if (result !== "sent") process.exit(1);
        break;
      }
      default:
        console.error(`usage: kona notify [list|on <event>|off <event>|test]`);
        process.exit(1);
    }
    break;
  }

  case undefined: {
    // A bare `kona` opens the configured default applet; with none set (or one
    // that doesn't exist) you get the launcher.
    await ensureDaemon();
    const want = loadConfig().defaultApplet;
    let start: string | null = null;
    if (want) {
      const applets = (await api("/applets")) as Array<{ id: string }>;
      if (applets.some((a) => a.id === want)) start = want;
      else console.error(`config: default = "${want}" is not an applet — opening the launcher`);
    }
    if (start) await callVerb(start, "refresh", {}).catch(() => {});
    const { runHost } = await import("../host/index.ts");
    await runHost(start);
    break;
  }

  case "launcher": {
    await ensureDaemon();
    const { runHost } = await import("../host/index.ts");
    await runHost(null);
    break;
  }

  case "-h":
  case "--help":
  case "help": {
    usage();
    break;
  }

  default: {
    // `kona <applet> [args...]` — open that applet's TUI.
    await ensureDaemon();
    const applets = (await api("/applets")) as Array<{ id: string }>;
    if (!applets.some((a) => a.id === cmd)) {
      console.error(`no such applet: ${cmd}\n`);
      usage();
      process.exit(1);
    }
    // A bare positional arg after the applet name is a convenience: `kona timer 5m`
    // fires the applet's `start` verb with it before opening the view. With no
    // arg, `[applets.timer] default` in config.toml supplies one — but only for
    // an idle timer, so `kona timer` still just opens a countdown in progress.
    if (cmd === "timer") {
      const arg = rest[0] ?? "";
      if (arg === "pomodoro") {
        // `kona timer pomodoro` — a session on the configured plan.
        await callVerb("timer", "pomodoro.start", {});
      } else if (arg) {
        await callVerb("timer", "start", { seconds: arg });
      } else {
        const preset = appletString("timer", "default", "");
        const live = (await api("/applets/timer/state").catch(() => null)) as { remaining?: number } | null;
        if (preset && !(live?.remaining ?? 0)) await callVerb("timer", "start", { seconds: preset });
      }
    }
    // Applets with a `refresh` verb (e.g. email) get an initial load on open.
    await callVerb(cmd, "refresh", {}).catch(() => {});
    const { runHost } = await import("../host/index.ts");
    await runHost(cmd);
    break;
  }
}
