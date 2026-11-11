// Verify the actual Go agent wiring, not a manually written agent.json.
// All Magpie/ARTEX configuration and credentials belong to a temp HOME.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pathsFor, readJSON, writeJSON, writeText } from "../lib/files.mjs";
import { configureInstance } from "../lib/management.mjs";
import { instancePaths, wslInstance } from "../lib/instances.mjs";
import { startPluginRuntime } from "../lib/plugin-runtime.mjs";
import { LegacyPluginMigration } from "../lib/registration.mjs";
import { artexServer, temporaryPaths } from "../test-support/artex.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({ options: { magpie: { type: "string" }, bun: { type: "string" }, preview: { type: "boolean" } } });
assert.ok(values.magpie, "Usage: npm run test:agent -- --magpie <magpie executable> [--bun <bun executable>]");
const target = fileURLToPath(new URL("..", import.meta.url));

test("one installed plugin exposes independent native ARTEX Agents and filtered catalogs", values.preview ? {} : { timeout: 120000 }, async (t) => {
  const cleanup = [], resources = { after: (fn) => cleanup.push(fn) };
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); });
  const home = await temporaryPaths(resources);
  const directory = path.join(home.dir, ".config", "magpie");
  const paths = pathsFor(path.join(home.dir, ".config", "magpie-artex"));
  const api = await artexServer(resources);
  const wslAPI = await artexServer(resources);
  const env = {
    ...process.env, HOME: home.dir, USERPROFILE: home.dir,
    XDG_CONFIG_HOME: path.join(home.dir, ".config"), XDG_CACHE_HOME: path.join(home.dir, ".cache"),
    XDG_DATA_HOME: path.join(home.dir, ".local", "share"),
    MAGPIE_NO_ACCOUNTS: "1", ...(values.bun ? { MAGPIE_BUN: path.resolve(values.bun) } : {}),
  };
  const run = async (...args) => {
    try { return (await execute(path.resolve(values.magpie), args, { cwd: home.dir, env, windowsHide: true, timeout: 35000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
    catch (error) { throw new Error(`Magpie ${args[0]} failed: ${(error.stderr || error.message).slice(-1800)}`); }
  };
  // Same JSON shape the native Magpie settings editor writes. The vendor is
  // deliberately local and no paid inference requests are made by this test.
  await writeJSON(path.join(directory, "providers.json"), { providers: [
    { id: "native-fixture", name: "Native fixture", chat: `${api.url}/v1`, key: "fixture-vendor-key", models: ["model-a", "model-b"] },
  ] });
  await run("plugin", "add", target);
  const initial = await run("ls");
  assert.ok(initial.includes("ARTEX"), "the native detected agents list must contain ARTEX before setup");
  assert.equal(await readJSON(paths.config), null);
  assert.equal(await readJSON(paths.agent), null);
  console.log("Native detected list contains ARTEX before connection setup");
  try { await configureInstance(paths, { environment: "local", url: api.url, password: api.password }); }
  catch (error) { console.error(JSON.stringify({ setupLock: await readJSON(paths.lock).catch(() => null) })); throw error; }
  const runtime = await startPluginRuntime({ paths, magpieDirectory: directory, interval: 500 });
  resources.after(() => runtime.stop());
  const models = await run("models", "artex");
  assert.ok(models.includes("native-fixture/model-a"));
  async function until(predicate) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
    assert.fail("ARTEX did not follow the native Magpie model change");
  }
  await run("artex", "magpie/native-fixture/model-a");
  await until(() => api.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
  await until(() => ["model-a", "model-b"].every((id) => api.profiles.some((p) => p.name === `Magpie · native-fixture/${id}`)));
  console.log("ARTEX profile selectors can list both native Magpie models after one connection");
  const bridge = await readJSON(paths.agent);
  assert.equal(bridge.managed_by, "magpie-artex/v1");
  assert.ok(bridge.api_key && bridge.base_url);
  await run("artex", "magpie/native-fixture/model-b");
  await until(() => api.profiles.some((p) => p.is_default && p.model === "native-fixture/model-b"));
  console.log("Native Magpie model selection and hot switch update ARTEX");

  const child = instancePaths(paths, "Fixture-Ubuntu");
  const keyFile = path.join(home.dir, "gateway-key");
  await writeText(keyFile, "fixture-wsl-key");
  await configureInstance(child, {
    environment: "wsl", wsl_distro: "Fixture-Ubuntu", url: wslAPI.url, password: wslAPI.password,
    gateway_url: "http://fixture-gateway.invalid:3425", gateway_key_file: keyFile,
  });
  const list = await readJSON(path.join(directory, "plugins.json"));
  assert.equal(list.plugins.length, 1, "WSL setup must not install an additional plugin");
  await runtime.scan();
  const wslID = wslInstance("Fixture-Ubuntu").id;
  assert.ok((await run("ls")).includes("ARTEX · WSL"), "one installed plugin must expose a distinct WSL row");
  await run(wslID, "magpie/native-fixture/model-a");
  await until(() => wslAPI.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
  assert.ok(api.profiles.some((p) => p.is_default && p.model === "native-fixture/model-b"), "WSL selection must not switch Windows");
  const prefs = await readJSON(path.join(directory, "settings.json")) || {};
  prefs.pickedModels = { artex: ["native-fixture/model-b"], [wslID]: ["native-fixture/model-a"] };
  await writeJSON(path.join(directory, "settings.json"), prefs);
  await run("artex", "magpie/native-fixture/model-b");
  await run(wslID, "magpie/native-fixture/model-a");
  await until(() => !api.profiles.some((p) => p.model === "native-fixture/model-a"));
  await until(() => !wslAPI.profiles.some((p) => p.model === "native-fixture/model-b"));
  assert.deepEqual((await readJSON(paths.agent)).models.map((m) => m.id), ["native-fixture/model-b"]);
  assert.deepEqual((await readJSON(child.agent)).models.map((m) => m.id), ["native-fixture/model-a"]);
  console.log("Native picked-only filters produce separate ARTEX catalogs and remove unselected models");
  await run("artex", "default");
  await until(() => api.profiles[0].is_default);
  assert.ok(wslAPI.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"), "Windows disconnect must leave WSL connected");
  await run(wslID, "default");
  await until(() => wslAPI.profiles[0].is_default);
  assert.equal(api.profiles[0].api_key, "original-secret-key");
  console.log("Independent native ARTEX Agents restore their defaults without affecting another environment");
  // Reproduce <=0.5's extra installation, then migrate it using the actual
  // Magpie CLI. Only the fixture creates this obsolete second record.
  const oldConfig = JSON.stringify(await readJSON(child.config));
  const oldState = JSON.stringify(await readJSON(child.state));
  await writeText(child.agentModule, `export const agent = ${JSON.stringify({ id: "artex-legacy-fixture", name: "ARTEX legacy fixture", dir: child.dir.replaceAll("\\", "/"), config: child.agent.replaceAll("\\", "/"), model: "model" })};\n`);
  await run("plugin", "add", child.agentModule);
  await new LegacyPluginMigration({ magpieDirectory: directory, executable: path.resolve(values.magpie), runner: (binary, args, options) => execute(binary, args, { ...options, cwd: home.dir, env }) }).migrate(paths);
  assert.equal((await readJSON(path.join(directory, "plugins.json"))).plugins.length, 1);
  assert.equal(JSON.stringify(await readJSON(child.config)), oldConfig);
  assert.equal(JSON.stringify(await readJSON(child.state)), oldState);
  console.log("Actual Magpie removes the legacy extra record while keeping WSL authorization and recovery data");
  if (values.preview) {
    await run(wslID, "magpie/native-fixture/model-a");
    await until(() => wslAPI.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
    async function freePort() {
      const listener = createServer();
      await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const port = listener.address().port;
      await new Promise((resolve) => listener.close(resolve));
      return port;
    }
    const port = await freePort(), servicePort = await freePort();
    const list = await readJSON(path.join(directory, "plugins.json"));
    list.plugins[0].options = { port: servicePort };
    await writeJSON(path.join(directory, "plugins.json"), list);
    const key = "magpie-artex-isolated-preview";
    const child = spawn(path.resolve(values.magpie), ["web", "--addr", `127.0.0.1:${port}`, "--no-open"], {
      cwd: home.dir, env: { ...env, MAGPIE_WEB_KEY: key }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (/plugin:|plugin page:|magpie-artex/.test(line)) console.error(line);
    });
    resources.after(async () => { child.kill(); await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); }); });
    const preview = { preview: `http://127.0.0.1:${port}/?k=${key}`, isolated: true, directory: home.dir, wslID, servicePort };
    await writeJSON(path.join(target, "output", "verification", "preview.json"), preview);
    console.log(JSON.stringify(preview));
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); process.stdin.once("data", resolve); process.stdin.resume(); });
    process.stdin.pause();
  }
});
