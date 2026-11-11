import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Synchronizer } from "../lib/sync.mjs";
import { startPluginRuntime } from "../lib/plugin-runtime.mjs";
import { instancePaths } from "../lib/instances.mjs";
import { prepareOfficialAgent } from "../lib/official-agent.mjs";
import { readJSON, writeJSON, withLock } from "../lib/files.mjs";
import { artexServer, configured, selection, temporaryPaths } from "../test-support/artex.mjs";

test("pausing one connection preserves the shared native selection and other ARTEX clients", async (t) => {
  const root = await temporaryPaths(t), local = await artexServer(t), wsl = await artexServer(t);
  const child = instancePaths(root, "Fixture-Ubuntu");
  await writeJSON(root.config, { version: 1, url: local.url, password: local.password });
  await writeJSON(child.config, { version: 1, url: wsl.url, password: wsl.password });
  await writeJSON(root.agent, selection("fixture/first"));
  const a = new Synchronizer({ paths: root, shared: true });
  const b = new Synchronizer({ paths: child, bridgeFile: root.agent, shared: true });
  await a.sync(); await b.sync();
  await b.disconnect();
  assert.equal(wsl.profiles[0].is_default, true);
  assert.equal(local.profiles[1].is_default, true);
  assert.equal((await readJSON(root.agent)).model, "fixture/first");
  assert.equal((await readJSON(child.config)).enabled, false);
  await writeJSON(root.agent, selection("fixture/second"));
  await a.sync(); await b.sync();
  assert.equal(local.profiles[1].model, "fixture/second");
  assert.equal(wsl.profiles[1].model, "fixture/first");
  const config = await readJSON(child.config);
  await writeJSON(child.config, { ...config, enabled: true });
  await b.sync();
  assert.equal(wsl.profiles[1].model, "fixture/second");
  assert.equal(wsl.profiles[1].is_default, true);
  await writeJSON(root.agent, {});
  await a.sync(); await b.sync();
  assert.ok(local.profiles[0].is_default && wsl.profiles[0].is_default);
});

test("upgrading independent clients preserves a manual default until an explicit native model change", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection("fixture/old") });
  await new Synchronizer({ paths }).sync();
  api.profiles[0].is_default = true; api.profiles[1].is_default = false;
  const shared = new Synchronizer({ paths, shared: true });
  await shared.sync(); await shared.sync();
  assert.equal(api.profiles[0].is_default, true);
  await writeJSON(paths.agent, selection("fixture/new"));
  await shared.sync();
  assert.equal(api.profiles[1].model, "fixture/new");
  assert.equal(api.profiles[1].is_default, true);
  await shared.disconnect();
  assert.equal(api.profiles[0].is_default, true);
});

test("pause waits for a live writer and reports completion only after restoring the connection", async (t) => {
  const { paths, api } = await configured(t);
  const sync = new Synchronizer({ paths, shared: true });
  await sync.sync();
  let ready, release;
  const entered = new Promise((resolve) => { ready = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const held = withLock(paths, async () => { ready(); await barrier; });
  await entered;
  const pausing = sync.disconnect();
  setTimeout(release, 60);
  const result = await pausing;
  await held;
  assert.equal(result.status, "disconnected");
  assert.equal((await readJSON(paths.config)).enabled, false);
  assert.equal(api.profiles[0].is_default, true);
});

test("upgrading differing client models does not silently overwrite a client's active model", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection("fixture/old") });
  await new Synchronizer({ paths }).sync();
  await writeJSON(paths.agent, selection("fixture/shared"));
  const shared = new Synchronizer({ paths, shared: true });
  await shared.sync(); await shared.sync();
  assert.equal(api.profiles[1].model, "fixture/old");
  assert.equal(api.profiles[1].is_default, true);
  await writeJSON(paths.agent, selection("fixture/explicit"));
  await shared.sync();
  assert.equal(api.profiles[1].model, "fixture/explicit");
});

test("upgrade can recover from sanitized status after Magpie has restored the obsolete child bridge", async (t) => {
  const root = await temporaryPaths(t), child = instancePaths(root, "Fixture-Ubuntu");
  await writeJSON(child.config, { version: 1, environment: "wsl", wsl_distro: "Fixture-Ubuntu", password: "fixture-password" });
  await writeJSON(child.agent, {});
  await writeJSON(child.state, { version: 1, connected: true });
  await writeJSON(child.status, { status: "synced", model: "fixture/existing" });
  const credentials = await readFile(child.config, "utf8");
  const result = await prepareOfficialAgent(root);
  assert.equal(result.native_pending, true);
  assert.equal(result.model, "fixture/existing");
  assert.deepEqual(await readJSON(root.agent), {});
  assert.equal(await readFile(child.config, "utf8"), credentials);
});

test("the shared bridge watcher updates WSL without waiting for its poll interval", async (t) => {
  const cleanup = [], resources = { after: (fn) => cleanup.push(fn) };
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); });
  const root = await temporaryPaths(resources), child = instancePaths(root, "Fixture-Ubuntu"), api = await artexServer(resources);
  await writeJSON(child.config, { version: 1, url: api.url, password: api.password });
  await writeJSON(root.agent, selection("fixture/one"));
  const runtime = await startPluginRuntime({ paths: root, interval: 60000 });
  resources.after(() => runtime.stop());
  const until = async (condition) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.fail("shared model change did not reach ARTEX through its watcher");
  };
  await until(() => api.profiles[1]?.model === "fixture/one");
  await writeJSON(root.agent, selection("fixture/two"));
  await until(() => api.profiles[1]?.model === "fixture/two");
});
