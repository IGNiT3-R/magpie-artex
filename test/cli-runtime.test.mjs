import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startRuntime } from "../lib/runtime.mjs";
import { readJSON, writeJSON } from "../lib/files.mjs";
import { artexServer, configured, selection, temporaryPaths } from "../test-support/artex.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/magpie-artex.mjs", import.meta.url));
const cleanEnv = { ...process.env, ARTEX_PASSWORD: "", ARTEX_TOKEN: "" };

async function until(fn) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(20);
  }
  assert.fail("timed out waiting for the background synchronizer");
}

// Node executes after hooks in registration order. Stop writers before
// deleting their temporary directories, especially on Windows.
function runtimeResources(t) {
  const cleanup = [];
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); });
  return { after: (dispose) => cleanup.push(dispose) };
}

test("CLI setup, sync, status, and disconnect work with the actual ARTEX JSON shapes", async (t) => {
  const paths = await temporaryPaths(t);
  const api = await artexServer(t);
  const run = (cmd, extra = [], env = cleanEnv) => execute(process.execPath, [cli, cmd, "--data-dir", paths.dir, "--json", ...extra], { env, timeout: 10000, windowsHide: true });
  const setup = await run("setup", ["--url", api.url], { ...cleanEnv, ARTEX_PASSWORD: api.password });
  assert.equal(JSON.parse(setup.stdout).status, "configured");
  assert.equal(api.writes.length, 0);
  await writeJSON(paths.agent, selection());
  assert.equal(JSON.parse((await run("sync")).stdout).status, "synced");
  const output = (await run("status")).stdout;
  const status = JSON.parse(output);
  assert.equal(status.active_profile.model, "test/model-a");
  assert.ok(!output.includes(api.password) && !output.includes(api.token) && !output.includes("magpie-test-artex"));
  assert.equal(JSON.parse((await run("disconnect")).stdout).status, "disconnected");
  assert.equal(api.profiles[0].is_default, true);
});

test("token-only setup stores no password and expired tokens return a nonzero exit status", async (t) => {
  const paths = await temporaryPaths(t);
  const api = await artexServer(t);
  await execute(process.execPath, [cli, "setup", "--data-dir", paths.dir, "--url", api.url, "--no-store-password"], {
    env: { ...cleanEnv, ARTEX_PASSWORD: api.password }, timeout: 10000, windowsHide: true,
  });
  assert.equal((await readJSON(paths.config)).password, undefined);
  api.token = "expired";
  await writeJSON(paths.agent, selection());
  await assert.rejects(execute(process.execPath, [cli, "sync", "--data-dir", paths.dir], { env: cleanEnv, timeout: 10000, windowsHide: true }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /登录已过期/);
    return true;
  });
});

test("directory watcher follows atomic file replacement, including disconnect", async (t) => {
  const resources = runtimeResources(t);
  const { paths, api } = await configured(resources, { bridge: null });
  const runtime = await startRuntime({ paths, interval: 60000 });
  resources.after(() => runtime.stop());
  await runtime.tick();
  const temp = `${paths.agent}.atomic-test`;
  await writeFile(temp, JSON.stringify(selection()));
  await rename(temp, paths.agent);
  await until(() => api.profiles.some((p) => p.model === "test/model-a" && p.is_default));
  await writeFile(temp, JSON.stringify(selection("test/watched")));
  await rename(temp, paths.agent);
  await until(() => api.profiles.some((p) => p.model === "test/watched" && p.is_default));
  await writeJSON(paths.agent, {});
  await until(() => api.profiles[0].is_default);
});

test("transient failures retry without overlapping writes or repeating identical log messages", async (t) => {
  const resources = runtimeResources(t);
  const { paths, api } = await configured(resources);
  let fails = true;
  const messages = [];
  api.hook = async (req, res, reply) => {
    if (fails && req.path === "/api/llm/profiles") { reply(res, 503, { error: "database down" }); return true; }
    return false;
  };
  const runtime = await startRuntime({ paths, interval: 60000, log: (message) => messages.push(message) });
  resources.after(() => runtime.stop());
  await runtime.tick();
  await runtime.tick();
  assert.equal(messages.length, 1);
  assert.equal(api.writes.length, 0);
  fails = false;
  await runtime.tick();
  assert.equal(api.profiles[1].is_default, true);
  assert.equal(messages.length, 2);
});
