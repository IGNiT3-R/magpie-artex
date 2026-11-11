export const FORMATS = ["openai", "openai-responses", "anthropic"];
export const MANAGED_BY = "magpie-artex/v1";
export const DEFAULT_PROFILE_NAME = "Magpie (managed)";
export const DEFAULT_ARTEX_URL = "http://localhost:8787";

export function normalizeURL(value, label = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 必须是完整的 http:// 或 https:// 地址。`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} 只支持 HTTP(S)，且不能包含账号、密码、查询参数或片段。`);
  }
  return url.href.replace(/\/+$/, "");
}

export function validateConfig(raw) {
  if (!raw || raw.version !== 1) throw new Error("请先在 Magpie 设置 → 插件的 ARTEX 连接设置中保存连接，或使用 setup 初始化。 ");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled 必须为布尔值。");
  const url = normalizeURL(raw.url || DEFAULT_ARTEX_URL, "ARTEX URL");
  if (!raw.token && !raw.password) throw new Error("请填写 ARTEX 管理员密码或 JWT；已保存的登录信息可在连接管理页面更新。");
  for (const key of ["token", "password", "username", "profile_name", "gateway_url", "format", "environment", "wsl_distro", "agent_id", "gateway_key_file", "magpie_config_dir"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`config.json 的 ${key} 必须是字符串。`);
  }
  const environment = raw.environment || (raw.wsl_distro ? "wsl" : "local");
  if (!["local", "wsl"].includes(environment)) throw new Error("environment 必须为 local 或 wsl。 ");
  if (environment === "wsl" && (!raw.wsl_distro?.trim() || /[\x00-\x1f\\/]/.test(raw.wsl_distro))) throw new Error("WSL 实例需要有效的 wsl_distro。 ");
  if (raw.agent_id && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.agent_id)) throw new Error("agent_id 不符合 Magpie 插件 ID 规则。 ");
  const format = raw.format || "auto";
  if (format !== "auto" && !FORMATS.includes(format)) throw new Error("不支持的 ARTEX API 格式。 ");
  const timeout = raw.timeout_ms ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) throw new Error("timeout_ms 必须在 100 到 60000 之间。 ");
  const poll = raw.poll_interval_ms ?? 5_000;
  if (!Number.isInteger(poll) || poll < 500 || poll > 60_000) throw new Error("poll_interval_ms 必须在 500 到 60000 之间。 ");
  const profileName = (raw.profile_name || DEFAULT_PROFILE_NAME).trim();
  if (!profileName || profileName.length > 120) throw new Error("profile_name 长度必须在 1 到 120 之间。 ");
  return {
    ...raw,
    url,
    environment,
    username: raw.username || "ARTEX",
    profile_name: profileName,
    format,
    timeout_ms: timeout,
    poll_interval_ms: poll,
    gateway_url: raw.gateway_url ? normalizeURL(raw.gateway_url, "Magpie 网关地址") : "",
  };
}

export function desiredProfile(bridge, config) {
  if (!bridge || bridge.managed_by !== MANAGED_BY) return null;
  if (typeof bridge.model !== "string" || !bridge.model.includes("/") || /[\r\n]/.test(bridge.model) ||
      typeof bridge.api_key !== "string" || !bridge.api_key || /[\r\n]/.test(bridge.api_key)) {
    throw new Error("Magpie 的 agent.json 缺少有效模型或网关密钥；请在 Agents 页面重新选择模型。 ");
  }
  const format = config.format === "auto" ? bridge.format : config.format;
  if (!FORMATS.includes(format)) throw new Error("agent.json 中的 API 格式无效。 ");
  let root = normalizeURL(bridge.base_url, "Magpie 网关地址").replace(/\/v1$/, "");
  if (config.gateway_url) root = config.gateway_url.replace(/\/v1$/, "");
  const context = bridge.context_window_k ?? 0;
  const output = bridge.max_tokens ?? 0;
  if (!Number.isInteger(context) || context < 0 || context > 1000 || !Number.isInteger(output) || output < 0) {
    throw new Error("agent.json 中的上下文或输出长度无效。 ");
  }
  return {
    format,
    model: bridge.model,
    base_url: format === "anthropic" ? root : `${root}/v1`,
    api_key: bridge.api_key,
    context_window_k: context,
    max_tokens: output,
    // The gateway applies reasoning settings and failover for the chosen model.
    thinking_type: "",
    reasoning_effort: "",
    max_tokens_field: "",
    proxy: "",
    pool_exclude: true,
  };
}
