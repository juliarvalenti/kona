# notes

A notepad. A note has a **title** and a **multi-line body**; the list shows
titles with a preview, `enter` opens one to read, and the composer edits it in
place. Everything persists with the daemon's state, and every mutation undoes.

```sh
kona notes
kona call notes add '{"title":"release plan","body":"cut rc1 friday\nfreeze monday"}'
kona call notes add '{"text":"standup\nkona notes\nthe editor"}'   # first line titles it
kona call notes edit '{"id":"a1b2c3d4","body":"cut rc1 friday\nfreeze tuesday"}'
kona call notes search '{"q":"release"}'
kona call notes remove '{"id":"a1b2c3d4"}'
kona call notes undo '{}'
```

At the keyboard: `n` writes a new note, `enter` reads the selected one, `e`
edits it, `d` deletes it, `u` undoes, and `/` **searches** titles and bodies
(it never creates — that is what `n` is for). `esc` backs out one level: the
open note, then the filter, then the launcher.

The composer is a modal with two real fields — a one-line title and a textarea
for the body. In the body, `enter` inserts a newline and **`ctrl+d` saves**;
`tab` moves between the fields; `esc` discards. Each keystroke writes through to
state, so an agent watching `kona state notes` sees the note being typed, and
`notes.save` can finish a composer a human opened (or the other way round).
