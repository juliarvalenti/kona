# theme

The palette picker. Arrow through the presets — Catppuccin, Nord, Dracula,
Gruvbox, Tokyo Night, Rosé Pine, Solarized, Everforest, Kanagawa, One Dark, Ayu
and kona's own aloha — and the **whole UI recolors under the cursor**. `enter`
writes the one you land on to `~/.config/kona/config.toml`; `esc` puts back what
you had.

```sh
kona theme                                    # the picker
kona theme nord                               # apply one and open it
kona call theme list                          # every preset, and which is applied
kona call theme preview '{"preset":"tokyo-night"}'   # live, unsaved
kona call theme set '{"preset":"catppuccin-mocha"}'  # live, and written
kona call theme reset                         # back to the saved preset
```

Names are fuzzy: `mocha`, `Tokyo Night` and `tokyo-night` all land on the same
preset, and an ambiguous one (`light`) is refused rather than guessed at.

## How the live preview works

The preview is not a trick of this applet's view. `theme(state)` in the applet
definition (see `sdk/index.ts`) hands the host a palette that stands in for the
configured one while the applet is open, so the frame, the hint bar and the row
colors all follow the cursor — and navigating away drops it, which is why `esc`
needs no undo step. `set` is the only thing that touches disk, and the running
TUI picks the file up on its next frame.

## Presets are a base, not a lock

`[theme] preset = "nord"` is where a preset lives, and any role you spell out in
that same block still wins over it:

```toml
[theme]
preset = "nord"
ok     = "#00d488"   # ...but keep kona's green
```

The picker previews that merge (Nord, with your green) rather than the raw
preset, and says which roles are pinned so a "why didn't that change?" has an
answer on screen. The palettes themselves live in `core/themes.ts`, where each
one maps onto every semantic role — body text, the code-block trough, the caret,
the scrim — so nothing renders muddy.
