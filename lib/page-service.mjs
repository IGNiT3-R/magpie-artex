import { timingSafeEqual, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathsFor, readJSON, writeJSON, withLock } from "./files.mjs";
import { checkConnection, configureInstance, listInstances, targetInstance } from "./management.mjs";
import { Synchronizer } from "./sync.mjs";
import { ConnectionResolver, listRunningWSL } from "./wsl.mjs";
import { DEFAULT_ARTEX_URL, normalizeURL } from "./config.mjs";

export const DEFAULT_PAGE_PORT = 3479;

function inputValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象。");
  const out = {};
  for (const key of ["environment", "wsl_distro", "url", "username", "password", "token", "auth_method", "profile_name", "gateway_url", "gateway_key_file", "format", "executable"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || value[key].length > (key === "token" || key === "password" ? 16384 : 2048)) throw new Error(`字段 ${key} 无效。`);
    out[key] = value[key];
  }
  if (value.store_password !== undefined) {
    if (typeof value.store_password !== "boolean") throw new Error("store_password 必须为布尔值。");
    out.store_password = value.store_password;
  }
  return out;
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new Error("请求需要 application/json。");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error("请求过大。");
    chunks.push(chunk);
  }
  try { return inputValues(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("请求 JSON 无效。"); throw error; }
}

// Only the page's HTML contains the per-process capability. It has no CORS
// permission, so neither an ordinary website nor an opaque sandbox can fetch
// that HTML and read it. API requests require the capability AND a valid Host.
// Origin:null is necessary for Magpie's official sandbox/reverse proxy.
export async function startPageService({
  port = DEFAULT_PAGE_PORT, paths = pathsFor(), magpieDirectory, executable,
  runtime,
  connectionResolver = new ConnectionResolver({ magpieDirectory }),
  listWSL = listRunningWSL,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("ARTEX 插件页面端口无效。");
  const capability = randomBytes(32).toString("hex");
  const assets = new Map();
  for (const [route, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/reconnect.js", "reconnect.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
    ["/native.css", "native.css", "text/css; charset=utf-8"],
  ]) assets.set(route, { content: await readFile(new URL(`../page/${file}`, import.meta.url), "utf8"), type });
  let actualPort;
  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const host = req.headers.host;
    const origins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) || !origins.some((origin) => new URL(origin).host === host)) return json(403, { error: "只允许本机插件页面访问。" });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null" && !origins.includes(origin)) return json(403, { error: "页面来源无效。" });
    const url = new URL(req.url, origins[0]);
    if (url.search) return json(400, { error: "接口不接受查询参数。" });
    if (url.pathname.startsWith("/api/")) {
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Artex-Session");
        res.writeHead(204); res.end(); return;
      }
      const supplied = Buffer.from(req.headers["x-artex-session"] || "");
      const expected = Buffer.from(capability);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: "插件服务已重新启动，请重新打开此页面。" });
      try {
        if (req.method === "GET" && url.pathname === "/api/state") {
          const instances = await listInstances(paths);
          return json(200, { instances });
        }
        if (req.method === "GET" && url.pathname === "/api/wsl") return json(200, { distros: await listWSL() });
        if (req.method !== "POST") return json(404, { error: "接口不存在。" });
        const values = await body(req);
        const target = targetInstance(paths, values);
        if (url.pathname === "/api/check") return json(200, await checkConnection(target, values, { bridgeFile: paths.agent, connectionResolver }));
        if (url.pathname === "/api/configure") {
          const previous = await readJSON(target.config);
          const address = normalizeURL(values.url || previous?.url || DEFAULT_ARTEX_URL, "ARTEX URL");
          if (!previous || address !== previous.url) {
            const duplicate = (await listInstances(paths)).some((item) => item.directory !== target.dir && item.url === address);
            if (duplicate) throw new Error("此 ARTEX 地址已经有连接。请编辑已有连接，或为另一个 ARTEX 服务填写不同的地址。 ");
          }
          const result = await configureInstance(target, values);
          await runtime?.scan();
          return json(200, result);
        }
        const config = await readJSON(target.config);
        if (!config) throw new Error("请先保存此实例的连接设置。");
        const sync = new Synchronizer({ paths: target, bridgeFile: paths.agent, shared: true, connectionResolver });
        if (url.pathname === "/api/resume") {
          const resumed = await withLock(target, async () => {
            const latest = await readJSON(target.config);
            await writeJSON(target.config, { ...latest, enabled: true });
            return { status: "resumed" };
          });
          if (resumed.status !== "busy") await sync.sync();
          return json(200, { ...resumed, message: resumed.status === "busy" ? "正在同步，请稍后重试。" : "此连接已恢复，跟随 ARTEX 原生行的模型选择。" });
        }
        if (url.pathname === "/api/sync") return json(200, await sync.sync());
        if (url.pathname === "/api/disconnect") {
          const result = await sync.disconnect();
          if (result.status === "busy") return json(200, { status: "busy", message: "此连接正在同步，请稍后重试暂停。" });
          return json(200, { status: "disconnected", message: "此连接已暂停并恢复原默认配置，其他连接继续同步。" });
        }
        return json(404, { error: "接口不存在。" });
      } catch (error) { return json(400, { error: error.message }); }
    }
    const asset = assets.get(url.pathname);
    if (!asset || !["GET", "HEAD"].includes(req.method)) return json(404, { error: "页面不存在。" });
    const own = "'self' " + origins.join(" ");
    // Wails uses a virtual origin in the real desktop window, rather than
    // the loopback origin used by browser fixtures. Without these explicit
    // ancestors WebView2 shows "127.0.0.1 refused to connect" even though
    // this server is listening and returns HTTP 200.
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src ${own}; style-src ${own}; connect-src ${own}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http://wails.localhost wails://localhost http://127.0.0.1:* http://localhost:*`);
    res.writeHead(200, { "Content-Type": asset.type });
    res.end(req.method === "HEAD" ? undefined : asset.content.replace("__ARTEX_SESSION__", capability));
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { actualPort = server.address().port; resolve(); });
  });
  server.unref();
  return {
    port: actualPort,
    async stop() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
