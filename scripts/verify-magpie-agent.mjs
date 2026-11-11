// Run against an unmodified official executable. All credentials, APIs and
// Magpie configuration belong to a temporary HOME; no inference is sent.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pathsFor, readJSON, writeJSON, writeText } from "../lib/files.mjs";
import { configureInstance } from "../lib/management.mjs";
import { instancePaths } from "../lib/instances.mjs";
import { startPluginRuntime } from "../lib/plugin-runtime.mjs";
import { Synchronizer } from "../lib/sync.mjs";
import { LegacyPluginMigration } from "../lib/registration.mjs";
import { artexServer, temporaryPaths } from "../test-support/artex.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({ options: { magpie: { type: "string" }, bun: { type: "string" }, preview: { type: "boolean" } } });
assert.ok(values.magpie, "Pass --magpie <official executable> [--bun <Bun executable>]");
const target = fileURLToPath(new URL("..", import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("official Magpie installs one native ARTEX agent and syncs local/WSL clients without a host patch", values.preview ? {} : { timeout: 120000 }, async (t) => {
  const cleanup = [], resources = { after: (fn) => cleanup.push(fn) };
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); });
  const home = await temporaryPaths(resources), local = await artexServer(resources), wsl = await artexServer(resources);
  const directory = path.join(home.dir, ".config", "magpie");
  const paths = pathsFor(path.join(home.dir, ".config", "magpie-artex"));
  const events = [];
  const env = {
    ...process.env, HOME: home.dir, USERPROFILE: home.dir,
    XDG_CONFIG_HOME: path.join(home.dir, ".config"), XDG_CACHE_HOME: path.join(home.dir, ".cache"),
    XDG_DATA_HOME: path.join(home.dir, ".local", "share"),
    MAGPIE_NO_ACCOUNTS: "1", DO_NOT_TRACK: "1",
    MAGPIE_ADDR: `127.0.0.1:${await freePort()}`,
    ...(values.bun ? { MAGPIE_BUN: path.resolve(values.bun) } : {}),
  };
  const run = async (...args) => {
    try { return (await execute(path.resolve(values.magpie), args, { cwd: home.dir, env, windowsHide: true, timeout: 35000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
    catch { throw new Error(`Official Magpie command ${args[0]} failed; inspect isolated configuration without sharing credentials.`); }
  };
  async function until(predicate, expectation = "ARTEX follows the native model selection") {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
    const bridge = await readJSON(paths.agent);
    // These are isolated fixtures. Print only model/state facts, never
    // the bridge keys, login credentials or complete upstream objects.
    console.error(JSON.stringify({
      expectation, nativeModel: bridge?.model, nativeCatalog: bridge?.models?.map((m) => m.id),
      localProfiles: local.profiles.map(({ model, is_default }) => ({ model, is_default })),
      wslProfiles: wsl.profiles.map(({ model, is_default }) => ({ model, is_default })),
      events: events.slice(-12),
    }));
    assert.fail(expectation);
  }
  await writeJSON(path.join(directory, "settings.json"), { noWSLAgents: true, autoUpdate: false });
  await writeJSON(path.join(directory, "providers.json"), { providers: [{ id: "native-fixture", name: "Fixture", chat: `${local.url}/v1`, key: "fixture-vendor-key", models: ["model-a", "model-b"] }] });
  const version = (await run("version")).trim();
  assert.ok(!version.includes("artex-details"), "use an unmodified official host for this test");
  await run("plugin", "add", target);
  assert.ok((await run("ls")).includes("ARTEX"));
  const plugins = await readJSON(path.join(directory, "plugins.json"));
  assert.equal(plugins.plugins.length, 1);
  const servicePort = await freePort();
  plugins.plugins[0].options = { port: servicePort };
  await writeJSON(path.join(directory, "plugins.json"), plugins);
  await configureInstance(paths, { environment: "local", url: local.url, password: local.password });
  const runtime = await startPluginRuntime({ paths, magpieDirectory: directory, interval: 500, log: (message, level) => events.push({ message, level }) });
  resources.after(() => runtime.stop());
  await run("artex", "magpie/native-fixture/model-a");
  await until(() => local.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
  const child = instancePaths(paths, "Fixture-Ubuntu"), keyFile = path.join(home.dir, "gateway-key");
  await writeText(keyFile, "fixture-wsl-key");
  await configureInstance(child, { environment: "wsl", wsl_distro: "Fixture-Ubuntu", url: wsl.url, password: wsl.password, gateway_url: "http://fixture-gateway.invalid:3425", gateway_key_file: keyFile });
  await runtime.scan();
  await until(() => wsl.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
  await run("artex", "magpie/native-fixture/model-b");
  await until(() => [local, wsl].every((api) => api.profiles.some((p) => p.is_default && p.model === "native-fixture/model-b")));
  const settings = await readJSON(path.join(directory, "settings.json")) || {};
  settings.pickedModels = { artex: ["native-fixture/model-b"] };
  await writeJSON(path.join(directory, "settings.json"), settings);
  await run("artex", "magpie/native-fixture/model-b");
  await until(() => [local, wsl].every((api) => !api.profiles.some((p) => p.model === "native-fixture/model-a")), "Unpicked model is removed from both ARTEX catalogs");
  assert.deepEqual((await readJSON(paths.agent)).models.map((m) => m.id), ["native-fixture/model-b"]);
  const sync = new Synchronizer({ paths: child, bridgeFile: paths.agent, shared: true });
  await sync.disconnect();
  assert.equal(wsl.profiles[0].is_default, true);
  assert.ok(local.profiles.some((p) => p.is_default && p.model === "native-fixture/model-b"));
  settings.pickedModels.artex = ["native-fixture/model-a", "native-fixture/model-b"];
  await writeJSON(path.join(directory, "settings.json"), settings);
  await run("artex", "magpie/native-fixture/model-a");
  await until(() => local.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
  assert.equal(wsl.profiles[0].is_default, true);
  await writeJSON(child.config, { ...await readJSON(child.config), enabled: true });
  await until(() => wsl.profiles.some((p) => p.is_default && p.model === "native-fixture/model-a"));
  await run("artex", "default");
  await until(() => local.profiles[0].is_default && wsl.profiles[0].is_default);
  const oldConfig = await readJSON(child.config);
  await writeText(child.agentModule, `export const agent = ${JSON.stringify({ id: "artex-legacy-fixture", dir: child.dir.replaceAll("\\", "/"), config: child.agent.replaceAll("\\", "/"), model: "model" })};\n`);
  await run("plugin", "add", child.agentModule);
  await new LegacyPluginMigration({ magpieDirectory: directory, executable: path.resolve(values.magpie), runner: (binary, args, options) => execute(binary, args, { ...options, cwd: home.dir, env }) }).migrate(paths);
  assert.equal((await readJSON(path.join(directory, "plugins.json"))).plugins.length, 1);
  assert.deepEqual(await readJSON(child.config), oldConfig);
  console.log(JSON.stringify({ version, singlePlugin: true, nativeModelSwitch: true, visibleModels: true, localAndWSL: true, pauseIsolation: true, nativeDisconnect: true, legacyCleanup: true }));
  if (values.preview) {
    await run("artex", "magpie/native-fixture/model-b");
    const port = await freePort(), key = "fixture-artex-official-preview";
    const process = spawn(path.resolve(values.magpie), ["web", "--addr", `127.0.0.1:${port}`, "--no-open"], { cwd: home.dir, env: { ...env, MAGPIE_WEB_KEY: key }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    process.stderr.resume();
    resources.after(async () => { process.kill(); if (process.exitCode === null) await new Promise((resolve) => process.once("exit", resolve)); });
    await writeJSON(path.join(target, "output", "verification", "official-preview.json"), { url: `http://127.0.0.1:${port}/?k=${key}`, directory: home.dir, servicePort, pid: process.pid, isolated: true });
    console.log("Official preview is ready; its local URL is saved under ignored output/verification.");
    await new Promise((resolve) => { globalThis.process.once("SIGINT", resolve); globalThis.process.once("SIGTERM", resolve); globalThis.process.stdin.once("data", resolve); globalThis.process.stdin.resume(); });
    globalThis.process.stdin.pause();
  }
});
