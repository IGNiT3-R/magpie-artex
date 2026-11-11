# 贡献指南

需要 Node.js 22+，无第三方 npm 依赖。首次开发可运行 `npm run hooks:install` 安装当前仓库的提交检查。开发后运行 `npm test`，暂存公开文件后运行 `npm run check:public`，再运行 `npm run check:package`。

## 产品边界

- 用户只安装一个插件，每个已配置的 Windows / WSL 客户端有独立原生 Agent 行。
- 新建 WSL 连接不得调用 magpie plugin add，不生成附加 Agent 插件。
- 首次授权和状态在 Agent 设置中，模型选择使用 ARTEX 与 Magpie 自身的控件。
- 设置只在 ARTEX 原生详情内显示，使用 Magpie 主题令牌；不得重新加入 Agents 页底面板或独立设置侧栏。明确说明宿主扩展要求，不声称该接口已获官方支持。

## 代码边界

- artex.agent.js 运行在 moejs，只声明原生 Agent 并转换官方 connect 输入；不能依赖 Node、Bun、文件系统或网络。
- index.mjs 只导出一个工厂。Magpie 会把每个导出函数都当作工厂。
- lib/plugin-runtime.mjs 读取各客户端自己的 agent.json。lib/native-instances.mjs 生成不含凭据的客户端清单；不能往已安装插件目录写生成文件。登录信息、模型选择、WSL 网关密钥和恢复记录必须独立。
- lib/catalog.mjs 通过 ARTEX API 同步可见模型；不得接管同名自有配置。清理旧条目前必须检查全部引用，未知即保留。ARTEX 的 DELETE 会重写引用，不能直接删除全部未勾选配置。当前 API 没有原子的“仅在无引用时删除”，预检查与删除之间并发新建绑定仍是上游 API 的限制。
- lib/registration.mjs 只负责旧版附加插件的迁移清理。通过 Magpie 官方命令处理其插件列表，保留其他插件与选项。新安装不得触发安装或清理命令。
- MAGPIE_DRY_PROVIDERS 是原生断开预览：必须在创建服务、监控和 API 请求之前返回，避免预览触碰真实 ARTEX。
- 页面保持 iframe 沙箱兼容。API 要求会话能力、合法 Host/Origin，不能把密码、JWT 或网关密钥返回前端。
- Windows → ARTEX 与 WSL → Magpie 是两个方向；保留显式 localhost、IPv6 和端口，不混用地址。
- WSL 只查询运行中的发行版；后台命令使用参数数组，Windows 隐藏窗口。
- 原配置和密钥留在 ARTEX 数据库，持久化 ID 和日志支持中断恢复。

## 验证

接口和网络改动应验证可观察行为、失败恢复、凭据隔离与实例隔离。使用临时 HOME 和模拟服务，不要求真实订阅或发送付费模型请求。

npm run test:magpie 接受官方 host.js 与 Bun。npm run test:agent 接受兼容 Magpie 程序和 Bun，在隔离配置中验证一项安装记录、多个原生 Agent、独立可见模型以及本机/WSL 接入与恢复。

compat 目录是尚未合入上游的 Magpie 扩展补丁。修改它时同时更新兼容说明，记录基准提交、重新构建程序和实际界面验证结果。构建产物放在 output，保持插件发布包只有一个插件。

开源仓库不得包含用户凭据、运行时目录、完整插件配置、截图、浏览器快照或开发者本机路径。请使用 Fixture-Ubuntu、fixture-* 凭据、保留测试域名和临时目录编写测试；不要把真实环境脱敏后仍可识别的 ID 固定到用例中。

`check:public` 读取 Git 暂存区，而不是仅检查工作区；被强制加入的输出、数据库、密钥文件及常见敏感格式也会被拒绝。公开目录白名单在 scripts/check-public.mjs 中维护。`check:package` 对 npm 实际打包后的解压内容重复检查。CI 使用固定 Gitleaks 版本、校验下载文件并扫描完整 Git 历史。扫描报告不得公开密钥值，不要为真实凭据添加忽略项。

发布前核对 README、CHANGELOG、包内容和许可证。兼容补丁保留上游 MIT 授权，不把编译后的宿主或本机验收记录加入仓库。漏洞请按 [SECURITY.md](SECURITY.md) 私密报告。
