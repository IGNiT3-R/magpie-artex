import { startPluginRuntime } from "./lib/plugin-runtime.mjs";
import { DEFAULT_PAGE_PORT, startPageService } from "./lib/page-service.mjs";
import { LegacyPluginMigration } from "./lib/registration.mjs";
import { pathsFor } from "./lib/files.mjs";

let runtime;
let pageService;

// The sole exported function is intentional: Magpie treats every exported
// function as a plugin factory. Do not re-export CLI/library helpers here.
export default async function ArtexPlugin(input, options = {}) {
  // Magpie renders the native disconnect confirmation by loading plugins
  // inside a copied HOME (agent/preview.go). That copy still contains the
  // real ARTEX URL/login, so a background watcher there would mutate the
  // live service while merely previewing or cancelling a disconnect.
  if (process.env.MAGPIE_DRY_PROVIDERS) return {};
  if (runtime) return {};
  runtime = await startPluginRuntime({
    magpieDirectory: input?.directory,
    interval: Number.isInteger(options.pollIntervalMs) ? Math.max(500, Math.min(60000, options.pollIntervalMs)) : undefined,
    log: (message, level) => {
      const write = input?.client?.app?.log;
      if (write) {
        Promise.resolve(write({ body: { service: "magpie-artex", level, message } })).catch(() => {});
      } else {
        console.error(`[magpie-artex] ${message}`);
      }
    },
  });
  const configuredPort = Number(options.port);
  let waiting = false;
  async function openPage() {
    try {
      pageService = await startPageService({
        port: Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : DEFAULT_PAGE_PORT,
        magpieDirectory: input?.directory, runtime,
      });
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      // GUI reload and a short-lived Magpie CLI can overlap. Keep the
      // model adapter alive, then bind when the previous host releases it.
      if (!waiting) console.error("[magpie-artex] 设置端口暂被占用，正在等待宿主重载完成并自动重试。");
      waiting = true;
      const retry = setTimeout(() => {
        void openPage().catch((error) => console.error(`[magpie-artex] ${error.message}`));
      }, 500);
      retry.unref();
      return;
    }
    // Removing an old record can restart this host. Do it after the new
    // service is ready, so its page can reconnect after that restart.
    const migration = setTimeout(() => {
      const upgrader = new LegacyPluginMigration({ magpieDirectory: input?.directory, executable: options.magpieExecutable });
      void upgrader.migrate(pathsFor()).then(() => upgrader.reconnectOfficial(pathsFor()))
        .catch((error) => console.error(`[magpie-artex] ${error.message}`));
    }, 1000);
    migration.unref();
  }
  try { await openPage(); }
  catch (error) {
    await runtime.stop(); runtime = undefined;
    throw error;
  }
  return {};
}
