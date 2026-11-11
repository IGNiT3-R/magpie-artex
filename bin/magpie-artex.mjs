#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { configureInstance, inspectInstance, checkConnection } from "../lib/management.mjs";
import { DEFAULT_ARTEX_URL, validateConfig } from "../lib/config.mjs";
import { pathsFor, readJSON } from "../lib/files.mjs";
import { startRuntime } from "../lib/runtime.mjs";
import { Synchronizer } from "../lib/sync.mjs";
import { discoverInstances, instancePaths } from "../lib/instances.mjs";
import { listRunningWSL } from "../lib/wsl.mjs";
import path from "node:path";

const help = `magpie-artex — 将 ARTEX 接入 Magpie 的 Agents 页面

用法：node bin/magpie-artex.mjs <setup|status|sync|watch|disconnect|instances|wsl|doctor> [选项]

  setup       验证 ARTEX 登录并保存连接设置（交互式密码输入不回显）
  status      查看同步结果及 ARTEX 当前默认模型，不显示密钥
  sync        立即同步一次
  watch       独立运行同步器；正常使用 Magpie 时无需另开
  disconnect  清除模型选择，恢复原来的默认 LLM 配置
  instances   列出已配置的本机、WSL 实例
  wsl         列出正在运行的 WSL 发行版（不会启动已停止的发行版）
  doctor      只读检查 localhost 连接及 WSL 网关地址，无需登录

设置选项：
  --url URL                ARTEX 服务地址，默认 http://localhost:8787
  --wsl DISTRO             选择独立的 WSL 实例，例如 Ubuntu-24.04
  --username NAME          默认 ARTEX（大写）
  --token-file PATH        从文件读取已有 ARTEX JWT
  --no-store-password      只存 JWT，7 天过期后需重新 setup
  --gateway-url URL        从 ARTEX 所在机器访问 Magpie 的地址
  --gateway-key-file PATH  自定义 Magpie 网关密钥文件
  --magpie-config-dir PATH 指定便携版等 Magpie 配置目录
  --format FORMAT          auto/openai/openai-responses/anthropic，默认 auto
  --profile-name NAME      新建的专用 LLM 配置名称
  --poll-interval-ms N     watch 轮询间隔，默认 5000ms
  --timeout-ms N           ARTEX API 超时，默认 10000ms
  --data-dir PATH          数据根目录；Magpie 后台使用默认目录
  --json                   以 JSON 输出 status/sync/disconnect 结果
  --help                   显示帮助

也可用 ARTEX_PASSWORD / ARTEX_TOKEN 环境变量完成非交互初始化。
默认目录：~/.config/magpie-artex
`;

async function passwordPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("当前不是交互终端。请设置 ARTEX_PASSWORD / ARTEX_TOKEN，或使用 --token-file。 ");
  }
  process.stdout.write("ARTEX 管理员密码（输入不回显）：");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const done = (error) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") { done(new Error("已取消初始化。")); return; }
        if (char === "\r" || char === "\n") { done(); return; }
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function setup(paths, args) {
  const previous = await readJSON(paths.config);
  const url = args.url || previous?.url || DEFAULT_ARTEX_URL;
  let password = process.env.ARTEX_PASSWORD || '';
  const token = args['token-file'] ? (await readFile(args['token-file'], 'utf8')).trim() : process.env.ARTEX_TOKEN || '';
  if (!password && !token && !(previous?.url === url && (previous.password || previous.token))) password = await passwordPrompt();
  const result = await configureInstance(paths, {
    url, username: args.username, password, token,
    auth_method: password ? 'password' : token ? 'token' : previous?.password ? 'password' : 'token',
    environment: args.wsl ? 'wsl' : 'local', wsl_distro: args.wsl,
    profile_name: args['profile-name'], format: args.format,
    gateway_url: args['gateway-url'],
    gateway_key_file: args['gateway-key-file'] ? path.resolve(args['gateway-key-file']) : undefined,
    magpie_config_dir: args['magpie-config-dir'] ? path.resolve(args['magpie-config-dir']) : undefined,
    timeout_ms: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
    poll_interval_ms: args['poll-interval-ms'] ? Number(args['poll-interval-ms']) : undefined,
    store_password: !args['no-store-password'],
  });
  return result;
}

async function status(paths, bridgeFile) { return inspectInstance(paths, { remote: true, bridgeFile }); }

