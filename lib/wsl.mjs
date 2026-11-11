import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeURL } from "./config.mjs";
import { wslInstance } from "./instances.mjs";

const execute = promisify(execFile);
const options = { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: "buffer" };
const probeScript = 'mode=$(wslinfo --networking-mode 2>/dev/null || /usr/lib/wsl/wslinfo --networking-mode 2>/dev/null || true); printf "mode:%s\\n" "$mode"; ip -4 route show default 2>/dev/null | sed "s/^/route:/"; true';

export function decodeWSL(output) {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || "");
  const zeroes = [...buffer.subarray(0, 120)].filter((byte) => byte === 0).length;
  return buffer.toString(zeroes > 0 || (buffer[0] === 0xff && buffer[1] === 0xfe) ? "utf16le" : "utf8").replace(/^\uFEFF/, "").replaceAll("\0", "");
}

export async function listRunningWSL({ runner = execute, platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  // Avoid Windows' installation/update UI on machines with no WSL distro.
  try { await runner("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s", "/v", "DistributionName"], options); }
  catch { return []; }
  let result;
  try { result = await runner("wsl.exe", ["--list", "--running", "--quiet"], options); }
  catch { throw new Error("无法列出正在运行的 WSL 发行版；请检查 WSL 状态后重试。 "); }
  return decodeWSL(result.stdout).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

export function parseWSLProbe(text, fallback = "") {
  const rawMode = /^mode:([^\r\n]*)/m.exec(text)?.[1]?.trim().toLowerCase();
  const mode = rawMode || fallback.toLowerCase() || "nat";
  const route = /^route:default\s+via\s+([0-9.]+)\b/m.exec(text)?.[1] || "";
  return { mode, host: isIP(route) === 4 ? route : "" };
}

function configuredMode(text) {
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/[#;].*$/, "").trim();
    if (/^\[.*\]$/.test(clean)) section = clean.toLowerCase();
    else if (section === "[wsl2]") {
      const match = /^networkingMode\s*=\s*([^\s]+)$/i.exec(clean);
      if (match) return match[1];
    }
  }
  return "";
}

export class ConnectionResolver {
  constructor({ runner = execute, platform = process.platform, home = homedir(), magpieDirectory, read = readFile, now = Date.now } = {}) {
    Object.assign(this, { runner, platform, home, magpieDirectory, read, now });
    this.cache = new Map();
  }

  async probe(distro) {
    const cached = this.cache.get(distro.toLowerCase());
    if (cached && this.now() - cached.at < 30000) return cached.value;
    if (this.platform !== "win32") throw new Error("自动 WSL 探测需从 Windows 运行；也可使用 --gateway-url 明确指定网关地址。 ");
    const running = await listRunningWSL({ runner: this.runner, platform: this.platform });
    const found = running.find((name) => name.toLowerCase() === distro.toLowerCase());
    if (!found) throw new Error(`WSL 发行版“${distro}”当前未运行；请先启动它。插件不会启动已停止的发行版。`);
    let result;
    try { result = await this.runner("wsl.exe", ["--distribution", found, "--exec", "sh", "-c", probeScript], options); }
    catch { throw new Error(`无法读取 WSL 发行版“${distro}”的网络模式；可用 --gateway-url 显式设置网关。`); }
    const fallback = configuredMode(await this.read(path.join(this.home, ".wslconfig"), "utf8").catch(() => ""));
    const value = parseWSLProbe(decodeWSL(result.stdout), fallback);
    this.cache.set(distro.toLowerCase(), { at: this.now(), value });
    return value;
  }

  async keyFromFile(file) {
    let key;
    try { key = (await this.read(file, "utf8")).trim(); }
    catch { throw new Error("无法读取网关密钥文件。请检查 --gateway-key-file 或 Magpie 配置目录。 "); }
    if (!key || /[\x00-\x20]/.test(key)) throw new Error("网关密钥文件内容无效。 ");
    return key;
  }

  async resolve(bridge, config) {
    const effective = { ...config };
    const nextBridge = { ...bridge };
    const id = config.agent_id || (config.environment === "wsl" ? wslInstance(config.wsl_distro).id : "artex");
    const original = new URL(normalizeURL(bridge.base_url));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(original.hostname.toLowerCase());
    let base = config.gateway_url || bridge.base_url;
    let mode = "local";
    let network;
    if (config.environment === "wsl") {
      if (config.gateway_url && config.gateway_key_file) network = { mode: "manual", host: "" };
      else {
        try { network = await this.probe(config.wsl_distro); }
        catch (error) { if (!config.gateway_url) throw error; network = { mode: "manual", host: "" }; }
      }
      mode = network.mode;
      if (!config.gateway_url && loopback) {
        if (["mirrored", "consomme", "virtioproxy"].includes(mode)) {
          base = bridge.base_url;
        } else if (mode === "nat" && network.host) {
          const url = new URL(bridge.base_url);
          url.hostname = network.host;
          base = normalizeURL(url.href);
        } else {
          throw new Error(`WSL 网络模式 ${mode} 的 Windows 网关地址无法自动确定；请用 --gateway-url 指定。`);
        }
      }
    }
    effective.gateway_url = normalizeURL(base).replace(/\/v1$/, "");
    if (config.gateway_key_file) {
      const key = await this.keyFromFile(config.gateway_key_file);
      nextBridge.api_key = key.startsWith("wsl-") ? `${key}-${id}` : key;
    } else if (config.environment === "wsl" && mode === "nat" && loopback && new URL(effective.gateway_url).hostname === network.host) {
      // Magpie's NAT listener accepts its WSL key, not the Windows loopback
      // agent token. Match agentKeyAt in Magpie without printing that key.
      const directory = config.magpie_config_dir || this.magpieDirectory || path.join(process.env.XDG_CONFIG_HOME || path.join(this.home, ".config"), "magpie");
      let key;
      try { key = await this.keyFromFile(path.join(directory, "wsl-key")); }
      catch { throw new Error("Magpie 的 WSL 网关密钥尚不可用。请先让 Magpie 检测运行中的 WSL，或通过 --magpie-config-dir / --gateway-key-file 指定。 "); }
      if (!/^wsl-[a-f0-9]{48}$/i.test(key)) throw new Error("Magpie 的 WSL 网关密钥格式不兼容，请更新 Magpie 或使用自定义网关密钥。 ");
      nextBridge.api_key = `${key}-${id}`;
    }
    return {
      bridge: nextBridge, config: effective,
      info: { environment: config.environment || "local", ...(config.wsl_distro ? { wsl_distro: config.wsl_distro } : {}), networking_mode: mode, gateway_url: effective.gateway_url },
    };
  }
}
