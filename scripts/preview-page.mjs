// Isolated browser verification fixture. Never reads real ARTEX/Magpie data.
// node scripts/preview-page.mjs --bridge <magpie/internal/gui/pagebridge.js>
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { startPageService } from "../lib/page-service.mjs";
import { startPluginRuntime } from "../lib/plugin-runtime.mjs";
import { instancePaths } from "../lib/instances.mjs";
import { readJSON, writeJSON } from "../lib/files.mjs";
import { artexServer, selection, temporaryPaths } from "../test-support/artex.mjs";

const { values } = parseArgs({ options: { bridge: { type: "string" } } });
assert.ok(values.bridge, "Pass Magpie's unmodified pagebridge.js with --bridge");
const cleanup = [], resources = { after: (fn) => cleanup.push(fn) };
const paths = await temporaryPaths(resources), api = await artexServer(resources);
const magpieDirectory = path.join(paths.dir, "magpie");
await writeJSON(path.join(magpieDirectory, "plugins.json"), { plugins: [] });
const connectionResolver = { resolve: async (bridge, config) => ({ bridge, config, info: { networking_mode: "fixture", gateway_url: bridge.base_url } }) };
const runtime = await startPluginRuntime({ paths, magpieDirectory, interval: 500, connectionResolver });
resources.after(() => runtime.stop());
const service = await startPageService({ port: 0, paths, magpieDirectory, runtime, connectionResolver, listWSL: async () => ["Fixture-Ubuntu"] });
resources.after(() => service.stop());
const bridge = await readFile(values.bridge, "utf8");
const bootstrap = await readFile(new URL("../page/bootstrap.html", import.meta.url), "utf8");
const bootstrapJS = await readFile(new URL("../page/bootstrap.js", import.meta.url), "utf8");
let hostPort;
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/plugin/_magpie/service/")) {
    const upstream = request({ host: "127.0.0.1", port: service.port, path: "/" + req.url.slice("/plugin/_magpie/service/".length), method: req.method, headers: { ...req.headers, host: `127.0.0.1:${service.port}` } }, (reply) => {
      const headers = { ...reply.headers };
      if (headers["content-security-policy"]) headers["content-security-policy"] = [headers["content-security-policy"].replaceAll("'self'", `'self' http://127.0.0.1:${hostPort}/plugin/_magpie/service/`), "sandbox allow-scripts; frame-ancestors 'self'"];
      res.writeHead(reply.statusCode, headers); reply.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream); return;
  }
  if (req.url === "/fixture/select" && req.method === "POST") {
    await writeJSON(instancePaths(paths, "Fixture-Ubuntu").agent, selection("fixture/browser-model"));
    res.end("selected"); return;
  }
  if (req.url.startsWith("/plugin/")) {
    const assets = { "/plugin/bootstrap.html": [bootstrap, "text/html"], "/plugin/bootstrap.js": [bootstrapJS, "text/javascript"], "/plugin/_magpie/bridge.js": [bridge, "text/javascript"] };
    const asset = assets[req.url]; if (!asset) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Security-Policy", `sandbox allow-scripts; default-src 'none'; script-src http://127.0.0.1:${hostPort}/plugin/; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; frame-ancestors 'self'`);
    res.setHeader("Content-Type", asset[1] + "; charset=utf-8"); res.end(asset[0]); return;
  }
  const web = req.url.includes("web");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>Magpie ARTEX isolated preview</title><style>body{margin:0;font:13px system-ui;background:#eef2f5}nav{padding:8px 16px}iframe{border:0;width:100%;height:calc(100vh - 50px)}</style><nav>隔离测试预览 · ${web ? "magpie web 代理" : "桌面服务"} · <button id="select">模拟 Magpie 选择模型</button></nav><iframe title="ARTEX 连接管理" sandbox="allow-scripts" src="/plugin/bootstrap.html"></iframe><script>
  const frame=document.querySelector('iframe');
  addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.magpie!==1)return;const message=event.data;let result={};if(message.method==='hello')result={dark:false,lang:'zh',tokens:{},service:${JSON.stringify(web ? "/plugin/_magpie/service/" : "")}};else if(message.method==='options.get')result={port:${service.port}};event.source.postMessage({magpie:1,id:message.id,result},'*')});
  document.getElementById('select').onclick=()=>fetch('/fixture/select',{method:'POST'});
  </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); hostPort = server.address().port;
resources.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
console.log(JSON.stringify({ preview: `http://127.0.0.1:${hostPort}/`, web_preview: `http://127.0.0.1:${hostPort}/?web`, artex: api.url, username: "ARTEX", password: api.password, directory: paths.dir }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; for (const fn of cleanup.reverse()) await fn(); }
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
