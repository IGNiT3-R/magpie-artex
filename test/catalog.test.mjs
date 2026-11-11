import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "../artex.agent.js";
import { ArtexClient } from "../lib/client.mjs";
import { readJSON, writeJSON, writeText } from "../lib/files.mjs";
import { Synchronizer } from "../lib/sync.mjs";
import { configured, originalProfile } from "../test-support/artex.mjs";

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "fixture-magpie-catalog-key" };
const models = [
  { id: "vendor/chat", context: 128000, output: 8192, native_endpoints: ["/v1/chat/completions"] },
  { id: "vendor/responses", context: 256000, output: 16384, native_endpoints: ["/v1/responses"] },
  { id: "vendor/claude", context: 200000, output: 16000, native_endpoints: ["/v1/messages"] },
  { id: "group/automatic" },
];
const selection = (id = models[0].id, catalog = models) => ({ model: id, ...connect({ gateway, model: catalog.find((model) => model.id === id), models: catalog }) });
const fixed = (api, model) => api.profiles.find((profile) => profile.name === `Magpie · ${model}`);

test("ARTEX's profile API exposes all Magpie models and routing groups with their native formats", async (t) => {
  const { paths, api, config } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths });
  const result = await sync.sync();
  assert.equal(result.catalog_models, 4);
  assert.match(result.message, /ARTEX 中直接选择/);
  const profiles = await new ArtexClient(config).profiles();
  for (const model of models) assert.ok(profiles.some((profile) => profile.name === `Magpie · ${model.id}` && profile.model === model.id));
  assert.equal(fixed(api, "vendor/chat").format, "openai");
  assert.equal(fixed(api, "vendor/responses").format, "openai-responses");
  assert.equal(fixed(api, "vendor/claude").format, "anthropic");
  assert.equal(fixed(api, "vendor/claude").base_url, gateway.url);
  assert.equal(fixed(api, "vendor/responses").base_url, gateway.v1);
  assert.equal(fixed(api, "vendor/chat").context_window_k, 128);
  assert.equal(fixed(api, "vendor/chat").max_tokens, 8192);
  for (const model of models) {
    assert.equal(fixed(api, model.id).api_key, gateway.key);
    assert.equal(fixed(api, model.id).pool_exclude, true);
  }
  const writes = api.writes.length;
  await new Synchronizer({ paths }).sync();
  assert.equal(api.writes.length, writes, "an unchanged catalog does not write");
  const publicFiles = await readFile(paths.state, "utf8") + await readFile(paths.status, "utf8");
  for (const secret of [gateway.key, api.password, api.token]) assert.ok(!publicFiles.includes(secret));
});

test("choosing a model inside ARTEX survives sync and new catalog entries", async (t) => {
  const { paths, api, config } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths });
  await sync.sync();
  const picked = fixed(api, "vendor/claude");
  await new ArtexClient(config).activate(picked.id);
  picked.streaming = false;
  picked.reasoning_effort = "high";
  picked.rate_per_minute = 15;
  const writes = api.writes.length;
  assert.equal((await sync.sync()).status, "inactive");
  assert.equal(api.writes.length, writes);
  await writeJSON(paths.agent, selection(models[0].id, [...models, { id: "vendor/new" }]));
  assert.equal((await sync.sync()).catalog_models, 5);
  assert.ok(fixed(api, "vendor/new"));
  assert.equal(api.profiles.find((profile) => profile.is_default).id, picked.id);
  assert.equal(fixed(api, "vendor/claude").streaming, false);
  assert.equal(fixed(api, "vendor/claude").reasoning_effort, "high");
  assert.equal(fixed(api, "vendor/claude").rate_per_minute, 15);
  await sync.disconnect();
  assert.equal(api.profiles.find((profile) => profile.is_default).id, picked.id, "disconnect keeps the ARTEX default the user chose");
});

