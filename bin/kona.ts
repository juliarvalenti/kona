#!/usr/bin/env bun
import { ensureDaemon, api, callVerb, base } from "../core/client.ts";
import { startDaemon } from "../server/daemon.ts";

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`kona — bimodal terminal applets

  kona                     launcher: pick an app
  kona <applet> [args]     open an applet's TUI  (e.g. kona timer 5m)
  kona ls                  list applets
  kona tools               list agent-callable verbs (the manifest)
  kona state <applet>      print an applet's current state
  kona call <applet> <verb> [json]   fire a verb (this is what the agent does)
  kona login                connect Gmail (Google OAuth, read-only)
  kona daemon              run konad in the foreground
`);
}

switch (cmd) {
  case "daemon": {
    await startDaemon();
    await new Promise(() => {});
    break;
  }

  case "login": {
    const { login } = await import("../server/google.ts");
    try {
      const who = await login();
      console.log(`signed in as ${who}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    break;
  }

  case "logout": {
    const { logout } = await import("../server/google.ts");
    logout();
    console.log("removed Gmail token from the keychain");
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

  case undefined:
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
    // fires the applet's `start` verb with it before opening the view.
    if (rest.length && cmd === "timer") {
      await callVerb("timer", "start", { seconds: rest[0] });
    }
    // Applets with a `refresh` verb (e.g. email) get an initial load on open.
    await callVerb(cmd, "refresh", {}).catch(() => {});
    const { runHost } = await import("../host/index.ts");
    await runHost(cmd);
    break;
  }
}
