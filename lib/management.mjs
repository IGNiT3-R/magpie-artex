import { setTimeout as delay } from "node:timers/promises";
import { ArtexClient } from "./client.mjs";
import { DEFAULT_ARTEX_URL, MANAGED_BY, normalizeURL, validateConfig } from "./config.mjs";
import { pathsFor, readJSON, withLock, writeJSON } from "./files.mjs";
import { discoverInstances, instancePaths, wslInstance } from "./instances.mjs";
import { ConnectionResolver } from "./wsl.mjs";

export function targetInstance(root, values = {}) {
  const environment = values.environment || (values.wsl_distro ? "wsl" : "local");
  if (!["local", "wsl"].includes(environment)) throw new Error("请选择本机或 WSL 环境。");
  if (environment === "wsl") wslInstance(values.wsl_distro);
  return instancePaths(root, environment === "wsl" ? values.wsl_distro : undefined);
}

// Shared by the page and CLI. Passwords/JWTs only enter this function and
// config.json; responses are constructed explicitly rather than redacted later.
export async function configureInstance(paths, values, { clientFactory = (config) => new ArtexClient(config) } = {}) {
  // A newly loaded Magpie host may still be finishing its first tick.
  // Wait briefly for that writer rather than rejecting the first Save.
  const deadline = Date.now() + 5000;
  let result;
  do {
    result = await withLock(paths, async () => {
    const previous = await readJSON(paths.config);
    const state = await readJSON(paths.state);
    const environment = values.environment || (values.wsl_distro ? "wsl" : "local");
    const instance = environment === "wsl" ? wslInstance(values.wsl_distro) : null;
    const url = normalizeURL(values.url || previous?.url || DEFAULT_ARTEX_URL, "ARTEX URL");
    const username = values.username || previous?.username || "ARTEX";
    const reuse = previous?.url === url && (previous?.username || "ARTEX") === username;
    const method = values.auth_method || (values.password || previous?.password ? "password" : "token");
    if (!["password", "token"].includes(method)) throw new Error("登录方式必须为密码或 JWT。");
    const raw = {
      version: 1, url, username, environment,
      ...(instance ? { wsl_distro: instance.distro, agent_id: instance.id } : { agent_id: "artex" }),
      password: method === "password" ? values.password || (reuse ? previous?.password : "") || "" : "",
      token: method === "token" ? values.token || (reuse ? previous?.token : "") || "" : "",
      profile_name: values.profile_name || previous?.profile_name || (instance ? `Magpie (WSL: ${instance.distro})`.slice(0, 120) : "Magpie (managed)"),
      gateway_url: values.gateway_url ?? previous?.gateway_url ?? "",
      gateway_key_file: values.gateway_key_file ?? previous?.gateway_key_file ?? "",
      magpie_config_dir: values.magpie_config_dir ?? previous?.magpie_config_dir,
      format: values.format || previous?.format || "auto",
      timeout_ms: values.timeout_ms ?? previous?.timeout_ms ?? 10000,
      poll_interval_ms: values.poll_interval_ms ?? previous?.poll_interval_ms ?? 5000,
    };
    const config = validateConfig(raw);
    if (state && state.artex_url !== config.url) throw new Error("此实例已有其他 ARTEX 地址的恢复记录，请使用另一个实例配置，避免丢失恢复记录。");
    if (state?.profile_id && config.profile_name !== state.profile_name) throw new Error("专用配置已创建，请继续使用原来的配置名称。");
    if (previous?.environment === "wsl" && previous.wsl_distro.toLowerCase() !== instance?.distro.toLowerCase()) throw new Error("不能更改现有实例的 WSL 发行版，请添加另一个实例。");
    const client = clientFactory(config);
    if (config.password) await client.login();
    await client.profiles();
    config.token = client.token;
    if (values.store_password === false || !config.password) delete config.password;
    await writeJSON(paths.config, config);
    if (await readJSON(paths.agent) === null) await writeJSON(paths.agent, {});
    return {
      status: "configured", url: config.url, directory: paths.dir, environment,
      ...(instance ? { wsl_distro: instance.distro } : {}),
      agent_id: instance?.id || "artex", agent_name: instance?.name || "ARTEX · Windows",
      message: `ARTEX 已授权。请在“${instance?.name || "ARTEX · 本机"}”行点击接入，即可在 ARTEX 中选择 Magpie 模型。`,
    };
    });
    if (result.status !== "busy") break;
    await delay(50);
  } while (Date.now() < deadline);
  if (result.status === "busy") throw new Error("此实例正在同步，请稍后重试。");
  return result;
}

export async function inspectInstance(paths, { remote = false, bridgeFile = paths.agent } = {}) {
  const raw = await readJSON(paths.config);
  const bridge = await readJSON(bridgeFile);
  const last = await readJSON(paths.status);
  const result = { configured: Boolean(raw), directory: paths.dir, selection: bridge?.managed_by === MANAGED_BY ? bridge.model : null, last_sync: last };
  if (!raw) return result;
  const config = validateConfig(raw);
  const instance = config.environment === "wsl" ? wslInstance(config.wsl_distro) : null;
  Object.assign(result, {
    id: instance?.id || "artex", name: instance?.name || "ARTEX (本机)",
    environment: config.environment, wsl_distro: config.wsl_distro, url: config.url,
    username: config.username, profile_name: config.profile_name, format: config.format,
    gateway_url: config.gateway_url, gateway_key_file: config.gateway_key_file || "",
    has_password: Boolean(config.password), has_token: Boolean(config.token),
  });
  if (remote) {
    try {
      const profiles = await new ArtexClient(config).profiles();
      const active = profiles.find((p) => p.is_default);
      result.active_profile = active ? { id: String(active.id), name: active.name, model: active.model, format: active.format } : null;
      result.reachable = true;
    } catch (error) { result.reachable = false; result.error = error.message; }
  }
  return result;
}

export async function listInstances(root = pathsFor()) {
  const list = [];
  for (const child of [root, ...await discoverInstances(root)]) {
    const instance = await inspectInstance(child);
    if (instance.configured) list.push(instance);
  }
  return list;
}

export async function checkConnection(paths, values = {}, { bridgeFile = paths.agent, connectionResolver = new ConnectionResolver() } = {}) {
  const raw = await readJSON(paths.config) || {};
  const config = {
    ...raw, url: values.url || raw.url || DEFAULT_ARTEX_URL,
    timeout_ms: values.timeout_ms ?? 5000,
    environment: values.environment || (values.wsl_distro ? "wsl" : raw.environment || "local"),
    wsl_distro: values.wsl_distro || raw.wsl_distro,
    gateway_url: values.gateway_url ?? raw.gateway_url,
    gateway_key_file: values.gateway_key_file ?? raw.gateway_key_file,
    magpie_config_dir: values.magpie_config_dir ?? raw.magpie_config_dir,
  };
  const result = { url: config.url, environment: config.environment, wsl_distro: config.wsl_distro };
  try {
    const response = await new ArtexClient(config).send("/health", { token: "" });
    result.health = { ok: response.ok && response.data?.service === "artex", status: response.status };
  } catch (error) { result.health = { ok: false, error: error.message }; }
  if (config.environment === "wsl") {
    try {
      const bridge = await readJSON(bridgeFile) || {};
      const resolved = await connectionResolver.resolve({ base_url: "http://localhost:3425/v1", ...bridge }, config);
      result.network = resolved.info;
    } catch (error) { result.network_error = error.message; }
  }
  return result;
}
