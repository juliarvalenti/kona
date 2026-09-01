#!/usr/bin/env bun
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDaemon, api, callVerb } from "../core/client.ts";
import { startDaemon } from "../server/daemon.ts";
import { loadConfig, configDir, defaultConfigToml, resetConfig } from "../core/config.ts";
import { loadPackages, type AppletPackage } from "../core/load.ts";
import { catalogLines, catalogMarkdown } from "../core/catalog.ts";
import { skillMarkdown } from "../core/skill.ts";
import { scaffoldApplet, validId } from "../core/scaffold.ts";
import type { AppletCall, AuthProvider, ToolSpec } from "../sdk/index.ts";

const [cmd, ...rest] = process.argv.slice(2);

// The applets installed on this machine — the CLI's only source of truth about
// them. Loaded once, lazily, because most commands never need it.
let loaded: AppletPackage[] | null = null;
const packages = async (): Promise<AppletPackage[]> => (loaded ??= await loadPackages());

/**
 * Sign-in providers, collected from the applets that own them: `email` declares
 * gmail and outlook, `spotify` declares spotify. There is no table here to
 * append to — an applet that can sign in says so in its own definition.
 */
async function authProviders(): Promise<Record<string, () => Promise<AuthProvider>>> {
  const out: Record<string, () => Promise<AuthProvider>> = {};
  for (const { def } of await packages()) {
    for (const [name, load] of Object.entries(def.auth ?? {})) out[name] ??= load;
  }
  return out;
}

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

