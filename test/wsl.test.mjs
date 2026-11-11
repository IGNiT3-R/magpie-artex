import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";
import { ArtexClient } from "../lib/client.mjs";
import { DEFAULT_ARTEX_URL, desiredProfile, validateConfig } from "../lib/config.mjs";
import { pathsFor, readJSON, writeJSON, writeText } from "../lib/files.mjs";
import { discoverInstances, instancePaths, wslInstance } from "../lib/instances.mjs";
import { startPluginRuntime } from "../lib/plugin-runtime.mjs";
import { Synchronizer } from "../lib/sync.mjs";
import { ConnectionResolver, decodeWSL, listRunningWSL, parseWSLProbe } from "../lib/wsl.mjs";
import { artexServer, configured, selection, temporaryPaths } from "../test-support/artex.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/magpie-artex.mjs", import.meta.url));
const wslKey = `wsl-${"a".repeat(48)}`;

function fakeWSL({ mode = "nat", host = "172.29.112.1", running = ["Ubuntu-24.04"], key = wslKey, fallback = "" } = {}) {
  const state = { mode, host, calls: [], reads: [] };
  state.runner = async (file, args, opts) => {
    assert.equal(opts.windowsHide, true);
    state.calls.push({ file, args });
    if (file === "reg.exe") return { stdout: Buffer.from("registry exists") };
    assert.equal(file, "wsl.exe");
    if (args[0] === "--list") return { stdout: Buffer.from(`${running.join("\r\n")}\r\n`, "utf16le") };
    assert.equal(args[0], "--distribution");
    assert.ok(running.includes(args[1]));
    return { stdout: Buffer.from(`mode:${state.mode}\nroute:default via ${state.host} dev eth0\n`) };
  };
  state.read = async (file) => {
    state.reads.push(file);
    if (file.endsWith(".wslconfig")) return fallback;
    if (file.endsWith("wsl-key") && key) return key;
    if (file.endsWith("custom-key")) return "sk-magpie-custom-named-key";
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  return state;
}

function resolver(fake, extra = {}) {
  return new ConnectionResolver({ runner: fake.runner, read: fake.read, platform: "win32", home: path.resolve("fake-home"), magpieDirectory: path.resolve("portable-magpie"), ...extra });
}

function config(extra = {}) {
  return validateConfig({ version: 1, url: DEFAULT_ARTEX_URL, token: "fixture-jwt", environment: "wsl", wsl_distro: "Ubuntu-24.04", ...extra });
}

test("localhost is the default and an explicitly supplied 127.0.0.1 stays explicit", async () => {
  assert.equal(validateConfig({ version: 1, token: "jwt" }).url, "http://localhost:8787");
  assert.equal(config({ url: "http://127.0.0.1:8787" }).url, "http://127.0.0.1:8787");
  let requested;
  const client = new ArtexClient({ url: DEFAULT_ARTEX_URL }, async (url) => { requested = url; return new Response('{"ok":true}', { status: 200 }); });
  await client.send("/health");
  assert.equal(requested, "http://localhost:8787/api/health");
});

test("localhost reaches an IPv6-only ARTEX endpoint without rewriting it to 127.0.0.1", async (t) => {
  const addresses = await lookup("localhost", { all: true });
  if (!addresses.some((entry) => entry.family === 6)) {
    t.skip("This system maps localhost only to IPv4; literal IPv6 is tested independently");
    return;
  }
  let api;
  try { api = await artexServer(t, undefined, { listenHost: "::1", urlHost: "localhost" }); }
  catch (error) { if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) { t.skip("IPv6 loopback is unavailable"); return; } throw error; }
  const client = new ArtexClient({ url: api.url, password: api.password });
  const profiles = await client.profiles();
  assert.equal(profiles[0].id, "1");
  assert.equal(client.url, api.url);
});

