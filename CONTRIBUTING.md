# 贡献指南

需要 Node.js 22+，无第三方 npm 依赖。开发后运行 `npm test`，暂存公开文件后运行 `npm run check:public`，再运行 `npm run check:package`。首次开发可运行 `npm run hooks:install`。

## 产品边界

- 官方原版 Magpie 必须可用，只安装一个插件；不得把私有宿主补丁当作安装前提。
- 通过官方 magpie.agent 提供一条原生 ARTEX 行，模型选择和可见性使用 Magpie 原生控件。所有启用连接共享该选择。
- 本机与每个 WSL 连接分别保存授权、地址、暂停状态及恢复记录；设置在官方 settings 插槽，继承 Magpie 主题。不得增加侧栏管理页、Agents 页底面板或额外插件记录。
- 不宣称拥有类似内置 Codex 的独立原生环境行或原生详情设置；社区插件 API 尚未提供这两项接口。

## 代码边界

- artex.agent.js 在 moejs 中运行，只声明 Agent 并转换 connect 输入，不使用 Node、Bun、文件系统或网络。
- index.mjs 只导出一个工厂；Magpie 把每个导出函数都当作工厂。
- lib/plugin-runtime.mjs 的工作进程共读根 agent.json，分别写客户端目录。lib/official-agent.mjs 负责一次性桥接和可见性迁移，保留其他 Agent 偏好及所有授权、恢复记录。
- 普通模型/可见性变化不能触发插件注册命令。lib/registration.mjs 仅用官方命令完成旧安装清理和一次性原生接入迁移。
- 共享模式下的单连接 disconnect 必须只暂停该连接，不能清空共享桥接。原生整行断开通过桥接变化恢复全部启用连接。
- 目录清理前检查任务、Agent、会话引用。未知即保留；ARTEX DELETE 会重写引用，禁止直接删除全部未勾选项。预检查与删除之间并发新增绑定是上游 API 的限制。
- 保留 ARTEX 中用户主动选择的默认配置及模型参数，直到明确的 Magpie 模型变更。
- MAGPIE_DRY_PROVIDERS 是原生断开预览，必须在创建服务、监控和 API 请求之前返回。
- 页面 API 校验会话能力、Host/Origin，不向前端返回密码、JWT 或网关密钥。远程浏览器不能误连自己的回环地址。
- Windows 到 ARTEX 与 WSL 到 Magpie 是两个方向；保留显式 localhost、IPv6、端口和路径。只探测运行中的 WSL，后台命令使用参数数组并隐藏 Windows 窗口。

## 验证与发布

接口改动验证外部行为、失败恢复、凭据及实例隔离。使用临时 HOME、模拟 ARTEX 和虚构凭据，不要求真实订阅或发送付费推理。

`npm run test:magpie` 使用官方 host.js 与 Bun；`npm run test:agent` 必须使用未修改的官方程序，拒绝 artex-details 兼容构建。界面检查使用官方程序的真实页面和插件面板，不伪造宿主接口。

compat 是 0.8 的历史方案，不进入当前 npm 包。构建产物、运行配置、数据库、日志、截图、浏览器快照和开发机路径不进入仓库。测试使用临时目录、Fixture-Ubuntu、fixture-* 凭据及保留测试域名。

`check:public` 检查暂存区的实际 Git blob；`check:package` 检查真实 npm 解包内容。CI 使用固定版本和 SHA-256 校验的 Gitleaks 扫描完整历史，报告不回显密钥。不得给真实凭据添加忽略项。漏洞按 [SECURITY.md](SECURITY.md) 私密报告。