test("ARTEX's own model editor can change the default profile without it being reverted", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths });
  await sync.sync();
  const mainID = (await readJSON(paths.state)).profile_id;
  api.profiles.find((profile) => profile.id === mainID).model = "vendor/claude";
  assert.equal((await sync.sync()).model, "vendor/claude");
  const main = api.profiles.find((profile) => profile.id === mainID);
  assert.equal(main.model, "vendor/claude");
  assert.equal(main.format, "anthropic");
  assert.equal(main.base_url, gateway.url);
  const writes = api.writes.length;
  await sync.sync();
  assert.equal(api.writes.length, writes);
  await writeJSON(paths.agent, selection("vendor/responses"));
  await sync.sync();
  assert.equal(api.profiles.find((profile) => profile.id === mainID).model, "vendor/responses");
});

test("a lost catalog create response is recovered without duplicates", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  let once = true;
  const sync = new Synchronizer({ paths, clientFactory: (config) => {
    const client = new ArtexClient(config);
    const save = client.save.bind(client);
    client.save = async (profile) => {
      const id = await save(profile);
      if (profile.name === "Magpie · vendor/responses" && once) { once = false; throw new Error("lost catalog response"); }
      return id;
    };
    return client;
  } });
  await assert.rejects(sync.sync(), /lost catalog response/);
  assert.equal(api.profiles.filter((profile) => profile.name === "Magpie · vendor/responses").length, 1);
  assert.equal((await new Synchronizer({ paths }).sync()).catalog_models, 4);
  assert.equal(api.profiles.length, 6);
  assert.equal((await readJSON(paths.state)).previous_profile_id, "1");
});

test("catalog sync never adopts an unrelated same-name ARTEX profile", async (t) => {
  const unrelated = { ...originalProfile, id: "2", name: "Magpie · vendor/chat", is_default: false };
  const { paths, api } = await configured(t, { bridge: selection(), initial: [originalProfile, unrelated] });
  await assert.rejects(new Synchronizer({ paths }).sync(), /不会接管/);
  assert.deepEqual(api.profiles.find((profile) => profile.id === "2"), unrelated);
  assert.equal(fixed(api, "vendor/claude"), undefined, "all catalog names are checked before catalog writes");
});

test("every catalog profile uses the WSL-resolved gateway and key", async (t) => {
  const { paths, api, config } = await configured(t, { bridge: selection() });
  const keyFile = path.join(paths.dir, "fixture-gateway-key");
  await writeText(keyFile, "fixture-wsl-magpie-key");
  await writeJSON(paths.config, { ...config, environment: "wsl", wsl_distro: "Fixture-Ubuntu", gateway_url: "http://172.28.0.1:3425", gateway_key_file: keyFile });
  await new Synchronizer({ paths }).sync();
  for (const model of models) {
    const profile = fixed(api, model.id);
    assert.equal(profile.api_key, "fixture-wsl-magpie-key");
    assert.equal(profile.base_url, model.id === "vendor/claude" ? "http://172.28.0.1:3425" : "http://172.28.0.1:3425/v1");
  }
});

test("unchecking a model removes its managed profile and reselection restores ARTEX tuning", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths });
  await sync.sync();
  const oldID = fixed(api, "vendor/claude").id;
  fixed(api, "vendor/claude").reasoning_effort = "high";
  fixed(api, "vendor/claude").streaming = false;
  await writeJSON(paths.agent, selection(models[0].id, models.filter((model) => model.id !== "vendor/claude")));
  assert.equal((await sync.sync()).catalog_models, 3);
  assert.equal(fixed(api, "vendor/claude"), undefined);
  assert.equal(api.profiles.length, 5);
  assert.equal((await readJSON(paths.state)).catalog.find((record) => record.model === "vendor/claude").profile_id, null);
  await writeJSON(paths.agent, selection());
  await sync.sync();
  assert.notEqual(fixed(api, "vendor/claude").id, oldID);
  assert.equal(fixed(api, "vendor/claude").reasoning_effort, "high");
  assert.equal(fixed(api, "vendor/claude").streaming, false);
  assert.equal(fixed(api, "vendor/claude").api_key, gateway.key);
});

