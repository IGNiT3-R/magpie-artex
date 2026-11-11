import assert from "node:assert/strict";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";
import { startPageService } from "../lib/page-service.mjs";
import { findMagpieExecutable } from "../lib/registration.mjs";
import { pathsFor, readJSON, writeJSON, writeText } from "../lib/files.mjs";
import { instancePaths } from "../lib/instances.mjs";
import { artexServer, selection, temporaryPaths } from "../test-support/artex.mjs";

async function page(t, options = {}) {
  const paths = options.paths || await temporaryPaths(t);
  const service = await startPageService({ port: 0, paths, listWSL: async () => ["Ubuntu-24.04"], ...options });
  t.after(() => service.stop());
  const url = `http://127.0.0.1:${service.port}`;
  const root = await fetch(`${url}/`);
  const html = await root.text();
  const token = /name="artex-session" content="([a-f0-9]{64})"/.exec(html)?.[1];
  assert.ok(token);
  return {
    paths, url, html, token, service,
    async api(route, values, headers = {}) {
      const response = await fetch(`${url}/api/${route}`, {
        method: values === undefined ? "GET" : "POST",
        headers: { "X-Artex-Session": token, ...(values === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(values === undefined ? {} : { body: JSON.stringify(values) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("GUI API configures, switches and restores an instance without returning credentials", async (t) => {
  const api = await artexServer(t);
  const ui = await page(t);
  const configured = await ui.api("configure", { environment: "local", url: api.url, password: api.password });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.status, "configured");
  assert.equal(api.writes.length, 0);
  await writeJSON(ui.paths.agent, selection("test/from-magpie"));
  assert.equal((await ui.api("sync", { environment: "local" })).body.status, "synced");
  assert.equal(api.profiles[1].model, "test/from-magpie");
  const state = await ui.api("state");
  assert.equal(state.body.instances[0].selection, "test/from-magpie");
  assert.equal(state.body.instances[0].has_password, true);
  const serialized = JSON.stringify([configured, state]);
  for (const secret of [api.password, api.token, "magpie-test-artex", "original-secret-key"]) assert.ok(!serialized.includes(secret));
  assert.equal((await ui.api("disconnect", { environment: "local" })).body.status, "disconnected");
  assert.equal(api.profiles[0].is_default, true);
  assert.equal(api.profiles[0].api_key, "original-secret-key");
});

test("GUI WSL setup stays inside the installed plugin without generating or registering another", async (t) => {
  const api = await artexServer(t);
  const paths = await temporaryPaths(t);
  const magpieDirectory = path.join(paths.dir, "magpie");
  const file = path.join(magpieDirectory, "plugins.json");
  await writeJSON(file, { plugins: [{ spec: "existing-plugin", options: { keep: true } }], config: { provider: { fixture: {} } } });
  const before = await readFile(file, "utf8");
  const ui = await page(t, { paths, magpieDirectory });
  const body = { environment: "wsl", wsl_distro: "Ubuntu-24.04", url: api.url, password: api.password };
  const result = await ui.api("configure", body);
  assert.equal(result.body.status, "configured");
  assert.equal(result.body.agent_name, "ARTEX · WSL · Ubuntu-24.04");
  assert.equal(result.body.registration, undefined);
  const child = instancePaths(paths, body.wsl_distro);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await readJSON(file)).plugins[0].options.keep, true);
  assert.deepEqual((await readJSON(file)).config.provider.fixture, {});
  assert.equal(await readJSON(paths.config), null);
  await assert.rejects(access(child.agentModule), { code: "ENOENT" });
  const state = await ui.api("state");
  assert.equal(state.body.instances[0].registration, undefined);
  assert.equal((await ui.api("register", body)).status, 404);
  assert.deepEqual((await ui.api("wsl")).body.distros, ["Ubuntu-24.04"]);
  assert.equal(api.writes.length, 0);
});

test("WSL connection status follows the official shared ARTEX row", async (t) => {
  const api = await artexServer(t);
  const ui = await page(t);
  const values = { environment: "wsl", wsl_distro: "Fixture", url: api.url, password: api.password };
  const saved = await ui.api("configure", values);
  assert.equal(saved.body.status, "configured");
  await writeJSON(ui.paths.agent, selection("test/shared-native"));
  const child = instancePaths(ui.paths, values.wsl_distro);
  await writeJSON(child.agent, selection("test/wsl-native"));
  assert.equal((await ui.api("state")).body.instances[0].selection, "test/shared-native");
  assert.equal((await readJSON(ui.paths.agent)).model, "test/shared-native");
});

test("adding a second environment cannot accidentally configure the same ARTEX service twice", async (t) => {
  const api = await artexServer(t), ui = await page(t);
  assert.equal((await ui.api("configure", { environment: "local", url: api.url, password: api.password })).status, 200);
  const logins = api.logins;
  const result = await ui.api("configure", { environment: "wsl", wsl_distro: "Fixture-Ubuntu", url: api.url + "/", password: api.password });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /已经有连接/);
  assert.equal(api.logins, logins);
  assert.equal(await readJSON(instancePaths(ui.paths, "Fixture-Ubuntu").config), null);
});

test("page isolation rejects missing capabilities, foreign origins, DNS rebinding and form CSRF", async (t) => {
  const api = await artexServer(t);
  const ui = await page(t);
  const noCapability = await fetch(`${ui.url}/api/state`, { headers: { Origin: "null" } });
  assert.equal(noCapability.status, 401);
  assert.equal((await ui.api("state", undefined, { Origin: "https://attacker.invalid" })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = request(`${ui.url}/api/state`, { headers: { Host: "attacker.invalid", "X-Artex-Session": ui.token } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.once("error", reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await ui.api("state", undefined, { Origin: "null" })).status, 200);
  assert.equal((await ui.api("configure", { url: api.url, password: api.password }, { "Content-Type": "text/plain" })).status, 400);
  assert.equal(api.logins, 0);
  const root = await fetch(`${ui.url}/`, { headers: { Origin: "null" } });
  assert.equal(root.headers.get("access-control-allow-origin"), null);
  assert.match(root.headers.get("content-security-policy"), /frame-ancestors/);
  const ancestors = root.headers.get("content-security-policy").split(";").find((part) => part.trim().startsWith("frame-ancestors")).trim().split(/\s+/).slice(1);
  assert.ok(ancestors.includes("http://wails.localhost"), "Windows Magpie embeds pages from Wails' actual virtual origin");
  assert.ok(ancestors.includes("wails://localhost"), "macOS/Linux Magpie use the Wails scheme");
  assert.ok(!ancestors.includes("*"), "desktop compatibility must not allow arbitrary websites to frame the settings page");
  const script = await fetch(`${ui.url}/app.js`);
  assert.ok(!(await script.text()).includes(ui.token));
  const preflight = await fetch(`${ui.url}/api/state`, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Headers": "X-Artex-Session" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "null");
});

test("GUI edit preserves blank credentials but a changed user or failed login cannot replace them", async (t) => {
  const api = await artexServer(t);
  const ui = await page(t);
  const values = { environment: "local", url: api.url, password: api.password, auth_method: "password" };
  assert.equal((await ui.api("configure", values)).status, 200);
  assert.equal((await ui.api("configure", { ...values, url: `${api.url}/`, password: "", format: "anthropic" })).status, 200);
  const before = await readJSON(ui.paths.config);
  assert.equal(before.password, api.password);
  assert.equal((await ui.api("configure", { ...values, password: "wrong" })).status, 400);
  assert.deepEqual(await readJSON(ui.paths.config), before);
  assert.equal((await ui.api("configure", { ...values, username: "other", password: "" })).status, 400);
  assert.deepEqual(await readJSON(ui.paths.config), before);
  assert.equal((await ui.api("configure", { ...values, store_password: false })).status, 200);
  assert.equal((await readJSON(ui.paths.config)).password, undefined);
  assert.equal((await ui.api("state")).body.instances[0].has_password, false);
});

test("GUI connection checks use localhost literally and never require or persist login", async (t) => {
  const api = await artexServer(t, undefined, { listenHost: "::", urlHost: "localhost" });
  const ui = await page(t);
  const result = await ui.api("check", { environment: "local", url: api.url });
  assert.equal(result.body.url, api.url);
  assert.equal(result.body.health.ok, true);
  assert.equal(api.logins, 0);
  assert.equal(api.writes.length, 0);
  assert.equal(await readJSON(ui.paths.config), null);
});

test("registration detects Magpie from the Bun host's parent without PATH or shell commands", async (t) => {
  const paths = await temporaryPaths(t);
  const binary = path.join(paths.dir, "magpie.exe");
  await writeText(binary, "fixture");
  const calls = [];
  const found = await findMagpieExecutable({ platform: "win32", parent: 456, runner: async (file, args, options) => {
    calls.push({ file, args, options }); return { stdout: `${binary}\r\n` };
  } });
  assert.equal(found, binary);
  assert.equal(calls[0].file, "powershell.exe");
  assert.match(calls[0].args.at(-1), /ProcessId = 456/);
  assert.equal(calls[0].options.windowsHide, true);
  await assert.rejects(findMagpieExecutable({ executable: path.join(paths.dir, "other.exe") }), /Magpie 程序路径/);
});

test("automatic and explicit executable discovery accept Magpie's official Windows release filename", async (t) => {
  const paths = await temporaryPaths(t);
  const binary = path.join(paths.dir, "magpie-windows-amd64.exe");
  await writeText(binary, "fixture");
  assert.equal(await findMagpieExecutable({ executable: binary }), binary);
  const detected = await findMagpieExecutable({ platform: "win32", parent: 123, runner: async () => ({ stdout: `${binary}\r\n` }) });
  assert.equal(detected, binary);
});