test("an explicit IPv6 ARTEX address works independently of the system localhost mapping", async (t) => {
  let api;
  try { api = await artexServer(t, undefined, { listenHost: "::1", urlHost: "[::1]" }); }
  catch (error) { if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) { t.skip("IPv6 loopback is unavailable"); return; } throw error; }
  const client = new ArtexClient({ url: api.url, password: api.password });
  assert.equal((await client.profiles())[0].id, "1");
  assert.ok(client.url.startsWith("http://[::1]:"));
});

test("WSL UTF-16 output and Unicode distro names decode without NUL bytes", () => {
  assert.equal(decodeWSL(Buffer.from("\uFEFFUbuntu-24.04\r\n发行版\r\n", "utf16le")), "Ubuntu-24.04\r\n发行版\r\n");
  assert.equal(decodeWSL(Buffer.from("mode:mirrored\n")), "mode:mirrored\n");
  assert.equal(decodeWSL(Buffer.from("发行版\r\n", "utf16le")), "发行版\r\n");
});

test("WSL enumeration never invokes wsl.exe on non-Windows or unconfigured Windows", async () => {
  const calls = [];
  const runner = async (file) => { calls.push(file); throw new Error("no registry"); };
  assert.deepEqual(await listRunningWSL({ runner, platform: "linux" }), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await listRunningWSL({ runner, platform: "win32" }), []);
  assert.deepEqual(calls, ["reg.exe"]);
});

test("a stopped distro is reported without starting it", async () => {
  const fake = fakeWSL({ running: [] });
  await assert.rejects(resolver(fake).resolve(selection(), config()), /当前未运行/);
  assert.ok(!fake.calls.some((call) => call.args[0] === "--distribution"));
});

test("NAT resolves the Windows host and uses Magpie's WSL key with the independent agent ID", async () => {
  const fake = fakeWSL();
  const resolved = await resolver(fake).resolve(selection(), config());
  assert.equal(resolved.config.gateway_url, "http://172.29.112.1:3425");
  assert.equal(resolved.bridge.api_key, `${wslKey}-${wslInstance("Ubuntu-24.04").id}`);
  assert.equal(desiredProfile(resolved.bridge, resolved.config).base_url, "http://172.29.112.1:3425/v1");
  assert.equal(resolved.info.networking_mode, "nat");
  assert.ok(!JSON.stringify(resolved.info).includes(wslKey));
  assert.ok(fake.reads.some((file) => file === path.join(path.resolve("portable-magpie"), "wsl-key")));
});

test("NAT honors a custom port, path prefix, and explicit Magpie configuration directory", async () => {
  const fake = fakeWSL();
  const bridge = { ...selection(), base_url: "http://localhost:4455/proxy/v1" };
  const resolved = await resolver(fake).resolve(bridge, config({ magpie_config_dir: path.resolve("chosen-magpie") }));
  assert.equal(resolved.config.gateway_url, "http://172.29.112.1:4455/proxy");
  assert.ok(fake.reads.includes(path.join(path.resolve("chosen-magpie"), "wsl-key")));
});

for (const mode of ["mirrored", "consomme", "virtioproxy"]) {
  test(`${mode} preserves the gateway's working loopback endpoint and supplied agent key`, async () => {
    const fake = fakeWSL({ mode });
    const bridge = selection();
    const resolved = await resolver(fake).resolve(bridge, config());
    assert.equal(resolved.config.gateway_url, "http://127.0.0.1:3425");
    assert.equal(resolved.bridge.api_key, bridge.api_key);
    assert.ok(!fake.reads.some((file) => file.endsWith("wsl-key")));
  });
}

test("network probes are cached briefly and a changed NAT host is rediscovered", async () => {
  const fake = fakeWSL();
  let clock = 0;
  const connection = resolver(fake, { now: () => clock });
  await connection.resolve(selection(), config());
  await connection.resolve(selection(), config());
  assert.equal(fake.calls.filter((call) => call.args[0] === "--distribution").length, 1);
  fake.host = "172.30.0.1";
  clock = 30001;
  const result = await connection.resolve(selection(), config());
  assert.equal(result.config.gateway_url, "http://172.30.0.1:3425");
  assert.equal(fake.calls.filter((call) => call.args[0] === "--distribution").length, 2);
});

