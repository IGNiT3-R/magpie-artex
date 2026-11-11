import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pathsFor } from "./files.mjs";
import { Synchronizer } from "./sync.mjs";

export async function startRuntime({ paths = pathsFor(), interval = 5000, keepAlive = false, log = () => {}, synchronizer = new Synchronizer({ paths }) } = {}) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  let stopped = false;
  let pending = null;
  let rerun = false;
  let debounce;
  let last = "";
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (pending) { rerun = true; return pending; }
    pending = (async () => {
      do {
        rerun = false;
        try {
          const result = await synchronizer.sync();
          if (result.status === "busy") continue;
          const message = `${result.status}: ${result.message}`;
          if (message !== last) { log(message, "info"); last = message; }
        } catch (error) {
          if (error.message !== last) { log(error.message, "error"); last = error.message; }
        }
      } while (rerun && !stopped);
    })().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(tick, interval);
  if (!keepAlive) timer.unref();
  // Watch the directory because Magpie replaces the file atomically.
  // Polling remains available if fs.watch is unavailable or loses an event.
  let watcher;
  let bridgeWatcher;
  try {
    watcher = watch(paths.dir, { persistent: keepAlive }, (_event, file) => {
      if (file && !["agent.json", "config.json"].includes(String(file))) return;
      clearTimeout(debounce);
      debounce = setTimeout(tick, 250);
      if (!keepAlive) debounce.unref();
    });
    watcher.on("error", () => { watcher.close(); });
  } catch { /* Polling covers directories without watch support. */ }
  if (synchronizer.bridgeFile && synchronizer.bridgeFile !== paths.agent) {
    try {
      const bridgePath = await import("node:path");
      bridgeWatcher = watch(bridgePath.dirname(synchronizer.bridgeFile), { persistent: keepAlive }, (_event, file) => {
        if (file && String(file) !== bridgePath.basename(synchronizer.bridgeFile)) return;
        clearTimeout(debounce);
        debounce = setTimeout(tick, 250);
        if (!keepAlive) debounce.unref();
      });
      bridgeWatcher.on("error", () => bridgeWatcher.close());
    } catch { /* Polling also follows the shared native bridge. */ }
  }
  void tick();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(debounce);
      watcher?.close();
      bridgeWatcher?.close();
      await pending;
    },
  };
}