async function usage() {
  // Applet-specific invocations and sign-ins are printed from the applets
  // themselves, so this help text never has to learn a new applet's name.
  const pkgs = await packages().catch(() => []);
  const lines = pkgs.map((p) => p.def.cli?.usage).filter(Boolean) as string[];
  const providers = Object.keys(await authProviders().catch(() => ({})));
  console.log(`kona — bimodal terminal applets

  kona                     the configured default applet, else the launcher
  kona launcher            always the launcher: pick an app
  kona <applet> [args]     open an applet's TUI
  kona ls                  list applets
  kona new <id>            scaffold a new applet package (--plugin for one
                           outside the repo)
  kona docs [applet]       the applet catalog, or one applet's README
  kona tools               list agent-callable verbs (the manifest)
  kona tools --json        the same manifest as JSON (args, keys, docs)
  kona tools --skill       render an agent skill from the live manifest
                           (--out <path> / --install to write it to a file)
  kona state <applet>      print an applet's current state
  kona call <applet> <verb> [json]   fire a verb (this is what the agent does)
  kona config [init]       show the resolved config (init writes a starter file)
  kona login [${providers.join("|") || "provider"}]  connect an account
  kona logout <provider> [address]     disconnect one account, or all of them
  kona accounts            list connected mailboxes
  kona notify              desktop notifications: list / on / off / test
  kona daemon              run konad in the foreground
${lines.length ? `\nApplets with their own arguments:\n${lines.map((l) => `  ${l}`).join("\n")}\n` : ""}`);
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
    const providers = await authProviders();
    const svc = rest[0] ?? (await select("sign in to:", Object.keys(providers)));
    const load = providers[svc];
    if (!load) {
      console.error(`unknown provider: ${svc} (have: ${Object.keys(providers).join(", ")})`);
      process.exit(1);
    }
    try {
      const who = await (await load()).login();
      console.log(`signed in as ${who}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    break;
  }

  case "logout": {
    const providers = await authProviders();
    const svc = rest[0] ?? "gmail";
    const load = providers[svc];
    if (!load) {
      console.error(`unknown provider: ${svc} (have: ${Object.keys(providers).join(", ")})`);
      process.exit(1);
    }
    // `kona logout gmail ada@x.com` drops one mailbox; without an address it
    // drops every account of that provider.
    const who = rest[1];
    await (await load()).logout(who);
    console.log(`removed ${who ?? svc} from the keychain`);
    break;
  }

  // What mailboxes are connected, and how to add or drop one.
  case "accounts": {
    const { listAccounts } = await import("../server/mail.ts");
    const accounts = listAccounts();
    if (!accounts.length) {
      console.log("no mail accounts connected — `kona login gmail` or `kona login outlook`");
      break;
    }
    for (const a of accounts) console.log(`${a.provider.padEnd(8)} ${a.id}`);
    console.log(`\nkona login <gmail|outlook>   add another      kona logout <provider> [address]   remove`);
    break;
  }

  case "ls": {
    for (const line of catalogLines(await packages())) console.log(line);
    break;
  }

  // The applet catalog, generated from what is installed — and `kona docs <id>`
  // prints that applet's own README, which is where its prose lives.
  case "docs": {
    const pkgs = await packages();
    const id = rest[0];
    if (!id) {
      console.log(catalogMarkdown(pkgs));
      break;
    }
    const pkg = pkgs.find((p) => p.def.id === id);
    if (!pkg) {
      console.error(`no such applet: ${id}`);
      process.exit(1);
    }
    const readme = join(pkg.dir, "README.md");
    if (!existsSync(readme)) {
      console.error(`${id} ships no README.md (${readme})`);
      process.exit(1);
    }
    console.log(await Bun.file(readme).text());
    break;
  }

  // Scaffold a whole applet package: applet, fixtures, test, docs — one new
  // directory, nothing else touched.
  case "new": {
    const id = rest[0];
    if (!id || !validId(id)) {
      console.error("usage: kona new <id> [--plugin | --out <dir>]   (id: a-z, digits, dashes)");
      process.exit(1);
    }
    const outAt = rest.indexOf("--out");
    const explicit = outAt >= 0 ? rest[outAt + 1] : undefined;
    if (outAt >= 0 && !explicit) {
      console.error("usage: kona new <id> --out <dir>");
      process.exit(1);
    }
    const dir = explicit
      ? resolve(explicit)
      : rest.includes("--plugin")
        ? join(configDir(), "plugins", id)
        : resolve("applets", id);
    if (existsSync(dir)) {
      console.error(`${dir} already exists — pick another id`);
      process.exit(1);
    }
    mkdirSync(dir, { recursive: true });
    for (const file of scaffoldApplet(id, dir)) await Bun.write(join(dir, file.path), file.content);
    console.log(`${dir}\n`);
    for (const file of scaffoldApplet(id, dir)) console.log(`  ${file.path}`);
    console.log(`\nkona ${id}          open it (the daemon restarts itself)`);
    console.log(`bun test ${dir === resolve("applets", id) ? `applets/${id}` : dir}   its own tests, discovered where they live`);
    break;
  }

  // The agent seam, in three shapes: names to skim, JSON to parse, or a
  // ready-to-drop-in skill file rendered from the SAME live manifest — so an
  // agent's instructions can never drift from the applets actually installed.
  case "tools": {
    const skill = rest.includes("--skill");
    const asJson = rest.includes("--json");
    const outAt = rest.indexOf("--out");
    const out = outAt >= 0 ? rest[outAt + 1] : undefined;
    if (outAt >= 0 && !out) {
      console.error("usage: kona tools --skill --out <path>");
      process.exit(1);
    }

    if (skill) {
      // Rendered from the applets on this machine, not from the daemon: the
      // skill is docs, and asking for docs shouldn't start a background
      // process (a SessionStart hook regenerates it on every session).
      const md = skillMarkdown((await packages()).map((p) => p.def));
      // `--install` is the common case spelled out: the project-local skill dir
      // Claude Code (and friends) already look in.
      const dest = out ?? (rest.includes("--install") ? ".claude/skills/kona/SKILL.md" : null);
      if (!dest) {
        console.log(md);
        break;
      }
      await Bun.write(dest, md);
      console.log(`wrote ${dest}`);
      break;
    }

    await ensureDaemon();
    const tools = (await api("/tools")) as ToolSpec[];
    if (asJson) {
      console.log(JSON.stringify(tools, null, 2));
      break;
    }
    // Names, plus the one-liner when the applet documents the verb.
    const width = Math.max(...tools.map((t) => t.name.length), 0);
    for (const t of tools) console.log(t.doc ? `${t.name.padEnd(width)}  ${t.doc}` : t.name);
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
      // The applet half of the starter file comes from the applets themselves.
      const blocks = (await packages()).map((p) => p.def.configSample ?? "");
      await Bun.write(cfg.path, defaultConfigToml(blocks));
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
    const { EVENTS, CONFIG_FILE, readConfig, isEnabled, setEvent, setEnabled, notify, registerEvents } =
      await import("../server/notify.ts");
    // Applets declare the banners they raise; the switchboard lists what is
    // installed, plugins included.
    registerEvents((await packages()).map((p) => p.def));
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
    await usage();
    break;
  }

  default: {
    // `kona <applet> [args...]` — open that applet's TUI.
    await ensureDaemon();
    const pkg = (await packages()).find((p) => p.def.id === cmd);
    if (!pkg) {
      console.error(`no such applet: ${cmd}\n`);
      await usage();
      process.exit(1);
    }
    // What the positional args mean is the APPLET's business: `kona timer 5m`,
    // `kona mycelium ship-kona`. It answers with the verbs to fire before the
    // view opens, from its own `cli.open` — so this file knows no applet by
    // name and a plugin gets the same treatment as a built-in.
    const open = pkg.def.cli?.open;
    if (open) {
      const state = ((await api(`/applets/${cmd}/state`).catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const wanted = open(rest, state);
      const calls: AppletCall[] = wanted ? (Array.isArray(wanted) ? wanted : [wanted]) : [];
      for (const c of calls) await callVerb(cmd, c.verb, c.args ?? {});
    }
    // Applets with a `refresh` verb (e.g. email) get an initial load on open.
    await callVerb(cmd, "refresh", {}).catch(() => {});
    const { runHost } = await import("../host/index.ts");
    await runHost(cmd);
    break;
  }
}
