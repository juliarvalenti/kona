import { defineSnapshots } from "../../sdk/testing.ts";

const ship = () => ({
  source: "fs",
  room: { id: "ship-kona", name: "ship-kona", topic: "getting v0 out", agents: ["planner"], messages: 2, lastAt: 0 },
  agents: [{ name: "planner", status: "thinking", lastSeen: 0 }],
  messages: [
    { id: "1", from: "planner", at: Date.now() - 60_000, text: "who is taking #38?" },
    { id: "2", from: "kona", at: Date.now(), text: "me — the composer is the point" },
  ],
  memory: [],
});

/** The room list, the room itself, and the three states the composer has. */
export default defineSnapshots([
  {
    name: "lists rooms with agent and message counts",
    state: () => ({
      source: "cli",
      syncedAt: Date.now(),
      cursor: 0,
      rooms: [
        { id: "ship-kona", name: "ship-kona", topic: "getting v0 out", agents: ["planner", "coder", "critic"], messages: 42, lastAt: Date.now() },
        { id: "research", name: "research", topic: "", agents: ["scout"], messages: 7, lastAt: Date.now() - 3_600_000 },
      ],
    }),
    width: 80,
    height: 20,
    contains: [
      "2 rooms", "via cli", "ship-kona",
      "3 agents",
      "1 agent", // singular
      "42 msg",
      "●", // recent chatter marker on ship-kona
    ],
  },
  {
    name: "room view shows agents, messages, and shared memory",
    hero: true, // being *in* a room is what the applet is
    state: () => ({
      source: "fs",
      open: {
        source: "fs",
        room: { id: "ship-kona", name: "ship-kona", topic: "getting v0 out", agents: ["planner"], messages: 2, lastAt: 0 },
        agents: [{ name: "planner", status: "thinking", lastSeen: 0 }],
        messages: [
          { id: "1", from: "planner", at: Date.now() - 60_000, text: "split the work into two PRs" },
          { id: "2", from: "coder", at: Date.now(), text: "on it" },
        ],
        memory: [{ key: "repo", value: "juliarvalenti/kona", at: 0 }],
      },
    }),
    width: 80,
    height: 22,
    contains: [
      "getting v0 out",
      "planner (thinking)", // status when reported
      "split the work into two PRs",
      "SHARED MEMORY",
      "juliarvalenti/kona",
    ],
  },
  {
    name: "puts a composer under the room and says how to reach it",
    state: () => ({ source: "fs", writable: true, me: "kona", open: ship() }),
    width: 80,
    height: 20,
    contains: [
      "who is taking #38?",
      "enter to write", // the composer, idle
      "mycelium.post", // ...and how an agent says the same thing
    ],
    collapsed: ["enter write"], // the key that opens it
  },
  {
    name: "shows a sent message before the backend echoes it",
    state: () => ({
      source: "fs",
      writable: true,
      me: "kona",
      open: ship(),
      pending: [{ room: "ship-kona", from: "kona", text: "pushing now", at: Date.now() }],
    }),
    width: 80,
    height: 20,
    contains: ["pushing now", "⋯"], // ...marked as still in flight
  },
  {
    name: "stands the composer down when nothing can write",
    state: () => ({ source: "http", writable: false, me: "kona", open: ship() }),
    width: 80,
    height: 20,
    contains: ["read-only", "MYCELIUM_URL"], // what to connect
    excludes: ["enter to write"], // no composer that would eat your words
  },
  {
    name: "new-room dialog is a real form over the room list",
    state: () => ({
      source: "fs",
      writable: true,
      rooms: [{ id: "ship-kona", name: "ship-kona", topic: "", agents: [], messages: 1, lastAt: Date.now() }],
      dialog: { kind: "room", field: "name", values: { name: "Lit Review", topic: "" } },
    }),
    width: 80,
    height: 20,
    contains: [
      "new room", "Lit Review",
      "lit-review", // the id it will get, previewed live
    ],
    excludes: ["ship-kona"], // the scrim covers the list behind it
  },
  {
    name: "explains how to connect when no backend answered",
    width: 76,
    height: 16,
    contains: ["No coordination layer found", "MYCELIUM_URL", ".mycelium/rooms"],
  },
]);
