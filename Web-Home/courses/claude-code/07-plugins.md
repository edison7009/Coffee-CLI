<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# Plugins 指南

如果说 skills、hooks、MCP、subagents 分别是单项能力，那么 plugins 就是把这些能力打包成“一整套可安装方案”的方式。

对中国用户来说，plugin 章节之所以重要，不只是因为它“高级”，而是因为它最接近团队实际使用场景：一套命令、一套 agents、一套 hooks、一套外部集成，最好一次装好、一次分发。

---

## plugin 是什么

plugin 通常会组合这些内容：

- commands
- skills
- subagents
- hooks
- `.mcp.json`
- 辅助脚本与模板

所以它特别适合：

- 团队统一工作流
- 跨项目复用
- 把一套最佳实践做成可分发单元

---

## plugin 的价值到底在哪里

当你已经有很多零散配置时，plugin 解决的是：

- 怎么一次装完整套能力
- 怎么让团队成员拿到一致配置
- 怎么让“个人技巧”变成“团队资产”

如果你已经有单独的 slash command、skill、subagent、hook 在工作，那么下一步自然就是考虑是否要把它们打包。

---

## 基本结构

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
├── agents/
├── skills/
├── hooks/
├── .mcp.json
├── scripts/
├── templates/
└── docs/
```

### 这些目录分别做什么

| 目录 | 用途 |
|------|------|
| `.claude-plugin/plugin.json` | plugin manifest |
| `commands/` | 可直接调用的命令入口 |
| `agents/` | 子代理定义 |
| `skills/` | 自动触发或复用能力 |
| `hooks/` | 自动化事件处理 |
| `.mcp.json` | 外部系统接入 |
| `scripts/` | 实际执行脚本 |
| `templates/` | 输出模板 |

---

## manifest 结构与高风险字段

plugin manifest 采用 JSON 格式，位置是：

```text
.claude-plugin/plugin.json
```

一个最小示例：

```json
{
  "name": "my-first-plugin",
  "description": "A greeting plugin",
  "version": "1.0.0",
  "author": {
    "name": "Your Name"
  },
  "license": "MIT"
}
```

### 这些 key 不要翻

- `name`
- `version`
- `description`
- `author`
- `license`

同样，plugin 名称本身也不要改成中文标识，否则会影响识别、安装和后续同步维护。

---

## plugin 还有哪些可选能力

### 1. LSP 支持

plugin 可以通过 `.lsp.json` 或 manifest 中的 `lsp` 配置提供 LSP 支持。

适合：

- 语言诊断
- 跳转定义
- symbol 浏览
- hover 信息

### 2. 用户配置项

某些 plugin 会暴露用户可配置项，例如 API key、部署 region、开关参数。

### 3. 持久化数据

某些 plugin 会使用持久化目录存储缓存、数据库或状态。

如果你在做团队级 plugin，这三类能力很值得提前规划。

---

## 本目录里的示例 plugins

| plugin | 用途 | 适合谁 |
|--------|------|--------|
| `pr-review` | PR 审查流程 | 代码审查较频繁的团队 |
| `documentation` | 文档生成与同步 | 文档经常落后的项目 |
| `devops-automation` | 部署、监控、事故处理 | 有稳定交付流程的团队 |

### `pr-review`

把安全检查、测试覆盖检查和性能影响分析整合进 PR 工作流。

### `documentation`

把 README、API docs、文档同步和校验整理成一套文档工作流。

### `devops-automation`

把部署、回滚、状态检查和 incident 响应整合起来。

---

## 怎么安装

### Marketplace / 已发布 plugin

```text
/plugin install pr-review
```

### 本地开发 plugin

如果你是在本地调试自己写的 plugin，一般会使用 Claude Code 支持的本地 plugin 目录或测试方式。

### 从 Git 仓库安装

如果以后你把中文 plugin 发布到自己的仓库，建议在 README 中明确写出：

- 仓库地址
- 安装方式
- 依赖条件
- 支持平台

---

## 什么时候值得做 plugin

### 值得做 plugin

- 你已经有多项能力要一起分发
- 团队成员都要用
- 安装过程需要足够简单
- 你希望工作流版本化

### 先别急着做 plugin

- 你还只有一个 command 或 skill
- 工作流还没稳定
- 需求变化很快

这时通常先用单独的 skills、hooks 或 agents 更合适。

---

## 设计一个好 plugin 的建议

### 1. 先确定“解决哪个完整场景”

不要只是把几个文件塞一起。好的 plugin 通常对应一个完整场景，例如：

- 代码审查
- 文档维护
- 部署与事故处理

### 2. 明确依赖边界

需要写清楚：

- 外部服务依赖
- 必要的 token / env vars
- 所需 CLI
- 权限需求

### 3. 不要把实验性配置过早打包

plugin 一旦面向团队分发，稳定性要求就会更高。

---

## 中国用户特别注意

### 1. 外部服务依赖

plugin 里经常带有：

- GitHub
- Kubernetes
- 第三方 API
- 网络 webhook

不要默认这些服务在本地就能直接访问。

### 2. token / CLI / 环境变量

发布中文 plugin 时，建议 README 明确说明：

- 依赖哪些外部服务
- 需要哪些 token / CLI / 环境变量
- Windows / WSL 是否支持

### 3. 安装方式别写得太抽象

中国用户最怕“概念都懂，但不知道下一步打什么命令”。  
建议每个 plugin 至少给一个“最小安装路径”。

---

## Background Monitors（后台监控）

上游在 v2.1.105 把 plugin 的 background monitors 说明得更清楚了。你可以把它理解成：

- plugin 启动后自动挂一个后台观察器
- 它盯住某个命令的 stdout
- 一旦有事件发生，Claude 就能及时反应，而不是傻等轮询

manifest 顶层可以加一个 `monitors` 字段，例如：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "monitors": [
    {
      "command": "tail -f /var/log/app.log",
      "trigger": "session_start"
    }
  ]
}
```

