import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ArtexClient } from "../lib/client.mjs";
import { readJSON, withLock, writeJSON } from "../lib/files.mjs";
import { Synchronizer } from "../lib/sync.mjs";
import { configured, originalProfile, selection, temporaryPaths } from "../test-support/artex.mjs";

test("create, activate, hot-switch, and disconnect preserve the original profile and key", async (t) => {
  const { paths, api } = await configured(t);
  const sync = new Synchronizer({ paths });
  assert.equal((await sync.sync()).status, "synced");
  const managed = api.profiles.find((p) => p.name === "Magpie (managed)");
  assert.equal(managed.model, "test/model-a");
  assert.equal(managed.api_key, "magpie-test-artex");
  assert.equal(managed.pool_exclude, true);
  assert.equal(managed.is_default, true);
  assert.equal(api.logins, 1);
  const writes = api.writes.length;
  await sync.sync();
  assert.equal(api.writes.length, writes, "an unchanged poll does not write");
  managed.streaming = false;
  managed.rate_per_second = 3;
  managed.session_header_key = "X-User-Session";
  managed.retry = { stream: { attempts: 6, interval_ms: 2000 } };
  await writeJSON(paths.agent, selection("test/model-b", ["/v1/responses"]));
  await sync.sync();
  const updated = api.profiles.find((p) => p.id === managed.id);
  assert.equal(updated.model, "test/model-b");
  assert.equal(updated.format, "openai-responses");
  assert.equal(updated.streaming, false);
  assert.equal(updated.rate_per_second, 3);
  assert.equal(updated.session_header_key, "X-User-Session");
  assert.deepEqual(updated.retry, managed.retry);
  assert.equal(api.profiles.length, 2);
  assert.equal((await sync.disconnect()).status, "disconnected");
  assert.deepEqual(api.profiles[0], originalProfile);
  assert.equal(api.profiles[1].pool_exclude, true);
  assert.equal(api.profiles.length, 2, "disconnect never deletes a profile referenced by a task");
  assert.equal((await readJSON(paths.state)).connected, false);
  const output = await readFile(paths.status, "utf8");
  assert.ok(!output.includes(api.password) && !output.includes(api.token) && !output.includes("magpie-test-artex"));
});

test("a new synchronizer resumes from persistent state and a Magpie file removal restores the default", async (t) => {
  const { paths, api } = await configured(t);
  await new Synchronizer({ paths }).sync();
  await writeJSON(paths.agent, {});
  assert.equal((await new Synchronizer({ paths }).sync()).status, "disconnected");
  assert.equal(api.profiles[0].is_default, true);
  await writeJSON(paths.agent, selection("test/reconnected"));
  await new Synchronizer({ paths }).sync();
  assert.equal(api.profiles.length, 2);
  assert.equal(api.profiles[1].model, "test/reconnected");
  assert.equal((await readJSON(paths.state)).previous_profile_id, "1");
});

test("manual default changes are preserved and the next explicit selection captures the new restore target", async (t) => {
  const extra = { ...originalProfile, id: "2", name: "manual", is_default: false };
  const { paths, api } = await configured(t, { initial: [originalProfile, extra] });
  const sync = new Synchronizer({ paths });
  await sync.sync();
  api.profiles.forEach((p) => { p.is_default = p.id === "2"; });
  const writes = api.writes.length;
  assert.equal((await sync.sync()).status, "inactive");
  assert.equal(api.writes.length, writes);
  await writeJSON(paths.agent, selection("test/model-b"));
  await sync.sync();
  assert.equal((await readJSON(paths.state)).previous_profile_id, "2");
  await sync.disconnect();
  assert.equal(api.profiles.find((p) => p.id === "2").is_default, true);
});

test("expired tokens reauthenticate once with the correct ARTEX username", async (t) => {
  const { paths, api } = await configured(t, { overrides: { token: "expired" } });
  const sync = new Synchronizer({ paths });
  await sync.sync();
  assert.equal(api.logins, 1);
  api.token = "expired-again";
  await sync.sync();
  assert.equal(api.logins, 2);
  assert.equal(api.requests.filter((r) => r.path === "/api/auth/login")[0].body.username, "ARTEX");
});

test("wrong credentials do not write and error messages do not echo response bodies", async (t) => {
  const { paths, api } = await configured(t, { overrides: { password: "wrong-password" } });
  api.hook = async (req, res, reply) => {
    if (req.path === "/api/auth/login") { reply(res, 401, { error: `echo ${req.body.password} ${api.password}` }); return true; }
    return false;
  };
  await assert.rejects(new Synchronizer({ paths }).sync(), /登录失败/);
  assert.equal(api.writes.length, 0);
  assert.ok(!(await readFile(paths.status, "utf8")).includes("wrong-password"));
});

test("an existing unrelated profile with the same name is never adopted", async (t) => {
  const existing = { ...originalProfile, id: "2", name: "Magpie (managed)", is_default: false };
  const { paths, api } = await configured(t, { initial: [originalProfile, existing] });
  await assert.rejects(new Synchronizer({ paths }).sync(), /不会接管/);
  assert.equal(api.writes.length, 0);
  assert.equal(await readJSON(paths.state), null);
});

