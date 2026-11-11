import { MANAGED_BY } from "./config.mjs";
import path from "node:path";
import { pathsFor, readJSON, withLock, writeJSON } from "./files.mjs";
import { discoverInstances, wslInstance } from "./instances.mjs";

// One package supplies a native agent module; this public inventory tells
// Magpie which configured clients use it. No generated plugin registrations.
export async function refreshNativeInstances(root = pathsFor(), { platform = process.platform } = {}) {
  const instances = [];
  const shared = await readJSON(root.agent);
  for (const paths of await discoverInstances(root)) {
    const config = await readJSON(paths.config);
    if (!config) continue;
    const instance = wslInstance(config.wsl_distro);
    const result = await withLock(paths, async () => {
      const state = await readJSON(paths.state);
      if (state?.shared_bridge && !state.independent_agent) {
        if (shared?.managed_by === MANAGED_BY) {
          const previous = await readJSON(paths.agent) || {};
          await writeJSON(paths.agent, { ...previous, ...shared });
          state.inherit_native_agent = true;
        }
        state.independent_agent = true;
        await writeJSON(paths.state, state);
      }
      return { inherit: Boolean(state?.inherit_native_agent) };
    });
    const inherit = result.status === "busy" ? (await readJSON(paths.state))?.inherit_native_agent : result.inherit;
    instances.push({
      id: instance.id, name: instance.name,
      config: path.relative(root.dir, paths.agent).split(path.sep).join("/"),
      dir: path.relative(root.dir, paths.dir).split(path.sep).join("/"),
      ...(inherit ? { inherit: true } : {}),
    });
  }
  const inventory = {
    version: 1,
    includeBase: Boolean(await readJSON(root.config)) || instances.length === 0,
    baseName: platform === "win32" ? "ARTEX · Windows" : "ARTEX · 本机",
    instances,
  };
  // Changing the inventory causes a native agent reload; leave it untouched
  // when an ordinary poll observes the same clients.
  if (JSON.stringify(await readJSON(root.inventory)) !== JSON.stringify(inventory)) await writeJSON(root.inventory, inventory);
  return inventory;
}
