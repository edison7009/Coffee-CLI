<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# MCP 指南

MCP（Model Context Protocol）是 Claude Code 用来接入外部工具、服务和实时数据的协议。你可以把它理解成：Claude 不只是“聊天”，而是真的能通过标准接口去访问 GitHub、数据库、文件系统等外部能力。

---

## MCP 解决什么问题

如果没有 MCP，Claude 只能基于你提供的上下文回答。  
有了 MCP，它可以：

- 获取实时数据
- 调用外部工具
- 访问项目外的信息源
- 把结果带回当前工作流

和 memory 的区别很简单：

- memory 适合长期稳定规则
- MCP 适合实时、外部、动态数据

---

## MCP 常见应用场景

- GitHub PR / issue 查询
- 数据库读写
- 文件系统访问
- Slack / Docs / 其他 SaaS 工具集成

---

## 本目录里的示例配置

| 文件 | 用途 |
|------|------|
| `github-mcp.json` | GitHub MCP 配置 |
| `database-mcp.json` | 数据库 MCP 配置 |
| `filesystem-mcp.json` | 文件系统 MCP 配置 |
| `multi-mcp.json` | 多个 MCP server 组合示例 |

---

## MCP Apps 是什么

这是上游 2026 年 4 月文档里新增强调的一点。

你可以把 **MCP Apps** 理解成：  
MCP server 不再只能返回纯文本，也可以在聊天界面里直接返回带交互的 UI 组件。

这意味着 MCP 的返回结果可以更像：

- 仪表盘
- 表单
- 数据可视化
- 多步骤工作流界面

对中国小白来说，一个简单理解是：  
**MCP 不只是“让 Claude 调工具”，还可以把结果做成界面直接塞回聊天里。**

---

## 最常见的安装方式

### HTTP transport（HTTP 传输）

```bash
claude mcp add --transport http notion https://mcp.notion.com/mcp
```

### stdio transport（stdio 传输）

```bash
claude mcp add --transport stdio myserver -- npx @myorg/mcp-server
```

---

## 直接复制示例配置

如果你只想先试 GitHub MCP：

```bash
export GITHUB_TOKEN="your_token"
cp 05-mcp/github-mcp.json .mcp.json
```

如果你想一次挂多个服务：

```bash
cp 05-mcp/multi-mcp.json .mcp.json
```

---

## 哪些内容不能翻

MCP 配置是高风险文件，以下内容默认不要翻：

- `mcpServers`
- server 名称，例如 `github`
- `command`
- `args`
- `env`
- 环境变量名，例如 `GITHUB_TOKEN`

正文解释可以中文化，但 JSON key 和 server 名称不要改。

---

## 中国用户特别注意

目前中文主线和上游同步时，优先保留官方文档里最常见、最稳定的 `http` / `stdio` 配置路径。看到旧教程还在强调 `WebSocket transport` 时，优先以当前官方 MCP 文档为准。

### 1. 网络和代理

很多 MCP server 依赖：

- `npx`
- 外部 API
- GitHub 或第三方服务

如果你在中国网络环境下第一次执行慢、失败、超时，优先检查：

- 代理设置
- npm registry / Node 环境
- GitHub 访问
- 证书与公司网络策略

### 2. Token 和权限

例如 GitHub MCP 最常见的失败原因是：

- `GITHUB_TOKEN` 没设置
- token scope 不够
- 环境变量只在一个 shell 会话里设置了

### 3. Windows / WSL 差异

如果你在原生 Windows 上运行 `npx` MCP server，有时需要参考官方建议用 `cmd /c` 风格处理。

---

## memory 和 MCP 怎么选

### 用 memory

- 项目规则
- 团队约定
- 长期稳定背景信息

### 用 MCP

- GitHub / 数据库 / 文件系统 / 第三方平台
- 需要实时查询
- 需要读写工具结果

---

## 常见坑

### 1. 把 JSON 配置翻译掉

这会直接导致 MCP 无法加载。

### 2. 忘记导出环境变量

配置文件写对了，Claude 也会因为 token 缺失而连不上。

### 3. 一上来就接很多服务

推荐先接最核心的一个，例如 GitHub 或 filesystem，确认跑通后再扩展。

---

## 推荐下一步

- 想让 Claude 自动在关键时机跑脚本：看 [06-hooks](../06-hooks/)
- 想把 MCP 和 commands / agents 一起打包：看 [07-plugins](../07-plugins/)
- 想快速查常见配置：看 [QUICK_REFERENCE.md](../QUICK_REFERENCE.md)
