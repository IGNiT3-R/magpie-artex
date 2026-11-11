import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { LegacyPluginMigration } from "../lib/registration.mjs";
import { instancePaths, wslInstance } from "../lib/instances.mjs";
import { readJSON, writeJSON, writeText } from "../lib/files.mjs";
import { artexServer, selection, temporaryPaths } from "../test-support/artex.mjs";
import { prepareOfficialAgent, officialJournal } from "../lib/official-agent.mjs";

const fixtureDistro = "Fixture-Ubuntu";
const fixtureAgentID = wslInstance(fixtureDistro).id;

test("a fresh single-plugin install never runs an installation or cleanup command", async (t) => {
  const paths = await temporaryPaths(t);
  const directory = path.join(paths.dir, "magpie");
  await writeJSON(path.join(directory, "plugins.json"), { plugins: [{ spec: "magpie-agent-artex" }] });
  const migration = new LegacyPluginMigration({ magpieDirectory: directory, find: () => assert.fail("no executable is needed for a fresh install") });
  assert.deepEqual(await migration.migrate(paths), { removed: 0 });
});

test("upgrade removes only legacy ARTEX records, preserves credentials and journals, and tolerates host restart", async (t) => {
  const paths = await temporaryPaths(t), child = instancePaths(paths, fixtureDistro);
  const directory = path.join(paths.dir, "magpie"), file = path.join(directory, "plugins.json");
  await writeJSON(child.config, { version: 1, password: "fixture-private-password", environment: "wsl", wsl_distro: fixtureDistro });
  await writeJSON(child.state, { version: 1, profile_id: "17", previous_profile_id: "2", connected: true });
  await writeText(child.agentModule, "// legacy module fixture");
  await writeJSON(paths.agent, selection("vendor/shared"));
  const keep = [{ spec: "third-party", options: { preserve: true } }, { spec: "main-artEx", options: { port: 3479 } }, { spec: path.join(paths.dir, "unrelated.agent.js") }];
  await writeJSON(file, { plugins: [...keep, { spec: child.agentModule }], config: { provider: { preserve: true } } });
  const beforeConfig = await readFile(child.config, "utf8"), beforeState = await readFile(child.state, "utf8");
  const calls = [];
  const migration = new LegacyPluginMigration({ magpieDirectory: directory, find: async () => "fixture-magpie", runner: async (binary, args, options) => {
    calls.push({ binary, args, hidden: options.windowsHide });
    const list = await readJSON(file); list.plugins = list.plugins.filter((entry) => entry.spec !== args[2]); await writeJSON(file, list);
    throw new Error("fixture host restarted after persistence");
  } });
  assert.deepEqual(await migration.migrate(paths), { removed: 1 });
  assert.deepEqual(calls, [{ binary: "fixture-magpie", args: ["plugin", "rm", child.agentModule], hidden: true }]);
  assert.deepEqual((await readJSON(file)).plugins, keep);
  assert.deepEqual((await readJSON(file)).config, { provider: { preserve: true } });
  assert.equal(await readFile(child.config, "utf8"), beforeConfig);
  assert.equal(await readFile(child.state, "utf8"), beforeState);
  assert.deepEqual(await migration.migrate(paths), { removed: 0 });
});

test("legacy migration reconnects through the official ARTEX row", async (t) => {
  const paths = await temporaryPaths(t), child = instancePaths(paths, fixtureDistro);
  const directory = path.join(paths.dir, "magpie"), file = path.join(directory, "plugins.json");
  await writeJSON(child.agent, selection("vendor/existing"));
  await writeJSON(child.config, { environment: "wsl", wsl_distro: fixtureDistro });
  await writeJSON(file, { plugins: [{ spec: "main" }, { spec: child.agentModule }] });
  const calls = [];
  const migration = new LegacyPluginMigration({ magpieDirectory: directory, find: async () => "fixture", runner: async (_binary, args) => {
    calls.push(args);
    if (args[0] === "artex") await writeJSON(child.agent, selection("vendor/existing"));
    else await writeJSON(file, { plugins: [{ spec: "main" }] });
  } });
  assert.deepEqual(await migration.migrate(paths), { removed: 1 });
  assert.deepEqual(calls, [["plugin", "rm", child.agentModule], ["artex", "magpie/vendor/existing"]]);
  assert.equal((await readJSON(child.agent)).model, "vendor/existing");
  assert.equal(await readJSON(paths.agent), null);
});

test("unifying old WSL clients adopts the bridge and native visibility once without touching authorization or recovery", async (t) => {
  const root = await temporaryPaths(t), child = instancePaths(root, fixtureDistro), api = await artexServer(t);
  await writeJSON(child.config, { version: 1, url: api.url, password: api.password, environment: "wsl", wsl_distro: fixtureDistro, gateway_url: "http://fixture.invalid:3425" });
  await writeJSON(child.agent, selection("vendor/old"));
  await writeJSON(child.state, { version: 1, connected: true, shared_bridge: true, profile_id: "17", previous_profile_id: "2" });
  const credentials = await readFile(child.config, "utf8");
  const directory = path.join(root.dir, "magpie");
  await writeJSON(path.join(directory, "settings.json"), { theme: "dark", pickedModels: { [fixtureAgentID]: ["vendor/old"], codex: ["fixture/keep"] }, ownModelsHidden: [fixtureAgentID], hiddenModels: { artex: ["stale/value"], codex: ["fixture/hidden"] } });
  const stateBefore = await readFile(child.state, "utf8");
  const result = await prepareOfficialAgent(root, { magpieDirectory: directory });
  assert.equal(result.native_pending, true);
  assert.equal((await readJSON(root.agent)).model, "vendor/old");
  assert.equal((await readJSON(child.agent)).model, "vendor/old");
  const preferences = await readJSON(path.join(directory, "settings.json"));
  assert.deepEqual(preferences.pickedModels.artex, ["vendor/old"]);
  assert.deepEqual(preferences.pickedModels.codex, ["fixture/keep"]);
  assert.equal(preferences.hiddenModels.artex, undefined);
  assert.ok(preferences.ownModelsHidden.includes("artex"));
  assert.equal((await readJSON(child.state)).profile_id, "17");
  assert.equal((await readJSON(child.state)).previous_profile_id, "2");
  await writeJSON(root.agent, selection("vendor/explicit"));
  await prepareOfficialAgent(root, { magpieDirectory: directory });
  assert.equal((await readJSON(root.agent)).model, "vendor/explicit", "migration must never overwrite a later native choice");
  assert.equal((await readJSON(child.agent)).model, "vendor/old");
  assert.equal(await readFile(child.config, "utf8"), credentials);
  assert.equal(await readFile(child.state, "utf8"), stateBefore);
  assert.equal(api.writes.length, 0);
});

test("official reconnection retries after a restart and a subsequent disconnect is not reimported", async (t) => {
  const root = await temporaryPaths(t);
  await writeJSON(root.agent, selection("fixture/existing"));
  await writeJSON(officialJournal(root), { version: 1, complete: true, native_pending: true, model: "fixture/existing" });
  const calls = [];
  const migration = new LegacyPluginMigration({ find: async () => "fixture", runner: async (_binary, args) => { calls.push(args); } });
  await migration.reconnectOfficial(root);
  assert.deepEqual(calls, [["artex", "magpie/fixture/existing"]]);
  await writeJSON(root.agent, {});
  await prepareOfficialAgent(root);
  await migration.reconnectOfficial(root);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readJSON(root.agent), {});
});
