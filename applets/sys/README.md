# sys

Live CPU, memory, disk and battery gauges, sampled in the daemon, with a
sparkline of recent CPU. Metrics the machine doesn't have are dimmed, not blank.

```sh
kona sys
kona call sys refresh '{}'
kona call sys mount '{"path":"/Volumes/ext"}'   # point the disk gauge elsewhere
```

macOS and Linux both work — the readings come from `server/sys.ts`, which parses
whatever the platform offers (`vm_stat`/`pmset`, `/proc/meminfo`, `df`).
