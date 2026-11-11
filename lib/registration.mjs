import { execFile } from "node:child_process";
import { access, readlink } from "node:fs/promises";
import { delimiter } from "node:path";
import path from "node:path";
import { promisify } from "node:util";
import { readJSON, writeJSON } from "./files.mjs";
import { discoverInstances, wslInstance } from "./instances.mjs";
import { MANAGED_BY } from "./config.mjs";

const execute = promisify(execFile);
const isMagpie = (file) => /^magpie(?:-(?:windows|linux|darwin)-(?:amd64|arm64|x64|x86_64)(?:-baseline)?)?(?:\.exe)?$/i.test(path.basename(file || ""));

// Magpie is normally the Bun host's parent, including installations whose
// executable is absent from PATH. No shell or process-name scan is needed.
export async function findMagpieExecutable({ executable, platform = process.platform, parent = process.ppid, runner = execute } = {}) {
  if (executable) {
    if (!path.isAbsolute(executable) || !isMagpie(executable)) throw new Error("Magpie 程序路径必须是 magpie、magpie.exe 或官方平台发行文件的绝对路径。");
    await access(executable);
    return executable;
  }
  let inherited = "";
  try {
    if (platform === "win32") {
      const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); (Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(parent)}').ExecutablePath`;
      const result = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: "utf8" });
      inherited = result.stdout.trim();
    } else if (platform === "linux") inherited = await readlink(`/proc/${Number(parent)}/exe`);
    else {
      const result = await runner("/bin/ps", ["-p", String(Number(parent)), "-o", "comm="], { timeout: 5000, maxBuffer: 16384, encoding: "utf8" });
      inherited = result.stdout.trim();
    }
    if (isMagpie(inherited)) { await access(inherited); return inherited; }
  } catch { /* Try the user's normal CLI installation next. */ }
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const file = path.join(directory, platform === "win32" ? "magpie.exe" : "magpie");
    try { await access(file); return path.resolve(file); } catch { /* next */ }
  }
  throw new Error("未能定位 Magpie 程序来清理旧版附加插件；可在主插件选项中指定 magpieExecutable。");
}

// Compatibility for <=0.5 only. New connections NEVER install plugins.
// Use Magpie's own commands to adopt an old connection and remove its
// redundant record; credentials and ARTEX restore journals stay in place.
export class LegacyPluginMigration {
  constructor({ magpieDirectory, executable, runner = execute, find = findMagpieExecutable } = {}) {
    Object.assign(this, { magpieDirectory, executable, runner, find });
  }

  async entries(paths) {
    if (!this.magpieDirectory) return [];
    const list = await readJSON(path.join(this.magpieDirectory, "plugins.json"));
    const normalize = (file) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
    const children = await discoverInstances(paths);
    return (list?.plugins || []).flatMap((entry) => {
      if (typeof entry.spec !== "string" || !path.isAbsolute(entry.spec)) return [];
      const child = children.find((candidate) => normalize(candidate.agentModule) === normalize(entry.spec));
      return child ? [{ ...entry, paths: child }] : [];
    });
  }

  async migrate(paths) {
    const entries = await this.entries(paths);
    const children = await discoverInstances(paths);
    const journal = (child) => path.join(child.dir, "legacy-upgrade.json");
    const pending = [];
    for (const child of children) {
      const saved = await readJSON(journal(child));
      if (saved?.pending) pending.push({ child, saved });
    }
    if (!entries.length && !pending.length) return { removed: 0 };
    const binary = await this.find({ executable: this.executable });
    const run = (args) => this.runner(binary, args, {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(path.basename(this.magpieDirectory) === "magpie" ? { XDG_CONFIG_HOME: path.dirname(this.magpieDirectory) } : {}) },
    });
    let removed = 0;
    for (const entry of entries) {
      const previous = await readJSON(entry.paths.agent);
      if (!entry.off && previous?.managed_by === MANAGED_BY && typeof previous.model === "string") {
        const config = await readJSON(entry.paths.config);
        const saved = { version: 1, pending: true, agent_id: wslInstance(config?.wsl_distro).id, model: previous.model };
        await writeJSON(journal(entry.paths), saved);
        if (!pending.some(({ child }) => child.dir === entry.paths.dir)) pending.push({ child: entry.paths, saved });
      }
      try { await run(["plugin", "rm", entry.spec]); }
      catch { if ((await this.entries(paths)).some((candidate) => candidate.spec === entry.spec)) throw new Error("旧版 ARTEX 附加插件清理尚未完成，连接数据已保留。"); }
      if ((await this.entries(paths)).some((candidate) => candidate.spec === entry.spec)) throw new Error("旧版 ARTEX 附加插件仍在列表中，连接数据已保留。");
      removed++;
    }
    // Removing the obsolete package restores its bridge. Reconnect through
    // the new package's native client, and retry after a host restart using
    // this public journal rather than losing the old model selection.
    for (const { child, saved } of pending) {
      const config = await readJSON(child.config);
      const id = wslInstance(config?.wsl_distro).id;
      if (saved.version !== 1 || saved.agent_id !== id || typeof saved.model !== "string" || !saved.model.includes("/")) throw new Error("旧版 ARTEX 接入迁移记录无效，已保留记录。");
      await run([id, `magpie/${saved.model}`]);
      await writeJSON(journal(child), { version: 1, pending: false });
    }
    return { removed };
  }
}
