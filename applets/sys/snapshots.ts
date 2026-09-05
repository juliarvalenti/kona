import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * A few minutes of CPU, deterministic so the gallery shot is stable: an idle
 * hum, then a build that peaks and is winding down as the frame is taken —
 * enough shape for the graph to earn its rows and its colors.
 */
function history(): number[] {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: 96 }, (_, i) => {
    const build = i >= 58 ? 0.36 + 0.6 * Math.sin(((i - 58) / 38) * Math.PI) : 0;
    return Math.min(1, 0.05 + rand() * 0.09 + build);
  });
}

export default defineSnapshots([
  {
    name: "a figlet CPU readout over a thermal graph of the last few minutes, gauges beneath",
    state: {
      host: "laptop",
      platform: "darwin",
      uptime: 268200,
      cpu: 0.42,
      cores: 8,
      load: [1.24, 0.98, 0.81],
      history: history(),
      mem: { used: 10_500_000_000, total: 17_179_869_184 },
      disk: { used: 198_000_000_000, total: 494_384_795_648, mount: "/" },
      battery: { level: 0.87, charging: false, plugged: false, remaining: "3:12" },
      mount: "/",
      sampledAt: 1,
    },
    width: 80,
    height: 24,
    contains: [
      "laptop  ·  darwin  ·  up 3d 2h",
      "██╗", // the CPU percentage is lettered in the figlet
      "8 cores",
      "load  ▂▂▂  1.24  0.98  0.81", // the three averages, and their shape
      "ago ", // the graph's axis names the span it covers...
      " now", // ...and where it ends
      "MEM", "DISK", "BATT",
      " 61%", // memory, self-labeled by the meter
      "9.8G / 16.0G",
      "on battery · 3:12 left",
      "█", // bars have fill
      "░", // ...and an empty remainder
    ],
    excludes: ["CPU 42%"], // the number is the hero, not a gauge row
  },
  {
    name: "a narrow pane drops the figlet and dims metrics the machine doesn't have",
    state: {
      host: "vm",
      platform: "linux",
      uptime: 5400,
      cpu: 0.94,
      cores: 4,
      load: [3.9, 2.1, 1.4],
      history: [0.9, 0.94],
      mem: { used: 15_000_000_000, total: 16_856_133_632 },
      disk: null,
      battery: null,
      mount: "/",
      sampledAt: 1,
    },
    width: 60,
    height: 22,
    contains: ["vm  ·  linux  ·  up 1h 30m", "CPU 94%  ·  4 cores  ·  load 3.90 2.10 1.40", "BATT  no battery", "DISK  unavailable", "4s ago"],
    excludes: ["██╗"],
  },
]);
