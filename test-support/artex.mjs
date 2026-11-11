import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "../artex.agent.js";
import { pathsFor, writeJSON } from "../lib/files.mjs";

export const originalProfile = {
  id: "1", name: "default", format: "anthropic", model: "original-model",
  base_url: "https://original.invalid", api_key: "original-secret-key", is_default: true,
  streaming: false, max_tokens: 3000, priority: 8, pool_exclude: false,
  rate_per_second: 2, rate_per_minute: 50, context_window_k: 200,
  thinking_type: "enabled", reasoning_effort: "high", max_tokens_field: "",
  proxy: "", session_header_key: "X-Session", retry: { connect: { attempts: 4, interval_ms: 100 } },
};

export function selection(id = "test/model-a", endpoints = ["/v1/chat/completions"]) {
  const model = { id, context: 128000, output: 8192, native_endpoints: endpoints };
  return { model: id, ...connect({ gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-test-artex" }, model }) };
}

export async function temporaryPaths(t) {
  const prefix = path.join(tmpdir(), "magpie-artex-test-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(prefix)) && resolved !== path.resolve(tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  });
  return pathsFor(directory);
}

// Mirrors the actual ARTEX API: string IDs in DTOs, integer IDs on writes,
// hidden API keys, empty-key preservation, and separate save/activate calls.
export async function artexServer(t, initial = [originalProfile], { listenHost = "127.0.0.1", urlHost = listenHost } = {}) {
  const data = {
    profiles: structuredClone(initial), requests: [], writes: [], logins: 0,
    token: "fixture-jwt-0", password: "fixture-password", hook: null,
    tasks: [], agents: [], conversations: [], nextID: Math.max(0, ...initial.map((profile) => Number(profile.id))) + 1,
  };
  const reply = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : undefined); } catch (error) { reject(error); } });
        req.on("error", reject);
      });
      const request = { method: req.method, path: req.url, body, authorization: req.headers.authorization };
      data.requests.push(request);
      if (data.hook && await data.hook(request, res, reply)) return;
      if (req.url === "/api/health" && req.method === "GET") return reply(res, 200, { ok: true, service: "artex", version: "fixture" });
      if (req.url === "/api/auth/login" && req.method === "POST") {
        data.logins++;
        if (body.username !== "ARTEX" || body.password !== data.password) return reply(res, 401, { error: "用户名或密码错误" });
        data.token = `fixture-jwt-${data.logins}`;
        return reply(res, 200, { token: data.token });
      }
      if (req.headers.authorization !== `Bearer ${data.token}`) return reply(res, 401, { error: "token 无效或已过期" });
      for (const key of ["tasks", "agents", "conversations"]) {
        if (req.method === "GET" && req.url === `/api/${key}`) return reply(res, 200, { [key]: data[key] });
      }
      if (req.url === "/api/llm/profiles" && req.method === "GET") {
        return reply(res, 200, { profiles: data.profiles.map(({ api_key, ...p }) => ({ ...p, api_key_hint: api_key?.length >= 4 ? `…${api_key.slice(-4)}` : "" })) });
      }
      if (req.url === "/api/llm/profiles" && req.method === "POST") {
        assert.equal(typeof body.id, "number");
        data.writes.push(request);
        const found = data.profiles.find((p) => Number(p.id) === body.id);
        if (body.id && !found) return reply(res, 404, { error: "not found" });
        if (data.profiles.some((p) => p.name === body.name && Number(p.id) !== body.id)) return reply(res, 500, { error: "duplicate name" });
        const id = found?.id || String(data.nextID++);
        const updated = { ...found, ...body, id, is_default: found?.is_default || false, api_key: body.api_key || found?.api_key || "" };
        if (found) data.profiles[data.profiles.indexOf(found)] = updated;
        else data.profiles.push(updated);
        return reply(res, 200, { id: Number(id) });
      }
      if (req.url === "/api/llm/profiles/active" && req.method === "POST") {
        assert.equal(typeof body.id, "number");
        const found = data.profiles.find((p) => Number(p.id) === body.id);
        if (!found) return reply(res, 500, { error: "not found" });
        data.writes.push(request);
        for (const profile of data.profiles) profile.is_default = profile === found;
        return reply(res, 200, { ok: true });
      }
      const removal = /^\/api\/llm\/profiles\/(\d+)$/.exec(req.url);
      if (removal && req.method === "DELETE") {
        const profile = data.profiles.find((item) => String(item.id) === removal[1]);
        if (!profile) return reply(res, 404, { error: "not found" });
        if (profile.is_default) return reply(res, 409, { error: "active profile cannot be deleted" });
        data.writes.push(request);
        data.profiles.splice(data.profiles.indexOf(profile), 1);
        return reply(res, 200, { deleted: Number(profile.id) });
      }
      reply(res, 404, { error: "not found" });
    } catch (error) {
      data.failure = error;
      if (!res.destroyed) reply(res, 500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, listenHost, resolve); });
  data.url = `http://${urlHost}:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (data.failure) throw data.failure;
  });
  return data;
}

export async function configured(t, { initial, bridge = selection(), overrides = {} } = {}) {
  const paths = await temporaryPaths(t);
  const api = await artexServer(t, initial);
  const config = { version: 1, url: api.url, password: api.password, timeout_ms: 1000, ...overrides };
  await writeJSON(paths.config, config);
  if (bridge) await writeJSON(paths.agent, bridge);
  return { paths, api, config };
}
