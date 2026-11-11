import path from "node:path";
import { MANAGED_BY } from "./config.mjs";
import { discoverInstances, wslInstance } from "./instances.mjs";
import { pathsFor, readJSON, withLock, writeJSON } from "./files.mjs";

export const officialJournal = (root) => path.join(root.dir, "official-agent.json");

// The public Agent API supplies one row per package. Adopt the old row's
// bridge and visibility once; credentials and restore journals stay put.
export async function prepareOfficialAgent(root = pathsFor(), { magpieDirectory } = {}) {
  return withLock(root, async () => {
    const journal = await readJSON(officialJournal(root));
    if (journal?.version === 1 && journal.complete) return journal;
    const current = await readJSON(root.agent);
    let source = null, bridge = current, model = null;
    const children = await discoverInstances(root);
    if (current?.managed_by !== MANAGED_BY) {
      for (const child of children) {
        const config = await readJSON(child.config);
        const previous = await readJSON(child.agent);
        const status = await readJSON(child.status);
        const state = await readJSON(child.state);
        if (config && config.enabled !== false && (previous?.managed_by === MANAGED_BY || (state?.connected && status?.model))) {
          source = wslInstance(config.wsl_distro).id;
          bridge = previous?.managed_by === MANAGED_BY ? previous : null;
          model = bridge?.model || status.model;
          break;
        }
      }
    } else if (journal?.source && current.model === journal.model) {
      source = journal.source;
      model = journal.model;
    }
    const result = { version: 1, complete: false, ...(source ? { source, model, native_pending: true } : {}) };
    await writeJSON(officialJournal(root), result);
    if (source && magpieDirectory) {
      const file = path.join(magpieDirectory, "settings.json");
      const settings = await readJSON(file);
      if (settings) {
        for (const key of ["visible", "hiddenModels", "pickedModels", "orderedModels"]) {
          if (!settings[key]) continue;
          const next = { ...settings[key] };
          if (Object.hasOwn(next, source)) next.artex = structuredClone(next[source]);
          else delete next.artex;
          settings[key] = next;
        }
        if (Array.isArray(settings.ownModelsHidden)) {
          settings.ownModelsHidden = settings.ownModelsHidden.filter((id) => id !== "artex");
          if (settings.ownModelsHidden.includes(source)) settings.ownModelsHidden.push("artex");
        }
        await writeJSON(file, settings);
      }
    }
    if (source && bridge) await writeJSON(root.agent, { ...(current || {}), ...bridge });
    else if (!current) await writeJSON(root.agent, {});
    result.complete = true;
    await writeJSON(officialJournal(root), result);
    return result;
  });
}