function print(value, asJSON) {
  if (asJSON) { console.log(JSON.stringify(value, null, 2)); return; }
  if (value.message) console.log(value.message);
  if (value.directory) console.log(`配置目录：${value.directory}`);
  if (value.url) console.log(`ARTEX 地址：${value.url}`);
  if (value.environment) console.log(`运行环境：${value.environment === "wsl" ? `WSL · ${value.wsl_distro}` : "本机"}`);
  if (value.instances) for (const item of value.instances) console.log(`${item.wsl_distro ? `WSL · ${item.wsl_distro}` : "本机"}：${item.url || "未配置"}`);
  if (value.distros) for (const distro of value.distros) console.log(distro);
  if (value.health) console.log(`ARTEX 健康检查：${value.health.ok ? "可访问" : "失败"}${value.health.error ? ` — ${value.health.error}` : ""}`);
  if (value.network) console.log(`WSL 网络：${value.network.networking_mode}\nARTEX → Magpie：${value.network.gateway_url}`);
  if (value.network_error) console.error(value.network_error);
  if (value.configured === false) console.log("尚未初始化。请运行 npm run setup。");
  if ("selection" in value) console.log(`Magpie 选择：${value.selection || "未连接"}`);
  if (value.active_profile) console.log(`ARTEX 默认配置：${value.active_profile.name} → ${value.active_profile.model} (${value.active_profile.format})`);
  if (value.last_sync) console.log(`同步状态：${value.last_sync.status} — ${value.last_sync.message}\n更新时间：${value.last_sync.updated_at}`);
  if (value.last_sync?.gateway_url) console.log(`ARTEX → Magpie：${value.last_sync.gateway_url} (${value.last_sync.networking_mode})`);
  if (value.error) console.error(value.error);
}

async function doctor(paths, args, bridgeFile) {
  return checkConnection(paths, {
    url: args.url, environment: args.wsl ? 'wsl' : undefined, wsl_distro: args.wsl,
    timeout_ms: Number(args['timeout-ms'] || 5000), gateway_url: args['gateway-url'],
    gateway_key_file: args['gateway-key-file'] ? path.resolve(args['gateway-key-file']) : undefined,
    magpie_config_dir: args['magpie-config-dir'] ? path.resolve(args['magpie-config-dir']) : undefined,
  }, { bridgeFile });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" }, username: { type: "string" }, "token-file": { type: "string" },
      "no-store-password": { type: "boolean" }, "gateway-url": { type: "string" },
      wsl: { type: "string" }, "gateway-key-file": { type: "string" }, "magpie-config-dir": { type: "string" },
      format: { type: "string" }, "profile-name": { type: "string" },
      "poll-interval-ms": { type: "string" }, "timeout-ms": { type: "string" },
      "data-dir": { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error("一次只能执行一个命令。 ");
  const root = pathsFor(values["data-dir"]);
  const paths = instancePaths(root, values.wsl);
  const sync = new Synchronizer({ paths, bridgeFile: root.agent, shared: true });
  let result;
  switch (command) {
    case "setup": result = await setup(paths, values); break;
    case "status": result = await status(paths, root.agent); break;
    case "sync": result = await sync.sync(); break;
    case "disconnect": {
      result = await sync.disconnect();
      break;
    }
    case "doctor": result = await doctor(paths, values, root.agent); break;
    case "wsl": result = { distros: await listRunningWSL(), message: "正在运行的 WSL 发行版：" }; break;
    case "instances": {
      const instances = [];
      for (const child of [root, ...await discoverInstances(root)]) {
        const config = await readJSON(child.config);
        if (config) instances.push({ environment: config.environment || "local", wsl_distro: config.wsl_distro, url: config.url, directory: child.dir });
      }
      result = { instances };
      break;
    }
    case "watch": {
      const config = validateConfig(await readJSON(paths.config));
      const runtime = await startRuntime({ paths, synchronizer: sync, interval: config.poll_interval_ms, keepAlive: true, log: (message) => console.error(`[magpie-artex] ${message}`) });
      console.error("正在同步；按 Ctrl+C 退出。退出不会改变 ARTEX 的当前模型。");
      const stop = () => { void runtime.stop().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    }
    default: throw new Error(`未知命令：${command}。使用 --help 查看帮助。`);
  }
  print(result, values.json);
  if (result.status === "busy" || result.reachable === false || result.health?.ok === false || result.network_error) process.exitCode = 1;
}

main().catch((error) => { console.error(`magpie-artex: ${error.message}`); process.exitCode = 1; });
