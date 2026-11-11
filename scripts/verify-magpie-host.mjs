// Runs the unmodified upstream Magpie host against this package and an
// isolated ARTEX fixture. No real Magpie profile or ARTEX instance is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import test from "node:test";
import { createServer } from "node:net";
import { pathsFor, readJSON, writeJSON } from "../lib/files.mjs";
import { artexServer, selection, temporaryPaths } from "../test-support/artex.mjs";
import { instancePaths } from "../lib/instances.mjs";
import { writeText } from "../lib/files.mjs";

const { values } = parseArgs({ options: { host: { type: "string" }, bun: { type: "string", default: "bun" } } });
if (!values.host) {
  console.error("Usage: npm run test:magpie -- --host <magpie/internal/plugin/host.js> [--bun <bun.exe>]");
  process.exit(1);
}
const target = fileURLToPath(new URL("..", import.meta.url));

test("actual Magpie Bun host loads ARTEX as an agent runtime and applies/updates/restores profiles", { timeout: 25000 }, async (t) => {
  const disposers = [];
  const resources = { after: (fn) => disposers.push(fn) };
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  const root = await temporaryPaths(resources);
  const api = await artexServer(resources);
  const paths = pathsFor(path.join(root.dir, ".config", "magpie-artex"));
  await mkdir(paths.dir, { recursive: true });
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const pagePort = reservation.address().port;
  resources.after(() => new Promise((resolve) => reservation.close(() => resolve())));
  const authPath = path.join(root.dir, "plugin-auth.json");
  await writeJSON(authPath, {});
  const child = spawn(values.bun, [path.resolve(values.host)], {
    cwd: root.dir, windowsHide: true,
    env: { ...process.env, HOME: root.dir, USERPROFILE: root.dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let spawnFailure;
  child.once("error", (error) => { spawnFailure = error; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const replies = new Map();
  const messages = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.id && ("result" in message || message.error)) replies.set(message.id, message);
  });
  const exited = once(child, "exit").catch(() => {});
  resources.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, delay(3000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); })]);
    lines.close();
  });
  async function until(predicate) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (spawnFailure) throw spawnFailure;
      if (await predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Magpie host exited early: ${stderr.slice(-2000)}`);
      await delay(25);
    }
    assert.fail(`Magpie host timed out: ${stderr.slice(-2000)}`);
  }
  child.stdin.write(`${JSON.stringify({ id: 1, method: "init", params: { authPath, directory: root.dir, plugins: [{ spec: target, target, options: { pollIntervalMs: 500, port: pagePort } }] } })}\n`);
  await until(() => replies.has(1));
  const init = replies.get(1);
  assert.equal(init.error, undefined);
  assert.equal(init.result.plugins.length, 1);
  assert.ok(!init.result.plugins[0].error, init.result.plugins[0].error);
  const pageURL = `http://127.0.0.1:${pagePort}`;
  // Keep the port occupied during init to reproduce a GUI/CLI overlap.
  // The plugin must load, keep its adapter alive and bind automatically
  // after the former host releases the settings port.
  await new Promise((resolve) => reservation.close(resolve));
  await until(async () => { try { return (await fetch(pageURL)).ok; } catch { return false; } });
  const pageHTML = await (await fetch(pageURL)).text();
  const pageToken = /name="artex-session" content="([a-f0-9]{64})"/.exec(pageHTML)?.[1];
  assert.ok(pageToken, "the actual Bun host must run the configured page service");
  const configured = await fetch(`${pageURL}/api/configure`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Artex-Session": pageToken, Origin: "null" },
    body: JSON.stringify({ environment: "local", url: api.url, password: api.password }),
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).status, "configured");
  assert.equal(api.writes.length, 0);
  await writeJSON(paths.agent, selection());
  await until(async () => (await readJSON(paths.status))?.status === "synced");
  assert.equal(api.profiles[1].model, "test/model-a");
  assert.equal(api.profiles[1].is_default, true);

  // Discover a WSL row added while the host is running. An explicit gateway
  // and named key keep this fixture independent of the machine's real WSL.
  const wslAPI = await artexServer(resources);
  const childPaths = instancePaths(paths, "Fixture-Ubuntu");
  const keyFile = path.join(root.dir, "named-gateway-key");
  await writeText(keyFile, "sk-magpie-fixture-key\n");
  await writeJSON(childPaths.config, {
    version: 1, url: wslAPI.url, password: wslAPI.password,
    environment: "wsl", wsl_distro: "Fixture-Ubuntu",
    gateway_url: "http://fixture-gateway.invalid:3425", gateway_key_file: keyFile,
  });
  await until(async () => (await readJSON(childPaths.status))?.status === "synced");
  assert.equal(wslAPI.profiles[1].model, "test/model-a");
  assert.equal(wslAPI.profiles[1].api_key, "sk-magpie-fixture-key");
  assert.equal(api.profiles[1].model, "test/model-a");

  await writeJSON(paths.agent, selection("test/native-anthropic", ["/v1/messages"]));
  await until(() => api.profiles[1].model === "test/native-anthropic");
  assert.equal(api.profiles[1].format, "anthropic");
  assert.equal(api.profiles[1].base_url, "http://127.0.0.1:3425");

  child.stdin.write(`${JSON.stringify({ id: 2, method: "providers", params: {} })}\n`);
  await until(() => replies.has(2));
  assert.equal(replies.get(2).error, undefined);
  assert.deepEqual(replies.get(2).result, []);
  await writeJSON(paths.agent, {});
  await until(() => api.profiles[0].is_default);
  await until(() => wslAPI.profiles[0].is_default);
  const transcript = JSON.stringify(messages) + stderr;
  for (const secret of [api.password, api.token, "magpie-test-artex", "original-secret-key", "sk-magpie-fixture-key"]) assert.ok(!transcript.includes(secret), "credentials must not appear in host logs");
});