test("an empty visible catalog removes every unreferenced catalog entry", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths }); await sync.sync();
  await writeJSON(paths.agent, { ...selection(), models: [] });
  const result = await sync.sync();
  assert.equal(result.catalog_models, 0);
  assert.equal(result.catalog_removed, models.length);
  assert.equal(api.profiles.length, 2, "the existing default and the connection's default profile are preserved");
});

test("default tasks with an explicit null model chain allow cleanup, while an unknown chain postpones it", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths }); await sync.sync();
  api.tasks = [{ llm_profile_ids: null }];
  await writeJSON(paths.agent, selection(models[0].id, models.slice(0, 3)));
  assert.equal((await sync.sync()).catalog_removed, 1);
  api.tasks = [{}];
  await writeJSON(paths.agent, selection(models[0].id, models.slice(0, 2)));
  assert.equal((await sync.sync()).catalog_retained, 1);
  assert.ok(fixed(api, "vendor/claude"));
});

test("unselected defaults, task chains, agents, conversations and manually changed profiles keep their IDs", async (t) => {
  const { paths, api, config } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths }); await sync.sync();
  api.tasks.push({ llm_profile_ids: [Number(fixed(api, "vendor/chat").id)] });
  api.agents.push({ llm_profile_id: Number(fixed(api, "vendor/responses").id) });
  api.conversations.push({ llm_profile_id: Number(fixed(api, "vendor/claude").id) });
  await new ArtexClient(config).activate(fixed(api, "group/automatic").id);
  await writeJSON(paths.agent, { ...selection(), models: [] });
  const result = await sync.sync();
  assert.equal(result.catalog_retained, 4);
  assert.match(result.catalog_notice, /任务\/Agent\/会话/);
  assert.equal(api.requests.filter((request) => request.method === "DELETE").length, 0);
  api.tasks = []; api.agents = []; api.conversations = [];
  fixed(api, "vendor/chat").name = "My edited profile";
  assert.equal((await sync.sync()).catalog_retained, 2, "the default and manually renamed profile remain");
  assert.ok(api.profiles.some((profile) => profile.name === "My edited profile"));
});

test("an unavailable reference list postpones cleanup instead of assuming it is empty", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths }); await sync.sync();
  api.hook = async (req, res, reply) => {
    if (req.path !== "/api/conversations") return false;
    reply(res, 503, { error: "fixture unavailable" }); return true;
  };
  await writeJSON(paths.agent, { ...selection(), models: [] });
  assert.equal((await sync.sync()).catalog_retained, 4);
  assert.equal(api.profiles.length, 6);
  assert.equal(api.requests.filter((request) => request.method === "DELETE").length, 0);
});

test("a lost delete response recovers on restart and still allows reselection", async (t) => {
  const { paths, api } = await configured(t, { bridge: selection() });
  const sync = new Synchronizer({ paths, clientFactory: (config) => {
    const client = new ArtexClient(config), remove = client.remove.bind(client);
    client.remove = async (id) => { await remove(id); throw new Error("fixture lost delete response"); };
    return client;
  } });
  await sync.sync();
  await writeJSON(paths.agent, selection(models[0].id, models.slice(0, 3)));
  assert.equal((await sync.sync()).catalog_retained, 1);
  await new Synchronizer({ paths }).sync();
  await writeJSON(paths.agent, selection());
  assert.equal((await new Synchronizer({ paths }).sync()).catalog_models, 4);
  assert.ok(fixed(api, "group/automatic"));
});

test("malformed catalogs stop before login or model writes", async (t) => {
  const bridge = selection();
  bridge.models.push(bridge.models[0]);
  const { paths, api } = await configured(t, { bridge });
  await assert.rejects(new Synchronizer({ paths }).sync(), /重复/);
  assert.equal(api.writes.length, 0);
  assert.equal(api.logins, 0);
});
