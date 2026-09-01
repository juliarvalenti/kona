import { defineSnapshots } from "../../sdk/testing.ts";

export default defineSnapshots([
  {
    name: "draws a labeled gauge per metric with a cpu history line",
    state: {
      host: "laptop",
      platform: "darwin",
      uptime: 268200,
      cpu: 0.42,
      cores: 8,
      load: [1.24, 0.98, 0.81],
      history: [0.1, 0.3, 0.7, 0.42],
      mem: { used: 10_500_000_000, total: 17_179_869_184 },
      disk: { used: 198_000_000_000, total: 494_384_795_648, mount: "/" },
      battery: { level: 0.87, charging: false, plugged: false, remaining: "3:12" },
      mount: "/",
      sampledAt: 1,
    },
    width: 76,
    height: 24,
    contains: [
      "laptop  ·  darwin  ·  up 3d 2h",
      "CPU", "MEM", "DISK", "BATT",
      " 42%", // cpu, self-labeled by the meter
      " 61%", // memory
      "9.8G / 16.0G",
      "on battery · 3:12 left",
      "█", // bars have fill
      "░", // ...and an empty remainder
      "▆", // the cpu sparkline
    ],
  },
  {
    name: "dims metrics the machine doesn't have instead of showing an empty gauge",
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
    contains: ["BATT  no battery", "DISK  unavailable", " 94%"],
  },
]);
