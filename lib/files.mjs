import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function pathsFor(directory = path.join(homedir(), ".config", "magpie-artex")) {
  const dir = path.resolve(directory);
  return {
    dir,
    config: path.join(dir, "config.json"),
    agent: path.join(dir, "agent.json"),
    state: path.join(dir, "state.json"),
    status: path.join(dir, "status.json"),
    lock: path.join(dir, "sync.lock"),
    agentModule: path.join(dir, "artex.agent.js"),
    inventory: path.join(dir, "agents.json"),
  };
}

export async function readJSON(file, fallback = null) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${path.basename(file)} 不是有效的 JSON 对象；已停止同步，请修复该文件。`);
  }
}

export async function writeJSON(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function stale(file) {
  try {
    const existing = await readJSON(file);
    return !existing || !running(existing.pid);
  } catch {
    // O_EXCL creates the file before its owner is written. A fresh empty
    // file must not be mistaken for a lock abandoned by a dead process.
    const info = await stat(file).catch(() => null);
    return !info || Date.now() - info.mtimeMs >= 60_000;
  }
}

// Publish a fully written owner atomically. Creating the final file with
// O_EXCL first left an empty lock when Magpie stopped a short-lived Bun
// host between create and write, blocking the first GUI Save for a minute.
async function publishLock(file, owner) {
  const candidate = `${file}.${owner.nonce}.pending`;
  try {
    const handle = await open(candidate, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); }
    finally { await handle.close(); }
    await link(candidate, file);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function acquire(paths, owner) {
  if (await publishLock(paths.lock, owner)) return true;
  if (!await stale(paths.lock)) return false;

  // Serialize reclamation. Without this gate two readers of the same dead
  // owner's lock can each unlink the other's newly acquired live lock.
  const recovery = `${paths.lock}.recover`;
  if (!await publishLock(recovery, owner)) {
    const info = await stat(recovery).catch(() => null);
    if (info && Date.now() - info.mtimeMs >= 60_000 && await stale(recovery)) {
      throw new Error("锁恢复过程曾意外退出；请确认没有同步器运行后，删除配置目录中的 sync.lock.recover，再重试。 ");
    }
    return false;
  }
  try {
    if (!await stale(paths.lock)) return false;
    await rm(paths.lock, { force: true });
    // A normal acquisition may win immediately after the stale file goes.
    return await publishLock(paths.lock, owner);
  } finally {
    await rm(recovery, { force: true });
  }
}

// The host, a CLI, and another Magpie window may run concurrently.
// Never steal a lock held by a live process, even during a slow API call.
export async function withLock(paths, fn) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, nonce: randomUUID() };
  if (!await acquire(paths, owner)) return { status: "busy" };
  try {
    return await fn();
  } finally {
    const current = await readJSON(paths.lock).catch(() => null);
    if (current?.nonce === owner.nonce) await rm(paths.lock, { force: true });
  }
}
