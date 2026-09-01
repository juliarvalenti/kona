#!/usr/bin/env bun
import { startDaemon } from "../server/daemon.ts";

await startDaemon();
// keep the process alive
await new Promise(() => {});