test("a lost create response is recovered without duplicate profiles or a lost restore target", async (t) => {
  const { paths, api } = await configured(t);
  let once = true;
  const sync = new Synchronizer({ paths, clientFactory: (config) => {
    const client = new ArtexClient(config);
    const save = client.save.bind(client);
    client.save = async (p) => {
      const id = await save(p);
      if (once) { once = false; throw new Error("simulated lost response"); }
      return id;
    };
    return client;
  } });
  await assert.rejects(sync.sync(), /lost response/);
  const journal = await readJSON(paths.state);
  assert.equal(journal.profile_id, null);
  assert.equal(journal.previous_profile_id, "1");
  assert.equal(journal.phase, "connecting");
  assert.equal(api.profiles.length, 2);
  await new Synchronizer({ paths }).sync();
  assert.equal(api.profiles.length, 2);
  await new Synchronizer({ paths }).disconnect();
  assert.equal(api.profiles[0].is_default, true);
});

test("crash after activation keeps the original restore target on retry", async (t) => {
  const { paths, api } = await configured(t);
  let once = true;
  const sync = new Synchronizer({ paths, clientFactory: (config) => {
    const client = new ArtexClient(config);
    const activate = client.activate.bind(client);
    client.activate = async (id) => {
      await activate(id);
      if (once) { once = false; throw new Error("simulated crash after activation"); }
    };
    return client;
  } });
  await assert.rejects(sync.sync(), /simulated crash/);
  await new Synchronizer({ paths }).sync();
  assert.equal((await readJSON(paths.state)).previous_profile_id, "1");
  await new Synchronizer({ paths }).disconnect();
  assert.equal(api.profiles[0].is_default, true);
});

test("no previous default is reported explicitly without deleting the active managed profile", async (t) => {
  const { paths, api } = await configured(t, { initial: [] });
  const sync = new Synchronizer({ paths });
  await sync.sync();
  await assert.rejects(sync.disconnect(), /无法恢复原默认配置/);
  assert.equal(api.profiles.length, 1);
  assert.equal(api.profiles[0].is_default, true);
  assert.equal((await readJSON(paths.state)).connected, true);
});

test("corrupt bridge or state stops writes instead of treating it as a disconnect", async (t) => {
  const { paths, api } = await configured(t);
  const sync = new Synchronizer({ paths });
  await sync.sync();
  const writes = api.writes.length;
  await writeFile(paths.agent, "{broken");
  await assert.rejects(sync.sync(), /JSON 对象/);
  assert.equal(api.writes.length, writes);
  assert.equal(api.profiles[1].is_default, true);
});

test("instance mismatch and profile rename stop before any mutation", async (t) => {
  const { paths, api, config } = await configured(t);
  await new Synchronizer({ paths }).sync();
  const writes = api.writes.length;
  api.profiles[1].name = "renamed";
  await assert.rejects(new Synchronizer({ paths }).sync(), /重命名/);
  assert.equal(api.writes.length, writes);
  await writeJSON(paths.config, { ...config, url: "http://127.0.0.1:1" });
  await assert.rejects(new Synchronizer({ paths }).sync(), /不匹配/);
  assert.equal(api.writes.length, writes);
});

test("managed endpoint drift is repaired without changing other profile options", async (t) => {
  const { paths, api } = await configured(t);
  const sync = new Synchronizer({ paths });
  await sync.sync();
  api.profiles[1].base_url = "http://drift.invalid/v1";
  api.profiles[1].streaming = false;
  await sync.sync();
  assert.equal(api.profiles[1].base_url, "http://127.0.0.1:3425/v1");
  assert.equal(api.profiles[1].streaming, false);
});

test("concurrent synchronizers produce a single managed profile", async (t) => {
  const { paths, api } = await configured(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => new Synchronizer({ paths }).sync()));
  assert.ok(results.some((r) => r.status === "synced"));
  assert.equal(api.profiles.length, 2);
  assert.equal(api.writes.filter((request) => request.path === "/api/llm/profiles" && request.body.id === 0).length, 1);
});

test("a live lock cannot be stolen and a dead process lock is recovered", async (t) => {
  const paths = await temporaryPaths(t);
  await writeJSON(paths.lock, { pid: process.pid, nonce: "owner" });
  assert.equal((await withLock(paths, () => assert.fail("must not run"))).status, "busy");
  await writeJSON(paths.lock, { pid: 2147483647, nonce: "dead" });
  assert.equal(await withLock(paths, () => "recovered"), "recovered");
  assert.equal(await readJSON(paths.lock), null);
});

test("simultaneous stale-lock recovery never overlaps critical sections", async (t) => {
  const paths = await temporaryPaths(t);
  for (let round = 0; round < 6; round++) {
    await writeJSON(paths.lock, { pid: 2147483647, nonce: "dead" });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => withLock(paths, async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(15);
      active--;
    })));
    assert.equal(peak, 1);
  }
});

test("unconfigured background is idle and makes no connection", async (t) => {
  const paths = await temporaryPaths(t);
  assert.equal((await new Synchronizer({ paths }).sync()).status, "waiting");
});
