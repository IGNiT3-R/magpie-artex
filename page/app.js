(() => {
  const $ = (id) => document.getElementById(id);
  const session = document.querySelector('meta[name="artex-session"]').content;
  const form = $("connection");
  const fragment = new URLSearchParams(location.hash.slice(1));
  const embedded = fragment.has("agents");
  const agentID = embedded ? fragment.get("agent") : null;
  const bootstrap = artexReconnectURL(fragment.get("bootstrap"), location.href);
  let recovering = false;
  function reconnect() {
    if (!bootstrap || recovering) return;
    recovering = true;
    notice("Magpie 正在重载插件，正在自动重新连接…");
    // Returning to Magpie's own entry warms the lazy Bun host. Reloading
    // the dead service URL alone cannot start that host again.
    setTimeout(() => location.replace(bootstrap), 500);
  }
  if (embedded) {
    document.documentElement.classList.add("embedded-page");
    document.body.classList.add("embedded");
    $("instances-heading").textContent = "连接信息";
    $("add").textContent = "添加其他连接";
    $("instances-heading").parentElement.append($("add"));
  }
  let instances = [], availableDistros = [], editing = null, busy = false, snapshot = "", hello = 0;
  const stateLabels = { synced: "已同步", inactive: "ARTEX 已切换默认配置", disconnected: "未选择模型", restored: "已恢复", waiting: "等待配置", busy: "正在同步", error: "同步失败" };
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function notice(text, type = "") { const box = $("notice"); box.textContent = text; box.className = type; box.hidden = !text; }
  function identity(item) { return { environment: item.environment, ...(item.wsl_distro ? { wsl_distro: item.wsl_distro } : {}) }; }
  async function api(route, values) {
    let response;
    try {
      response = await fetch(`api/${route}`, {
        method: values === undefined ? "GET" : "POST", credentials: "omit", redirect: "error",
        headers: { "X-Artex-Session": session, ...(values === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(values === undefined ? {} : { body: JSON.stringify(values) }), signal: AbortSignal.timeout(145000),
      });
    } catch { reconnect(); throw new Error("插件服务暂时没有响应，Magpie 可能正在重新加载插件。正在尝试恢复连接。"); }
    if (response.status === 401) { location.reload(); throw new Error("正在重新连接插件服务…"); }
    if ([502, 503, 504].includes(response.status)) { reconnect(); throw new Error("正在重新启动 ARTEX 插件服务…"); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "操作未完成。");
    return result;
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    $("form-status").textContent = "正在处理…";
    try { await action(); }
    catch (error) { notice(error.message, "error"); }
    finally {
      busy = false; document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      $("form-status").textContent = "";
    }
  }
  function operationButton(title, route, item, className) {
    const button = node("button", title, className); button.type = "button";
    button.addEventListener("click", () => run(async () => {
      const result = await api(route, identity(item));
      if (route === "check") showCheck(result);
      else notice(result.message || stateLabels[result.status] || "操作完成。", result.status === "busy" ? "warning" : "");
      await refresh();
    }));
    return button;
  }
  function render() {
    const box = $("instances"); box.replaceChildren();
    if (!instances.length) {
      box.append(node("p", embedded ? "添加本机或 WSL 连接并保存授权，然后在相应的 ARTEX 行接入，即可在 ARTEX 中选择 Magpie 模型。" : "还没有连接 ARTEX。点击“添加实例”，填写地址和登录信息。", "empty"));
      if (embedded) $("add").textContent = "添加连接";
      return;
    }
    for (const item of instances) {
      const card = node("article");
      const head = node("div", undefined, "card-head");
      const status = item.last_sync?.status || "disconnected";
      const ready = status === "inactive" && item.last_sync?.catalog_models;
      const badge = node("span", ready ? "模型已就绪" : stateLabels[status] || status, `badge${status === "error" ? " error" : status === "inactive" && !ready ? " warning" : ""}`);
      head.append(node("h3", item.name), badge); card.append(head, node("p", item.url, "address"));
      if (!embedded) card.append(node("div", item.selection ? `所选模型：${item.selection}` : "请在 Magpie → Agents 为此实例选择模型。", "model"));
      if (item.last_sync?.message) card.append(node("p", item.last_sync.message, "detail"));
      if (item.last_sync?.gateway_url) card.append(node("p", `ARTEX → Magpie：${item.last_sync.gateway_url} · ${item.last_sync.networking_mode}`, "detail"));
      if (item.last_sync?.updated_at) card.append(node("p", `状态更新：${new Date(item.last_sync.updated_at).toLocaleString()}`, "detail"));
      const actions = node("div", undefined, "actions");
      const edit = node("button", "编辑连接"); edit.type = "button"; edit.addEventListener("click", () => openEditor(item)); actions.append(edit);
      actions.append(operationButton("检查连接", "check", item));
      card.append(actions); box.append(card);
    }
    requestAnimationFrame(reportSize);
  }
  async function refresh() {
    const data = await api("state");
    instances = agentID ? data.instances.filter((item) => item.id === agentID) : data.instances;
    const next = JSON.stringify(instances);
    if (next !== snapshot) { snapshot = next; render(); }
  }
  function showCheck(result) {
    const lines = [`ARTEX ${result.url}：${result.health?.ok ? "可访问" : result.health?.error || `服务响应不兼容（HTTP ${result.health?.status}）`}`];
    if (result.network) lines.push(`WSL 网络：${result.network.networking_mode}\nARTEX → Magpie：${result.network.gateway_url}`);
    if (result.network_error) lines.push(result.network_error);
    notice(lines.join("\n"), !result.health?.ok || result.network_error ? "warning" : "");
  }
  function environmentChanged() { $("distro-field").hidden = $("environment").value !== "wsl"; $("wsl_distro").required = $("environment").value === "wsl"; }
  function authChanged() {
    const password = $("auth_method").value === "password";
    $("password-field").hidden = !password; $("store-field").hidden = !password; $("token-field").hidden = password;
  }
  function openEditor(item = null) {
    editing = item; form.reset();
    $("editor-heading").textContent = item ? `编辑 ${item.name}` : "添加 ARTEX 实例";
    for (const id of ["environment", "wsl_distro", "url", "username", "profile_name", "gateway_url", "gateway_key_file", "format"]) {
      if (item?.[id] !== undefined) $(id).value = item[id];
    }
    if (item) $("auth_method").value = item.has_password ? "password" : "token";
    else if (availableDistros.length) $("wsl_distro").value = availableDistros[0];
    $("environment").disabled = Boolean(item); $("wsl_distro").disabled = Boolean(item);
    $("profile_name").readOnly = Boolean(item?.last_sync?.profile_id);
    $("password").placeholder = item?.has_password ? "留空保留已保存的密码" : "输入 ARTEX 管理员密码";
    $("token").placeholder = item?.has_token ? "留空保留已保存的 JWT" : "粘贴 ARTEX JWT";
    $("store_password").checked = item ? item.has_password : true;
    environmentChanged(); authChanged(); $("editor").hidden = false;
    $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
    $("url").focus();
  }
  function values() {
    const result = {};
    for (const id of ["environment", "wsl_distro", "url", "username", "password", "token", "auth_method", "profile_name", "gateway_url", "gateway_key_file", "format"]) result[id] = $(id).value;
    if (result.environment !== "wsl") delete result.wsl_distro;
    result.store_password = $("store_password").checked;
    return result;
  }
  $("add").addEventListener("click", () => { notice(""); openEditor(); });
  $("cancel").addEventListener("click", () => { $("editor").hidden = true; $("password").value = ""; $("token").value = ""; });
  $("refresh").addEventListener("click", () => run(refresh));
  $("environment").addEventListener("change", environmentChanged);
  $("auth_method").addEventListener("change", authChanged);
  $("check").addEventListener("click", () => run(async () => showCheck(await api("check", values()))));
  function saveConnection() {
    if (!form.reportValidity()) return;
    void run(async () => {
      const result = await api("configure", values());
      $("password").value = ""; $("token").value = "";
      notice(result.message); $("editor").hidden = true;
      await refresh();
    });
  }
  $("save").addEventListener("click", saveConnection);
  form.addEventListener("submit", (event) => { event.preventDefault(); saveConnection(); });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") { event.preventDefault(); saveConnection(); }
  });
  // Re-use the public Magpie page protocol after bootstrap navigation so
  // the service's document follows the hosting window's theme.
  function paint(theme) {
    if (theme && typeof theme.dark === "boolean") document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
    if (embedded) for (const [key, token] of Object.entries({ bg: "bg", surface: "card", fg: "fg", "fg-2": "fg-2", border: "line", muted: "muted", accent: "accent", soft: "accent-soft", "accent-fg": "accent-fg", error: "red", warning: "amber", font: "font", code: "code" })) {
      if (typeof theme?.tokens?.[token] === "string") document.documentElement.style.setProperty(`--${key}`, theme.tokens[token]);
    }
    requestAnimationFrame(reportSize);
  }
  let sized = -1;
  function reportSize(force = false) {
    if (!embedded || parent === window) return;
    const height = Math.ceil(document.querySelector("main").getBoundingClientRect().height);
    if (force === true || height !== sized) { sized = height; parent.postMessage({ magpie: 1, method: "size", params: { height } }, "*"); }
  }
  if (embedded) {
    new ResizeObserver(reportSize).observe(document.querySelector("main"));
    // The native Details sheet animates while this frame navigates from
    // its bootstrap. Reannounce after that transition or a host reload.
    setInterval(() => { if (!document.hidden) reportSize(true); }, 2000);
  }
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.magpie !== 1) return;
    const message = event.data;
    if (message.event === "theme") paint(message.data);
    if (message.id === hello && message.result) paint(message.result);
  });
  if (parent !== window) { hello = 765431; parent.postMessage({ magpie: 1, id: hello, method: "hello" }, "*"); }
  void refresh().catch((error) => notice(error.message, "error"));
  void api("wsl").then(({ distros }) => {
    availableDistros = distros;
    $("distros").replaceChildren(...distros.map((name) => { const option = node("option"); option.value = name; return option; }));
    $("wsl-hint").textContent = distros.length ? `正在运行：${distros.join("、")}` : "未发现运行中的 WSL；请先启动 ARTEX 所在的发行版，也可手动填写名称。";
    if (!editing && !$("wsl_distro").value && distros.length) $("wsl_distro").value = distros[0];
  }).catch((error) => { $("wsl-hint").textContent = error.message; });
  setInterval(() => { if (!busy && !document.hidden) void refresh().catch(() => {}); }, 5000);
})();
