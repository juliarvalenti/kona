# theme

The appearance picker, on two axes. Arrow through the palettes — Catppuccin,
Nord, Dracula, Gruvbox, Tokyo Night, Rosé Pine, Solarized, Everforest, Kanagawa,
One Dark, Ayu and kona's own aloha — and the **whole UI recolors under the
cursor**. `tab` hands the arrows to the **figlet** list beside it, and the same
keys re-letter every hero instead. `enter` writes the combination you are
looking at to `~/.config/kona/config.toml`; `esc` puts back what you had.

```sh
kona theme                                    # the picker
kona theme nord                               # apply a palette and open it
kona theme nord huge                          # ...with a figlet that isn't its own
kona theme tiny                               # ...or just the letters
kona call theme list                          # every preset, every figlet, and what is applied
kona call theme preview '{"preset":"nord","font":"huge"}'   # live, unsaved
kona call theme set '{"preset":"nord","font":"huge"}'       # live, and written
kona call theme font '{"font":"auto"}'        # the face alone — back to the preset's
kona call theme reset                         # back to the saved combination
```

Names are fuzzy on both axes: `mocha`, `Tokyo Night` and `tokyo-night` all land
on the same preset, `hug` lands on `huge`, and an ambiguous one (`light`, or the
`s` that is both `slick` and `shade`) is refused rather than guessed at.

## Two axes, because a preset is a suggestion

Every preset ships a **figlet** — the display typeface hero displays are
lettered in (`theme().font`), which is why the `kona` wordmark at the top of the
picker changes shape as well as color. Dracula letters in `huge`, Gruvbox in the
dithered `shade`, Rosé Pine Dawn in a minimal `tiny`.

But a palette doesn't own a face. The figlet list is its own column with its own
cursor, so "Nord's colors, but the `huge` letters" is something you pick and see
rather than something you hand-edit into a config file. `tab` moves between the
two lists, ↑↓ move whichever one has focus, and the wordmark above them is
always the exact combination `enter` would save.

The figlet column opens on **`auto`** — the row that means "whatever the palette
brings". While the cursor sits there, arrowing through presets re-letters as it
always did and `enter` writes no `font` line at all. Pick a face and it becomes
`[theme] font` in your config, pinned until you come back and choose `auto`
again. That is the whole rule for what ends up in the file: the picker writes
what you are looking at, and nothing you didn't ask for.

Figlets differ enough in size that one can be wider than your terminal. Those
are dimmed in the list, and if you pick one anyway the line under the wordmark
names the narrower face that gets drawn instead — the same fallback every hero
in kona gets, so nothing is saved that you'd never actually see.

## How the live preview works

The preview is not a trick of this applet's view. `theme(state)` in the applet
definition (see `sdk/index.ts`) hands the host a palette that stands in for the
configured one while the applet is open, so the frame, the hint bar and the row
colors all follow the cursor — and navigating away drops it, which is why `esc`
needs no undo step. `set` (and `font`) are the only things that touch disk, and
the running TUI picks the file up on its next frame.

## Presets are a base, not a lock

`[theme] preset = "nord"` is where a preset lives, and any role you spell out in
that same block still wins over it:

```toml
[theme]
preset = "nord"
font   = "huge"      # ...the figlet column, written down
ok     = "#00d488"   # ...but keep kona's green
```

The picker previews that merge (Nord, with your green) rather than the raw
preset, and says which color roles are pinned so a "why didn't that change?" has
an answer on screen. `font` isn't listed among them, because it is not
overriding you any more — it is the row your cursor is on. The palettes
themselves live in `core/themes.ts`, where each one maps onto every semantic
role — body text, the code-block trough, the caret, the scrim — so nothing
renders muddy.