test("missing NAT keys stop before changing ARTEX rather than writing the Windows-only token", async (t) => {
  const { paths, api } = await configured(t, { overrides: { environment: "wsl", wsl_distro: "Ubuntu-24.04" } });
  const fake = fakeWSL({ key: "" });
  await assert.rejects(new Synchronizer({ paths, connectionResolver: resolver(fake) }).sync(), /WSL 网关密钥尚不可用/);
  assert.equal(api.writes.length, 0);
  assert.ok(!(await readFile(paths.status, "utf8")).includes("magpie-test-artex"));
});

test("manual gateways and named key files work when WSL cannot be probed", async () => {
  const fake = fakeWSL();
  const connection = resolver(fake, { platform: "linux" });
  const result = await connection.resolve(selection(), config({ gateway_url: "https://gateway.example.test", gateway_key_file: path.resolve("custom-key") }));
  assert.equal(result.config.gateway_url, "https://gateway.example.test");
  assert.equal(result.bridge.api_key, "sk-magpie-custom-named-key");
  assert.equal(result.info.networking_mode, "manual");
});

test("a bridged network never mistakes the LAN router for the Windows gateway", async () => {
  const fake = fakeWSL({ mode: "bridged", host: "192.168.1.1" });
  await assert.rejects(resolver(fake).resolve(selection(), config()), /--gateway-url/);
  assert.deepEqual(parseWSLProbe("mode:nat\nroute:default via not-an-ip dev eth0\n"), { mode: "nat", host: "" });
});

test("older WSL versions can fall back to networkingMode in .wslconfig", async () => {
  const fake = fakeWSL({ mode: "", fallback: "[wsl2]\r\nnetworkingMode=mirrored\r\n" });
  const result = await resolver(fake).resolve(selection(), config());
  assert.equal(result.info.networking_mode, "mirrored");
});

