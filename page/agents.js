(async () => {
  try {
    await magpie.ready;
    // A panel has no service URL in today's bridge. Never mistake a remote
    // viewer's loopback for the server's service; keep the official page
    // service proxy as the remote Web fallback.
    const origin = location.origin;
    const native = location.protocol === "wails:" || origin === "http://wails.localhost" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    if (!native) {
      document.getElementById("message").textContent = "当前 Magpie 版本没有为 Agent 扩展提供远程服务代理。首次授权请在运行 Magpie 的电脑上完成；之后可从远程使用原生 ARTEX 接入控件。";
      return;
    }
    const options = await magpie.options.get();
    const configured = Number(options?.port);
    const port = Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : 3479;
    const agent = magpie.context?.agent?.id || "artex";
    location.replace(`http://127.0.0.1:${port}/#agents&agent=${encodeURIComponent(agent)}&bootstrap=${encodeURIComponent(location.href)}`);
  } catch (error) {
    document.getElementById("message").textContent = `无法加载 ARTEX 连接设置：${error.message}。请在 Magpie 中重试此面板。`;
  }
})();
