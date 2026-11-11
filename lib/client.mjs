import { normalizeURL } from "./config.mjs";

export class ArtexClient {
  constructor(config, fetcher = globalThis.fetch) {
    this.config = config;
    this.url = normalizeURL(config.url, "ARTEX URL");
    this.token = config.token || "";
    this.fetcher = fetcher;
    this.loginPending = null;
  }

  async send(route, { method = "GET", body, token = this.token } = {}) {
    let response;
    try {
      response = await this.fetcher(`${this.url}/api${route}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeout_ms ?? 10_000),
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Read the body within the request deadline, too.
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch {
        if (response.ok) throw new Error("ARTEX 返回了非 JSON 响应，请检查地址及反向代理配置。 ");
      }
      return { status: response.status, ok: response.ok, data };
    } catch (error) {
      if (error.message?.startsWith("ARTEX 返回")) throw error;
      throw new Error(`无法访问 ARTEX ${route}，请检查服务、地址和网络（超时 ${this.config.timeout_ms ?? 10_000}ms）。`);
    }
  }

  async login() {
    if (!this.config.password) throw new Error("ARTEX 登录已过期；请在此 Agent 的详情 → 设置中更新登录信息，或配置密码以自动续期。 ");
    if (this.loginPending) return this.loginPending;
    this.loginPending = (async () => {
      const response = await this.send("/auth/login", {
        method: "POST", token: "",
        body: { username: this.config.username || "ARTEX", password: this.config.password },
      });
      if (!response.ok || typeof response.data?.token !== "string" || !response.data.token) {
        throw new Error(`ARTEX 登录失败（HTTP ${response.status}）；请检查用户名、密码及首次初始化状态。`);
      }
      this.token = response.data.token;
      return this.token;
    })();
    try { return await this.loginPending; } finally { this.loginPending = null; }
  }

  async request(route, { method = "GET", body } = {}) {
    if (!this.token) await this.login();
    let response = await this.send(route, { method, body });
    if (response.status === 401 && this.config.password) {
      await this.login();
      response = await this.send(route, { method, body });
    }
    if (!response.ok) {
      const hint = response.status === 401 ? "登录已过期，请在此 Agent 的详情 → 设置中更新登录信息。" :
        response.status === 404 ? "接口不存在，请检查 ARTEX 地址和版本。" :
          response.status === 503 ? "ARTEX 数据库或服务暂时不可用。" : "请查看 ARTEX 后端日志。";
      // Never echo an upstream body: a proxy may include submitted credentials.
      throw new Error(`ARTEX ${method} ${route} 失败（HTTP ${response.status}）。${hint}`);
    }
    return response.data;
  }

  async profiles() {
    const data = await this.request("/llm/profiles");
    if (!Array.isArray(data?.profiles) || data.profiles.some((p) => !p || !/^\d+$/.test(String(p.id)) || !Number.isSafeInteger(Number(p.id)) || Number(p.id) <= 0 || typeof p.name !== "string")) {
      throw new Error("ARTEX 的 LLM 配置列表格式不兼容；已停止同步。 ");
    }
    return data.profiles;
  }

  async save(profile) {
    const data = await this.request("/llm/profiles", { method: "POST", body: profile });
    if (!Number.isSafeInteger(Number(data?.id)) || Number(data.id) <= 0) throw new Error("ARTEX 未返回有效的 LLM 配置 ID。 ");
    return String(data.id);
  }

  async activate(id) {
    const data = await this.request("/llm/profiles/active", { method: "POST", body: { id: Number(id) } });
    if (data?.ok !== true) throw new Error("ARTEX 未确认默认 LLM 配置切换。 ");
  }

  // ARTEX's delete endpoint also clears task/agent/conversation bindings.
  // Read every reference list first; an unavailable or incompatible list
  // means that cleanup must wait, never that there are no references.
  async profileReferences() {
    const lists = await Promise.all([
      ["/tasks", "tasks"], ["/agents", "agents"], ["/conversations", "conversations"],
    ].map(async ([route, key]) => {
      const data = await this.request(route);
      if (!Array.isArray(data?.[key]) || data[key].some((row) => !row || typeof row !== "object")) {
        throw new Error("ARTEX 的模型引用列表格式不兼容，已保留旧模型配置。");
      }
      return { key, rows: data[key] };
    }));
    const references = new Set();
    for (const { key, rows } of lists) for (const row of rows) {
      if (key === "tasks" && row.llm_profile_ids !== null && !Array.isArray(row.llm_profile_ids)) {
        throw new Error("ARTEX 的任务模型链格式不兼容，已保留旧模型配置。");
      }
      for (const id of [row.llm_profile_id, row.active_llm_profile_id, ...(row.llm_profile_ids || [])]) {
        if (id == null) continue;
        if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error("ARTEX 的模型引用 ID 无效，已保留旧模型配置。");
        references.add(String(id));
      }
    }
    return references;
  }

  async remove(id) {
    const data = await this.request(`/llm/profiles/${Number(id)}`, { method: "DELETE" });
    if (String(data?.deleted) !== String(id)) throw new Error("ARTEX 未确认旧模型配置删除，稍后将重新核对。");
  }
}
