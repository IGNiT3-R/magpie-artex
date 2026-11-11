import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathsFor } from "./files.mjs";

export function wslInstance(distro) {
  if (typeof distro !== "string" || !distro.trim() || distro !== distro.trim() || /[\x00-\x1f\\/]/.test(distro) || distro.length > 120) {
    throw new Error("WSL 发行版名称无效。请使用 wsl --list --quiet 中显示的名称。 ");
  }
  const normalized = distro.toLowerCase();
  const slug = normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "distro";
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return { id: `artex-wsl-${slug}-${suffix}`, folder: `wsl-${slug}-${suffix}`, name: `ARTEX · WSL · ${distro}`, distro };
}

export function instancePaths(root = pathsFor(), distro) {
  return distro ? pathsFor(path.join(root.dir, "instances", wslInstance(distro).folder)) : root;
}

export async function discoverInstances(root = pathsFor()) {
  let entries;
  try { entries = await readdir(path.join(root.dir, "instances"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.isDirectory() && /^wsl-[a-z0-9._-]+-[a-f0-9]{8}$/.test(entry.name))
    .map((entry) => pathsFor(path.join(root.dir, "instances", entry.name))).sort((a, b) => a.dir.localeCompare(b.dir));
}
