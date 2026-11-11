# Magpie Agent 详情与多客户端扩展

此补丁让一个社区插件声明多个原生客户端，并把设置放在各行的「详情 → 设置」内。它是尚未合入上游的兼容扩展，插件安装本身不会自动替换 Magpie 程序。

基准是官方 **v0.1.3603**，提交 **a1ba92ad8cd54480ac29fd97df4cc9c3d54b9019**。Windows 兼容构建的运行版本为 **v0.1.3603-dirty+artex-details.2**。`dirty` 对应修改过源码的构建，Magpie 原有更新器将其识别为源码构建，避免自动安装官方程序时丢失扩展。

## 行为

- `magpie.panels` 新增 `agent` 插槽，以 `agent` 指定原生 Agent ID。
- 只有指定 Agent 的详情中显示此面板。尚未接入时也能展开详情完成首次授权。
- 复用原有 iframe 沙箱、主题、选项、消息来源与页面能力校验，向面板提供 `context.agent: {id, name}`。
- 详情内使用原生的「设置」标签和背景，不叠加插件卡片和包名标题。
- 只有面板可用性变化才重绘 Agent，避免普通元数据刷新替换正在编辑的表单。
- 详情扩展和面板错误提示按需加载，保留同步创建 iframe 的原有流程，并通过现有脚本体积检查。
- `magpie.agentInstances` 指定插件用户目录中的 JSON 客户端清单，每个客户端复用同一个 Agent 模块，有独立 ID、配置文件、网关身份、可见模型及恢复记录。
- 基础 Agent 的详情面板自动应用到同一包声明的客户端，`context.agent.id` 为实际客户端 ID；插件据此只展示当前连接。
- 升级时通过一次性继承迁移旧共享连接的原生接入与模型可见性。断开单行只恢复该客户端，移除插件恢复全部客户端。
- 断开预览复制清单并重定位其路径，后台适配器在预览中不运行，避免改到真实 ARTEX 或桥接文件。

ARTEX 的清单只包含相对位置，不含授权信息：

```json
{
  "version": 1,
  "includeBase": false,
  "instances": [{
    "id": "artex-wsl-example",
    "name": "ARTEX · WSL · Example",
    "config": "instances/wsl-example/agent.json",
    "dir": "instances/wsl-example"
  }]
}
```

`includeBase` 为 false 时隐藏用于首次配置的基础行；Windows 本机已经配置时保留基础行。清单变化会触发原生 Agent 重载，不往插件安装目录写生成代码，也不增加插件安装记录。

ARTEX 插件只声明一个详情面板：

```json
{"magpie":{"panels":[
  {"slot":"agent","agent":"artex","title":"Connection","file":"page/agents.html"}
]}}
```

0.7 起没有 `agents` 页底后备面板。没有此扩展的宿主会忽略未知插槽，因此不会出现详情设置。开源发布应明确标注这一宿主要求；上游尚未接受此扩展。

## 从源码构建

在对应版本的 Magpie 源码目录核对补丁后应用：

```sh
git apply --check /path/to/magpie-agent-details.patch
git apply /path/to/magpie-agent-details.patch
```

按照上游构建说明使用 Go 1.26.8 或兼容工具链。Windows WebView2 构建无需 cgo，可以从 WSL 交叉编译。上游的 `make release-windows` 会生成 Windows 资源、内嵌控制台启动器和桌面程序。编译时限制并发，避免大型上游测试和浏览器同时占用过多内存。

该补丁沿用 Magpie 的 MIT 许可证，见 [MAGPIE-LICENSE](MAGPIE-LICENSE)。构建产物放在开发目录 `output/host/release`，不进入 npm 插件包。

## 验证范围

已完成 Windows 程序构建，插件的单项安装、本机与 WSL 模型同步、切换和恢复通过真实可执行程序及隔离 ARTEX API 验证。详情位置使用真实构建的 `/api/plugin-panels` 与内嵌资源检查，没有拦截脚本替换或伪造面板元数据。

具体检查、全量上游测试的限制和本机验收见 [VERIFICATION.md](VERIFICATION.md)。升级到未带补丁的官方程序会失去详情插槽。兼容宿主遵循 Magpie 对源码构建的更新规则；插件不改动用户保存的自动更新偏好。
