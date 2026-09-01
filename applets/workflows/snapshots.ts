import { defineSnapshots } from "../../sdk/testing.ts";

/**
 * Rendering regressions for workflows, shipped with the applet. The runner
 * (tests/snapshot.test.ts) discovers this file; nothing central lists it.
 */
const WF_MORNING = {
  id: "morning",
  name: "morning",
  summary: "Start the day",
  steps: [
    { applet: "email", verb: "refresh", as: "inbox" },
    { applet: "notes", verb: "add", args: { text: "{{steps.inbox.unread}} unread" }, when: "steps.inbox.unread" },
  ],
  cron: "30 8 * * 1-5",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

export default defineSnapshots([
  {
    name: "lists what each one does, when it runs, and how it went",
    state: () => ({
      workflows: [
        WF_MORNING,
        { id: "triage", name: "triage", summary: "", steps: [{ applet: "email", verb: "refresh" }], cron: null, enabled: true, createdAt: 0, updatedAt: 0 },
      ],
      runs: [{ id: "r1", workflow: "morning", name: "morning", at: Date.now() - 120_000, ms: 42, ok: true, trigger: "cron", steps: [] }],
      cursor: 0,
    }),
    width: 84,
    height: 20,
    contains: [
      "2 defined",
      "1 scheduled",
      "weekdays at", // the cron expression, in words
      "2 steps",
      "manual", // the unscheduled one
      "✓ 2m ago",
      "next: morning",
    ],
  },
  {
    name: "an empty applet shows both ways to make one",
    width: 84,
    height: 16,
    contains: [
      "no workflows yet",
      "press n", // the keyboard's way
      "workflows define", // ...and the agent's
    ],
  },
  {
    name: "opening a workflow shows its steps and its last runs",
    state: () => ({
      workflows: [WF_MORNING],
      open: "morning",
      cursor: 0,
      runs: [
        {
          id: "r1",
          workflow: "morning",
          name: "morning",
          at: Date.now(),
          ms: 42,
          ok: true,
          trigger: "cron",
          steps: [
            { applet: "email", verb: "refresh", args: {}, ok: true, ms: 30 },
            { applet: "notes", verb: "add", args: {}, ok: true, ms: 12 },
          ],
        },
      ],
    }),
    width: 84,
    height: 24,
    contains: [
      "MORNING",
      "Start the day",
      "email.refresh",
      "as inbox",
      "when steps.inbox.u", // the conditional, on its row
      "RUNS",
      "✓✓", // one mark per step
      "cron",
      "enter test step", // enter tests a step in here
    ],
  },
  {
    name: "the schedule dialog says what the typed expression means",
    state: {
      workflows: [{ ...WF_MORNING, cron: null }],
      dialog: { kind: "cron", target: "morning", value: "30 8 * * 1-5" },
    },
    width: 84,
    height: 18,
    contains: [
      "schedule", // the modal's title
      "30 8 * * 1-5", // ...the field
      "weekdays at 08:30", // ...and the live gloss under it
      "enter save",
      "╔", // a real overlay, not drawn inline
    ],
  },
  {
    name: "the step builder names the format it wants",
    state: { workflows: [WF_MORNING], dialog: { kind: "step", target: "morning", value: "" } },
    width: 84,
    height: 18,
    contains: [
      "add step",
      'timer.start {"seconds":300}', // the placeholder
      "kona tools",
    ],
  },
]);
