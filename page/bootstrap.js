(async () => {
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    const configured = Number(options?.port);
    const port = Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : 3479;
    const service = magpie.service || `http://127.0.0.1:${port}/`;
    location.replace(`${service}#bootstrap=${encodeURIComponent(location.href)}`);
  } catch (error) {
    document.getElementById("message").textContent = `无法打开 ARTEX 连接管理：${error.message}。请重新打开此页面，或在插件选项中检查 port。`;
  }
})();