test("WSL connection identities are stable and safe without generating another plugin", async (t) => {
  const root = await temporaryPaths(t);
  const distro = "Ubuntu 测试 'quoted'";
  const paths = instancePaths(root, distro);
  const instance = wslInstance(distro);
  await mkdir(paths.dir, { recursive: true });
  assert.match(instance.id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.equal(wslInstance("Ubuntu").id, wslInstance("ubuntu").id);
  assert.notEqual(wslInstance("Ubuntu test").id, wslInstance("Ubuntu-test").id);
  assert.throws(() => wslInstance("../Ubuntu"), /名称无效/);
  assert.equal((await discoverInstances(root)).length, 1);
});

test("CLI WSL setup stores its connection without another Agent installation command", async (t) => {
  const root = await temporaryPaths(t);
  const api = await artexServer(t);
  const { stdout } = await execute(process.execPath, [cli, "setup", "--data-dir", root.dir, "--wsl", "Ubuntu-24.04", "--url", api.url, "--json"], {
    env: { ...process.env, ARTEX_PASSWORD: api.password, ARTEX_TOKEN: "" }, timeout: 10000, windowsHide: true,
  });
  const output = JSON.parse(stdout);
  const child = instancePaths(root, "Ubuntu-24.04");
  assert.equal(output.directory, child.dir);
  assert.equal(output.install_command, undefined);
  assert.equal((await readJSON(child.config)).environment, "wsl");
  assert.equal((await readJSON(child.config)).profile_name, "Magpie (WSL: Ubuntu-24.04)");
  assert.equal(await readJSON(root.config), null);
  assert.ok(!stdout.includes(api.password));
  const listed = JSON.parse((await execute(process.execPath, [cli, "instances", "--data-dir", root.dir, "--json"], { windowsHide: true })).stdout);
  assert.equal(listed.instances[0].wsl_distro, "Ubuntu-24.04");
  assert.equal(api.writes.length, 0);
});

test("doctor honors manual gateway and key options without logging in or saving a connection", async (t) => {
  const root = await temporaryPaths(t);
  const api = await artexServer(t);
  const keyFile = path.join(root.dir, "test-gateway-key");
  await writeText(keyFile, "sk-magpie-doctor-test-key\n");
  const { stdout } = await execute(process.execPath, [cli, "doctor", "--data-dir", root.dir, "--wsl", "Offline-Fixture", "--url", api.url, "--gateway-url", "http://manual-gateway.invalid:3425", "--gateway-key-file", keyFile, "--json"], { windowsHide: true, timeout: 10000 });
  const output = JSON.parse(stdout);
  assert.equal(output.health.ok, true);
  assert.equal(output.network.networking_mode, "manual");
  assert.equal(output.network.gateway_url, "http://manual-gateway.invalid:3425");
  assert.ok(!stdout.includes("sk-magpie-doctor-test-key"));
  assert.equal(api.logins, 0);
  assert.equal(api.writes.length, 0);
  assert.equal(await readJSON(instancePaths(root, "Offline-Fixture").config), null);
});

test("one official Agent feeds local and multiple WSL connections with isolated credentials and restoration", async (t) => {
  const cleanup = [];
  const resources = { after: (fn) => cleanup.push(fn) };
  t.after(async () => { for (const fn of cleanup.reverse()) await fn(); });
  const root = await temporaryPaths(resources);
  const localAPI = await artexServer(resources);
  const wslAPI = await artexServer(resources);
  const otherAPI = await artexServer(resources);
  await writeJSON(root.config, { version: 1, url: localAPI.url, password: localAPI.password });
  await writeJSON(root.agent, selection("local/model"));
  const fake = fakeWSL({ running: ["Ubuntu-24.04", "Other"] });
  const runtime = await startPluginRuntime({ paths: root, interval: 500, connectionResolver: resolver(fake) });
  resources.after(() => runtime.stop());
  const child = instancePaths(root, "Ubuntu-24.04");
  await mkdir(child.dir, { recursive: true });
  await writeJSON(child.config, { version: 1, url: wslAPI.url, password: wslAPI.password, environment: "wsl", wsl_distro: "Ubuntu-24.04" });
  await writeJSON(child.agent, selection("wsl/model"));
  const other = instancePaths(root, "Other");
  await writeJSON(other.config, { version: 1, url: otherAPI.url, password: otherAPI.password, environment: "wsl", wsl_distro: "Other" });
  await writeJSON(other.agent, selection("other/model"));
  await runtime.scan();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!localAPI.profiles[1]?.is_default || !wslAPI.profiles[1]?.is_default || !otherAPI.profiles[1]?.is_default)) await delay(20);
  assert.equal(localAPI.profiles[1].model, "local/model");
  assert.equal(wslAPI.profiles[1].model, "local/model");
  assert.equal(otherAPI.profiles[1].model, "local/model");
  assert.equal(localAPI.profiles[1].api_key, "magpie-test-artex");
  assert.equal(wslAPI.profiles[1].api_key, `${wslKey}-artex`);
  assert.equal(otherAPI.profiles[1].api_key, `${wslKey}-artex`);
  const wslState = await readJSON(child.state);
  assert.equal(wslState.artex_url, wslAPI.url);
  assert.equal((await readJSON(root.state)).artex_url, localAPI.url);
  await runtime.stop();
  await new Synchronizer({ paths: child, bridgeFile: root.agent, shared: true, connectionResolver: resolver(fake) }).disconnect();
  assert.equal(wslAPI.profiles[0].is_default, true);
  assert.equal(localAPI.profiles[1].is_default, true);
  assert.equal(otherAPI.profiles[1].is_default, true);
  assert.equal((await readJSON(root.agent)).model, "local/model");
  assert.equal((await readJSON(child.config)).enabled, false);
});
