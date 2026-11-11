import { pathsFor, readJSON } from "./files.mjs";
import { discoverInstances } from "./instances.mjs";
import { prepareOfficialAgent } from "./official-agent.mjs";
import { startRuntime } from "./runtime.mjs";
import { Synchronizer } from "./sync.mjs";
import { ConnectionResolver } from "./wsl.mjs";

// One official native ARTEX row feeds all enabled connections. Credentials,
// network resolution, pause state and restoration remain per connection.
export async function startPluginRuntime({ paths = pathsFor(), magpieDirectory, interval, scanInterval = 1000, log = () => {}, connectionResolver = new ConnectionResolver({ magpieDirectory }) } = {}) {
  const workers = new Map();
  const failures = new Map();
  let stopped = false;
  let scanning;
  async function scan() {
    if (stopped) return;
    if (scanning) return scanning;
    scanning = (async () => {
      const prepared = await prepareOfficialAgent(paths, { magpieDirectory });
      if (prepared.status === "busy" || (prepared.native_pending && (await readJSON(paths.agent))?.managed_by !== "magpie-artex/v1")) return;
      const wanted = [paths, ...await discoverInstances(paths)];
      for (const child of wanted) {
        if (stopped || workers.has(child.dir)) continue;
        let config;
        try { config = await readJSON(child.config); }
        catch (error) {
          if (failures.get(child.dir) !== error.message) log(`[${child.dir === paths.dir ? "本机" : "WSL"}] ${error.message}`, "error");
          failures.set(child.dir, error.message);
          continue;
        }
        failures.delete(child.dir);
        const label = config?.wsl_distro ? `WSL · ${config.wsl_distro}` : "本机";
        const configuredPoll = interval ?? config?.poll_interval_ms;
        const poll = Number.isInteger(configuredPoll) ? configuredPoll : 5000;
        const worker = await startRuntime({
          paths: child, interval: Math.max(500, Math.min(60000, poll)),
          synchronizer: new Synchronizer({ paths: child, bridgeFile: paths.agent, shared: true, connectionResolver }),
          log: (message, level) => log(`[${label}] ${message}`, level),
        });
        workers.set(child.dir, worker);
      }
      for (const [directory, worker] of workers) {
        if (!wanted.some((child) => child.dir === directory)) {
          await worker.stop();
          workers.delete(directory);
        }
      }
    })().finally(() => { scanning = null; });
    return scanning;
  }
  await scan();
  const timer = setInterval(() => { void scan().catch((error) => log(error.message, "error")); }, scanInterval);
  timer.unref();
  return {
    scan,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await scanning;
      await Promise.all([...workers.values()].map((worker) => worker.stop()));
      workers.clear();
    },
  };
}
