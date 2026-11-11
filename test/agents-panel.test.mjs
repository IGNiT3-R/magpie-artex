import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../page/agents.js", import.meta.url), "utf8");

for (const [origin, protocol, hostname] of [
  ["http://wails.localhost", "http:", "wails.localhost"],
  ["null", "wails:", "localhost"],
  ["http://localhost:3430", "http:", "localhost"],
]) {
  test(`Agents panel opens the local settings with native origin ${origin}`, async () => {
    const navigations = [];
    const href = `${protocol === "wails:" ? "wails://localhost" : origin}/_magpie/plugin/${"a".repeat(32)}/agents.html`;
    await vm.runInNewContext(source, {
      magpie: { ready: Promise.resolve(), context: { agent: { id: "artex-wsl-fixture" } }, options: { get: async () => ({ port: 3480 }) } },
      location: { href, origin, protocol, hostname, replace: (value) => navigations.push(value) },
      document: { getElementById: () => ({}) },
    });
    assert.deepEqual(navigations, [`http://127.0.0.1:3480/#agents&bootstrap=${encodeURIComponent(href)}`]);
  });
}

test("remote Web panel never navigates to the viewer's own loopback", async () => {
  const message = {};
  await vm.runInNewContext(source, {
    magpie: { ready: Promise.resolve(), options: { get: () => assert.fail("remote panel should not attempt a local service") } },
    location: { origin: "https://magpie.example.invalid", protocol: "https:", hostname: "magpie.example.invalid", replace: () => assert.fail("must not redirect to the remote viewer's localhost") },
    document: { getElementById: () => message },
  });
  assert.match(message.textContent, /运行 Magpie 的电脑/);
});

test("service recovery only navigates back to a valid Magpie plugin bootstrap", async () => {
  const context = vm.createContext({ URL });
  vm.runInContext(await readFile(new URL("../page/reconnect.js", import.meta.url), "utf8"), context);
  const resolve = context.artexReconnectURL;
  const suffix = `/_magpie/plugin/${"a".repeat(32)}/agents.html`;
  const current = "http://127.0.0.1:3479/";
  assert.equal(resolve(`http://wails.localhost${suffix}`, current), `http://wails.localhost${suffix}`);
  assert.equal(resolve(`wails://localhost${suffix}`, current), `wails://localhost${suffix}`);
  assert.equal(resolve(`https://magpie.example.invalid${suffix}`, "https://magpie.example.invalid/_magpie/service/"), `https://magpie.example.invalid${suffix}`);
  const authenticatedURL = new URL(`http://localhost${suffix}`);
  authenticatedURL.username = "fixture-user";
  authenticatedURL.password = "fixture-password";
  for (const invalid of [`https://attacker.invalid${suffix}`, "javascript:alert(1)", "http://wails.localhost/api/settings", authenticatedURL.href]) assert.equal(resolve(invalid, current), null);
});
