# storybook

A live gallery of every kona component — progress bars, gauges, sparklines,
tabs, toasts, cards, a modal on the overlay layer, and a real text field.

```sh
kona storybook
kona call storybook save '{"value":"ada"}'   # fill the demo field with no keyboard
```

It doubles as the SDK's rendering regression test: `snapshots.ts` here asserts
that every widget is on screen, so a change to `sdk/components.ts` or the host's
stage that breaks a widget fails the suite. If you add a component, add it to
the gallery.