`trigger` 目前常见有两类：

- `session_start`：会话启动时自动挂起监控
- `skill_invoke`：调用 plugin skill 时再挂起监控

对中国用户来说，一个实用理解是：<br>
**如果你的 plugin 需要持续盯日志、长任务输出或外部事件流，这一层会比手写轮询更自然。**

---

## Marketplace 管控和 plugin tag

这轮上游在 plugins 侧还补了两类更偏“团队治理”的能力：

### 1. marketplace 管控更严格了

除了原本的 `strictKnownMarketplaces`，现在还要注意：

- `blockedMarketplaces`
- `hostPattern`
- `pathPattern`

这意味着团队可以更细粒度地限制：

- 哪些 marketplace 根本不能装
- 哪些 host / path 模式直接拦掉

如果你只是个人用户，这一块可以先知道它存在；<br>
如果你要在团队里推广插件，这些策略迟早会碰到。

### 2. `claude plugin tag`（插件发布打标）

上游在 `v2.1.118` 明确增加了：

```bash
claude plugin tag v0.3.0
```

它的价值在于：

- 帮你校验版本号
- 顺手创建对应 git tag
- 更适合拿来做 plugin 发布流程

如果你未来要把自己的 plugin 真正分发出去，这会比手敲 tag 更稳一点。

### marketplace update 和 plugin update 不是一回事

这次上游还把一个很容易混淆的点写清楚了：

```bash
claude plugin marketplace update [name]
claude plugin update <name>
```

两者区别是：

- `marketplace update`：刷新 marketplace 目录，更新“现在有哪些插件可安装”
- `plugin update`：更新你本机已经安装的某个 plugin

对中国用户来说，一个简单判断方法是：

- 你是在更新“插件市场目录”？
- 还是在更新“自己已经装过的插件”？

别把这两个动作混在一起。

### Auto-Update（自动更新）

上游也补了 marketplace / plugin 自动更新机制：

- 官方 marketplace 默认更偏自动更新
- 第三方 / 本地 marketplace 默认更保守

如果你想整体关闭自动更新：

```bash
export DISABLE_AUTOUPDATER=1
```

如果你想保留 plugin 自动更新、但不想让 Claude Code 本体自动更新：

```bash
export DISABLE_AUTOUPDATER=1
export FORCE_AUTOUPDATE_PLUGINS=1
```

这个设置对团队环境特别重要，因为很多人以为“只是在关主程序更新”，实际上也可能顺手把 plugin 自动更新关掉。

## 常见坑

### 1. 只改 README，不检查 manifest

真正影响安装和识别的是 `.claude-plugin/plugin.json`，不是说明文。

### 2. 过早打包

如果工作流还不稳定，plugin 只会增加维护负担。

### 3. 把 plugin 名和命令名翻译掉

这会直接影响调用、安装和同步维护。

### 4. 没写清依赖

对中国用户来说，这是导致“看起来很强但根本跑不起来”的高频原因。

---

## 故障排查

如果 plugin 装了但不好用，优先排查：

1. manifest 是否有效
2. 依赖的 commands / agents / hooks / MCP 是否都在正确目录
3. 外部服务是否能访问
4. 环境变量是否正确导出
5. 插件命名空间和命令名是否保持英文原样

---

## 最佳实践

- 先跑通单项能力，再打包
- 保持 plugin 目标聚焦
- 在 README 中明确依赖和适用场景
- 不要为了中文化改坏 manifest 和命令标识
- 团队发布前先做一轮真实安装演练

---

## 推荐下一步

- 想先理解单项能力：回看 [03-skills](../03-skills/)、[04-subagents](../04-subagents/)、[05-mcp](../05-mcp/)、[06-hooks](../06-hooks/)
- 想补高级工作流与权限控制：看 [09-advanced-features](../09-advanced-features/)
