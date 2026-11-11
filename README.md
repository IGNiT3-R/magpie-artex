# Magpie ARTEX 插件

**安装一个插件，在 Magpie 接入 ARTEX，然后在 ARTEX 里选择模型。**

插件将 Magpie 的网关地址、密钥、可见模型和路由组适配成 ARTEX 的 LLM 配置。**只安装一个插件**，每个已配置的客户端显示为独立的原生 Agent，例如 **ARTEX · Windows**、**ARTEX · WSL · Ubuntu**。各行的接入、默认模型、可见模型和断开分别生效，连接设置位于各自的 **详情 → 设置**。

ARTEX 配置保存在数据库中，插件通过其现有管理 API 写入，无需修改 ARTEX 源码或直接连接数据库。Magpie 自动运行后台适配器，正常使用不需要手动启动命令。

> **当前兼容要求：** 原生多客户端和「详情 → 设置」需要应用本仓库附带的 [Magpie 兼容补丁](compat/README.md)，基于官方 v0.1.3603。该扩展尚未合入上游；直接安装到未打补丁的官方 Magpie，无法显示上述设置和独立客户端。插件不会自行替换 Magpie 程序。

## 安装和使用

1. 准备好上述兼容 Magpie 宿主。克隆或下载 [本仓库](https://github.com/IGNiT3-R/magpie-artex) 到固定目录，在 Magpie **插件 → 添加插件** 中填写整个目录路径。无需执行 npm install。本项目尚未发布到 npm。
2. 打开 **Agent → ARTEX → 详情 → 设置**。未接入的项目可能在「显示全部 Agent」中。点击「添加连接」，填写部署环境、服务地址和管理员登录信息。WSL 请选择运行 ARTEX 的发行版；默认地址为 **http://localhost:8787**。
3. 在对应环境的 **ARTEX** 行点击原生「接入」，或选择一个默认模型。该行可见的模型随后自动同步到对应的 ARTEX。可在任一 ARTEX 详情内点「添加其他连接」，配置另一环境。
4. 回到 ARTEX，在任务、会话、Agent 或 **系统 → LLM 配置** 中选择对应的 Magpie 模型或路由组。已打开的列表可能需要刷新一次。

用户名默认大写 ARTEX。保存密码可自动续期 JWT，也支持只保存 JWT。页面不会回显凭据；编辑时密码或 JWT 留空可沿用原值。

每个客户端有独立的 Magpie 模型筛选，包括「仅勾选模型可见」。ARTEX 自己创建的配置仍由用户管理；模型同步只管理本插件创建的条目。用户在 ARTEX 手动选择其他默认配置时，同步保留该选择；之后在 Magpie 显式切换模型，会更新并启用插件管理的默认配置。ARTEX 中绑定固定配置的任务、会话或 Agent 继续使用各自的配置。模型配置的思考、重试、流式和速率限制也保留用户在 ARTEX 中的设置。

## 设置位置与 Magpie 版本

设置只显示在 **ARTEX → 详情 → 设置** 内，表单使用 Magpie 提供的主题颜色、字体和边框。0.7 起移除 Agents 页底面板，没有独立的侧栏设置页，也不为其他 Agent 显示设置。

Magpie 官方 **v0.1.3603** 有「详情」展开区域，但没有插件详情插槽，也只接受每个插件声明一个 Agent。本版本需要带有 [Agent 详情与多客户端扩展补丁](compat/README.md) 的 Magpie 宿主。补丁以 v0.1.3603 为基准，提供 `magpie.agentInstances` 和详情面板；它是社区兼容改动，尚不是 Magpie 官方发布的接口。

普通插件安装不会自行替换 Magpie 程序。请先使用兼容宿主；未带补丁的官方程序不会显示独立 WSL 行及详情设置。开源发布应明确标注这一宿主要求，或等待上游支持该扩展。

此版本的扩展面板没有远程服务代理。因此首次授权需要从运行 Magpie 的电脑上的桌面窗口或本机浏览器完成。之后可通过远程 Magpie Web 使用原生接入和模型控件。

## 环境要求

- 支持 magpie.agent 和 magpie.panels 的新版 [Magpie](https://github.com/yetone/magpie)。Magpie 自行提供 Bun，界面使用无需另装 Node.js。
- 已启动并完成管理员初始化的 [ARTEX](https://github.com/Autumn-27/ARTEX)。
- Windows、Linux/macOS 本机，或从 Windows 访问运行中的 WSL 2。
- 开发和可选 CLI 需要 Node.js 22+。没有第三方 npm 依赖。

插件不安装或启动 ARTEX，也不创建扫描任务。它负责 LLM 接入、模型目录、默认模型和恢复；任务仍在 ARTEX 中操作。

## WSL 与地址

Windows 访问 ARTEX 默认使用 **localhost**，不会改写成 127.0.0.1。用户显式填写的 IPv4、IPv6、端口和路径同样保留。

另一个方向是 WSL 中的 ARTEX 访问 Windows Magpie：

- NAT：读取该发行版默认路由中的 Windows 主机地址，使用 Magpie 的 WSL 密钥，保留网关端口和路径前缀。
- mirrored：使用可用的回环网关地址。
- 只查询运行中的发行版，不主动启动停止的发行版。
- 网络结果短时缓存，WSL 重启后会重新探测。

无法自动识别时，可在连接高级设置中指定 **从 ARTEX 访问 Magpie 的网关地址** 和 **网关密钥文件**。Docker/远程部署也可以这样显式指定；容器网络不等同于 WSL 发行版网络。

插件自己的设置服务只监听 127.0.0.1:3479。它与 ARTEX 地址是两回事。端口冲突时，可在主插件选项中设置 {"port":3480}。

## 断开与升级

在某个 ARTEX 行断开，只恢复这个连接原先的默认配置。其他 Windows / WSL 连接继续工作。移除整个插件时，兼容宿主会断开它的全部客户端。用户后来在 ARTEX 中主动选择的其他默认配置会保留。

取消勾选模型后，插件会删除自己创建且未被引用的旧目录条目，避免 ARTEX 继续列出所有历史模型。重新勾选时会恢复保留的流式、思考等参数。插件会读取任务模型链、Agent 和会话的引用；仍为默认、存在引用、被改名或改了模型的条目会保留，原因显示在详情状态中。引用接口不可用时暂停清理。ARTEX 当前没有独立的“隐藏配置”接口，因此被保留的条目仍会出现在其选择器里；绑定固定配置的旧任务是否还能调用该模型取决于 Magpie 网关。

从 0.6–0.7 升级时，现有 WSL 连接自动拆成独立 Agent，沿用之前的可见模型、接入状态、授权文件和 ARTEX 恢复记录。只有已配置的环境会显示对应行；首次安装保留一个 ARTEX 入口用于添加连接。

从 0.2–0.5 升级时，后台使用 Magpie 官方命令清理旧版 WSL 附加插件记录。插件列表最终只保留一个本插件包，客户端行由这个包统一声明。

如果自动定位旧安装的 Magpie 程序失败，可在主插件选项指定 magpieExecutable 为官方程序的绝对路径。新安装和新增 WSL 连接不需要定位程序或执行插件注册。

## 数据与登录

数据在用户目录的 .config/magpie-artex：

- 根目录的 agent.json 是本机客户端的网关、默认模型和可见模型目录。
- 本机连接使用根目录的 config.json、state.json、status.json。
- WSL 连接使用 instances 下各自的 agent.json、config.json、state.json、status.json。
- agents.json 只包含客户端 ID、名称和桥接文件路径，供兼容宿主加载原生行，不含凭据。
- 旧版单独的 artex.agent.js 仅作迁移数据，不再生成或注册为附加插件。

配置文件以明文保存登录信息；请勿提交到 GitHub。状态和同步日志不回显密码、JWT 或网关密钥，但诊断信息仍可能含本机路径和模型名称。POSIX 使用 0600 创建文件，Windows 继承用户目录权限。隐私边界、提交保护和漏洞报告见 [SECURITY.md](SECURITY.md)。

## 开发与可选 CLI

正常界面使用无需这些命令。开发验证：

~~~sh
npm test
npm run check:public
npm run check:package
npm run test:magpie -- --host <Magpie internal/plugin/host.js> --bun <Bun>
npm run test:agent -- --magpie <Magpie executable> --bun <Bun>
~~~

可选 CLI 提供 setup、status、sync、watch、doctor 和 disconnect；用 node bin/magpie-artex.mjs --help 查看参数。WSL 使用 --wsl 发行版选择连接目录；每个命令只操作选定的客户端。省略 --wsl 时操作本机连接。

测试使用临时 HOME、模拟 ARTEX API 和隔离 Magpie 配置，不请求付费模型。真实程序验证包含单插件安装、本机/WSL 目录同步、模型选择、切换和恢复。`check:public` 检查 Git 暂存内容，修改后先暂存需公开的文件；`check:package` 检查实际生成并解压的包。可通过 `npm run hooks:install` 为当前仓库启用提交前检查。

MIT License。贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。
