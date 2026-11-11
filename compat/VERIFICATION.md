# 验证范围

宿主基准：Magpie v0.1.3603，提交 a1ba92ad8cd54480ac29fd97df4cc9c3d54b9019。

## 0.8.0 功能验证 — 2026-11-11

- 插件的 79 项原有 Node 测试通过，覆盖取消勾选、空目录、重新勾选保留参数、默认与引用保护、引用接口失败、删除响应丢失、实例隔离、localhost、凭据隔离及旧记录迁移。
- 回归检查证明：停用目录清理后取消勾选用例失败，停用宿主清单加载后原生 WSL 客户端用例失败；恢复实现后通过。
- 官方 Bun 宿主实际加载插件，验证本机与 WSL 使用独立模型和密钥、单独断开及设置服务启动。
- Windows 兼容程序的隔离集成通过：一个插件安装记录、两个原生 ARTEX Agent、独立的 picked-only 列表、旧目录清理、切换、断开和旧附加插件迁移。
- Go 的清单校验、桥接迁移、身份隔离、独立断开、插件移除恢复、预览路径隔离、已有 TestPlugged* 和详情面板 API 用例通过。相关包 internal/agentplug、internal/agent、internal/settings、internal/plugin、internal/gui 的 go vet -p 1 -tags nogui 通过。
- Windows amd64 桌面构建 v0.1.3603-dirty+artex-details.2 完成，包含生产资源和控制台启动器。
- 真实构建的 Chromium 验收通过：两个原生客户端各自显示详情设置，没有页底面板；表单沿用宿主字体且无横向溢出。使用真实 /api/agents/preview 生成断开预览后，真实桥接与隔离 ARTEX API 数据不变。
- 在单独的 WSL 部署上确认：localhost 地址保持不变；可见模型同步后无引用的历史目录被清理；所选默认模型与 ARTEX 实际默认模型一致；原有授权、恢复记录和其他插件保持完整。

功能验收未请求付费模型，也未创建或执行 ARTEX 任务。部署信息、运行时模型清单、浏览器访问令牌、截图及原始日志不作为公开验证材料提交。

公开版本另外加入暂存内容与 npm 真实解包检查、提交钩子及 Gitleaks 完整历史扫描；CI 配置见 [工作流](../.github/workflows/test.yml)。这些检查独立于宿主功能验证。

## 全量上游测试的限制

本次仅运行上述相关测试、vet、程序集成及界面验收，没有重新运行全部上游 Go / GUI 套件，不宣称全量上游测试通过。

此前运行 go test -p 2 -tags nogui ./... 时记录到：

- internal/agent 的四项 Aside* 写入拒绝测试在高权限 Linux 用户下未得到预期的权限拒绝。
- TestGrokInstalled 的模拟可执行文件返回 Invalid argument。
- internal/gateway 全包达到十分钟超时，最后运行 TestUnroutedProgressingUploadOutlastsMost/identity。

未在未修改的基准树上复跑这些失败，因此不将它们认定为已证明的上游基线问题。此前插件面板 WebKit 套件也有清空选项时的异步断言和旧 frame 移除失败；真实表单另行在实际构建中验收，不将整个 GUI 套件标为通过。

## 复现插件检查

~~~sh
npm test
npm run check:public
npm run check:package
npm run test:magpie -- --host /path/to/magpie/internal/plugin/host.js --bun /path/to/bun
npm run test:agent -- --magpie /path/to/compatible-magpie --bun /path/to/bun
~~~

check:public 需在 Git 仓库中先暂存公开文件。宿主和原生 Agent 集成使用隔离配置与模拟 ARTEX；兼容程序需要自行按 [构建说明](README.md) 准备。
