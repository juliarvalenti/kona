# notes

A scratchpad that survives restarts — jotted lines, newest first, persisted with
the daemon's state.

```sh
kona notes
kona call notes add '{"text":"ship the skill generator"}'
kona call notes edit '{"id":"a1b2c3d4","text":"ship it tomorrow"}'
kona call notes remove '{"index":0}'
kona call notes undo '{}'
```

Every mutation is undoable — `u` in the TUI, `notes.undo` for an agent. `n`
opens the composer, `e` edits the selected line, `d` deletes it.
