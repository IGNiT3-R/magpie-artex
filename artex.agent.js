// Magpie runs this file in moejs, which has no Node, fetch, or timers.
// The Bun entry point, index.mjs, carries these values into ARTEX's API.
export const agent = {
  id: "artex",
  name: "ARTEX",
  // This is a server integration, not a locally installed ARTEX CLI. The
  // plugin creates its data directory on load, so Magpie detects the row
  // before the user has supplied any ARTEX credentials.
  dir: "~/.config/magpie-artex",
  config: "~/.config/magpie-artex/agent.json",
  model: "model",
  ua: ["artex", "norma"],
  notice: "接入后可在 ARTEX 中选择此 Agent 可见的 Magpie 模型。首次授权请打开详情 → 设置；本机与各个 WSL 发行版分别配置。",
};

export function connect({ gateway, model, models }) {
  if (!gateway || !gateway.key || !gateway.url || !gateway.v1 || !model || !model.id) {
    throw new Error("ARTEX requires a gateway and a selected model");
  }
  // The complete catalog is part of Magpie's official connect input. ARTEX
  // picks LLM profiles, so the adapter makes these models available there.
  function entry(item) {
    const endpoints = item.native_endpoints || [];
    let format = "openai";
    if (endpoints.indexOf("/v1/chat/completions") < 0) {
      if (endpoints.indexOf("/v1/responses") >= 0) format = "openai-responses";
      else if (endpoints.indexOf("/v1/messages") >= 0) format = "anthropic";
    }
    return {
      id: item.id, format,
      context_window_k: item.context > 0 ? Math.min(1000, Math.max(32, Math.floor(item.context / 1000))) : 0,
      max_tokens: item.output > 0 ? Math.floor(item.output) : 0,
    };
  }
  const selected = entry(model);
  return {
    managed_by: "magpie-artex/v1",
    api_key: gateway.key,
    base_url: selected.format === "anthropic" ? gateway.url : gateway.v1,
    format: selected.format,
    context_window_k: selected.context_window_k,
    max_tokens: selected.max_tokens,
    ...(Array.isArray(models) ? { models: models.map(entry) } : {}),
  };
}
