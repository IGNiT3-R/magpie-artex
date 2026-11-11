import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { agent, connect } from "../artex.agent.js";
import { desiredProfile, validateConfig } from "../lib/config.mjs";

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-artex-key" };
const config = validateConfig({ version: 1, url: "http://127.0.0.1:8787/", token: "jwt" });

test("manifest declares an agent and a separate background entry", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.magpie.agent, "./artex.agent.js");
  assert.equal(pkg.magpie.agentInstances, undefined, "the package uses only public host interfaces");
  assert.equal(pkg.main, "./index.mjs");
  assert.equal(agent.id, "artex");
  assert.equal(agent.name, "ARTEX");
  assert.equal(agent.config, "~/.config/magpie-artex/agent.json");
  assert.equal(agent.dir, "~/.config/magpie-artex");
  assert.equal(agent.bin, undefined, "a server integration must not require a nonexistent local CLI");
  assert.equal(pkg.magpie.page, undefined, "settings must not add a separate sidebar page");
  assert.equal(pkg.magpie.panels[0].slot, "settings");
  assert.equal(pkg.magpie.panels.length, 1, "use the official plugin settings slot");
  assert.ok(!pkg.magpie.panels.some((panel) => panel.slot === "agents"), "the Agents page must have no bottom settings panel");
});

test("agent module loads and connects with no Node/browser APIs", async () => {
  const source = (await readFile(new URL("../artex.agent.js", import.meta.url), "utf8")).replace(/export /g, "");
  const result = vm.runInNewContext(`${source}\nconnect(input)`, { input: { gateway, model: { id: "group/daily" } } }, { timeout: 1000 });
  assert.equal(result.format, "openai");
  assert.equal(result.api_key, gateway.key);
});

for (const [endpoints, format, base] of [
  [["/v1/chat/completions"], "openai", gateway.v1],
  [["/v1/responses"], "openai-responses", gateway.v1],
  [["/v1/messages"], "anthropic", gateway.url],
  [undefined, "openai", gateway.v1],
]) {
  test(`native endpoints ${JSON.stringify(endpoints)} select ${format}`, () => {
    const model = { id: "test/model", native_endpoints: endpoints, context: 128000, output: 8192 };
    const fields = connect({ gateway, model });
    assert.equal(fields.format, format);
    assert.equal(fields.base_url, base);
    assert.equal(fields.context_window_k, 128);
    assert.equal(fields.max_tokens, 8192);
    const profile = desiredProfile({ model: model.id, ...fields }, config);
    assert.equal(profile.base_url, base);
    assert.equal(profile.model, model.id);
  });
}

test("gateway override and explicit format use ARTEX's endpoint suffixes", () => {
  const bridge = { model: "group/daily", ...connect({ gateway, model: { id: "group/daily", context: 2_000_000 } }) };
  assert.equal(bridge.context_window_k, 1000);
  const overridden = { ...config, gateway_url: "http://host.docker.internal:3425/v1", format: "anthropic" };
  assert.equal(desiredProfile(bridge, overridden).base_url, "http://host.docker.internal:3425");
  overridden.format = "openai-responses";
  assert.equal(desiredProfile(bridge, overridden).base_url, "http://host.docker.internal:3425/v1");
  assert.equal(desiredProfile({}, config), null);
  assert.throws(() => desiredProfile({ ...bridge, api_key: "" }, config), /有效模型或网关密钥/);
});

test("invalid configuration stops before any credential-bearing request", () => {
  const authenticatedURL = new URL("http://example.test");
  authenticatedURL.username = "fixture-user";
  authenticatedURL.password = "fixture-password";
  for (const url of ["ftp://example.test", authenticatedURL.href, "http://example.test?token=secret"]) {
    assert.throws(() => validateConfig({ version: 1, url, token: "t" }), /HTTP/);
  }
  assert.throws(() => validateConfig({ version: 1, url: "http://localhost", token: "t", format: "bad" }), /格式/);
});
