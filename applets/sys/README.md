# sys

The machine as a cockpit gauge, built to be left on screen: the CPU percentage
lettered in the theme's figlet, a thermal area graph of the last few minutes
that scrolls in from the right edge (green at the floor, amber, red at the
ceiling), and memory, swap, disk and battery gauges beneath. The frame goes
amber, then red, with whichever gauge is worst. Metrics the machine doesn't
have are dimmed, not blank, and a pane too narrow for the figlet gets a
one-line readout in its place.

```sh
kona sys
kona call sys refresh '{}'
kona call sys mount '{"path":"/Volumes/ext"}'   # point the disk gauge elsewhere
```

macOS and Linux both work — the readings come from `server/sys.ts`, which parses
whatever the platform offers (`vm_stat`/`pmset`, `/proc/meminfo`, `df`).
