import { defineSnapshots } from "../../sdk/testing.ts";

/** The space list, a space drilled into, and the unauthenticated state. */
const MIN = 60_000;

const SPACES = [
  ["s1", "ship-kona", "group", 3],
  ["s2", "Grace Hopper", "direct", 40],
  ["s3", "platform-oncall", "group", 95],
  ["s6", "Alan Turing", "direct", 4 * 60],
  ["s4", "design-review", "group", 26 * 60],
  ["s5", "random", "group", 3 * 24 * 60],
] as const;

const spaces = () =>
  SPACES.map(([id, title, kind, mins]) => ({ id, title, kind, lastActivity: Date.now() - mins * MIN }));

// The two 1:1s and who they are with: Grace is at her keyboard, Alan went for
// a walk 40 minutes ago. Times are built off `Date.now()` so the portrait says
// the same thing whenever it is rendered.
const dm = { s2: "p-grace", s6: "p-alan" };
const presence = () => ({
  "p-grace": { id: "p-grace", name: "Grace Hopper", email: "grace@example.com", status: "active", lastActivity: Date.now() },
  "p-alan": { id: "p-alan", name: "Alan Turing", email: "alan@example.com", status: "idle", lastActivity: Date.now() - 40 * MIN },
});

export default defineSnapshots([
  {
    name: "space list is newest first, with a dot on what is unread and who is around",
    hero: true,
    state: () => ({
      authed: true,
      me: "ada@example.com",
      spaces: spaces(),
      dm,
      presence: presence(),
      // Read up to an hour ago: the two busiest spaces still owe you a look.
      seen: { s3: Date.now() - 90 * MIN, s4: Date.now(), s5: Date.now(), s6: Date.now() },
      unread: 2,
      cursor: 0,
      syncedAt: Date.now() - 20_000,
    }),
    width: 84,
    height: 20,
    contains: ["ship-kona", "Grace Hopper", "platform-oncall", "2 unread", "●", "○"],
  },
  {
    name: "a space drilled into shows its messages and how to write back",
    state: () => ({
      authed: true,
      me: "ada",
      spaces: spaces(),
      open: {
        space: { id: "s1", title: "ship-kona", kind: "group", lastActivity: Date.now() },
        messages: [
          { id: "m1", from: "grace", personId: "p1", email: "g@x", text: "shots generator is in — 80x24, one per applet", at: Date.now() - 12 * MIN, files: 0 },
          { id: "m2", from: "ada", personId: "p2", email: "a@x", text: "does the drift test catch a theme change?", at: Date.now() - 7 * MIN, files: 0 },
          { id: "m3", from: "grace", personId: "p1", email: "g@x", text: "it renders fresh and diffs the committed svg, so yes", at: Date.now() - 3 * MIN, files: 0 },
        ],
      },
    }),
    width: 84,
    height: 20,
    contains: ["ship-kona", "3 messages", "grace", "webex.post"],
  },
  {
    name: "a 1:1 says whether the other person is around",
    state: () => ({
      authed: true,
      me: "ada",
      spaces: spaces(),
      dm,
      presence: presence(),
      open: {
        space: { id: "s6", title: "Alan Turing", kind: "direct", lastActivity: Date.now() - 4 * 60 * MIN },
        messages: [
          { id: "m1", from: "Alan Turing", personId: "p-alan", email: "alan@example.com", text: "can you look at the imitation branch?", at: Date.now() - 4 * 60 * MIN, files: 0 },
          { id: "m2", from: "ada", personId: "p-ada", email: "a@x", text: "on it after standup", at: Date.now() - 3.5 * 60 * MIN, files: 0 },
        ],
      },
    }),
    width: 84,
    height: 14,
    contains: ["Alan Turing", "last seen 40m ago", "○"],
  },
  {
    name: "with no credential it says exactly how to connect",
    width: 76,
    height: 18,
    contains: ["Not connected to Webex", "kona login webex"],
  },
]);
