<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# Hooks 指南

hooks 是 Claude Code 的“事件触发自动化”机制。它允许你在某些时机自动做点事情，例如：

- 调工具前先检查风险
- 写完文件后自动格式化
- 提交前跑测试
- 结束前记录日志或上下文

如果你已经会 `slash commands` 和 `CLAUDE.md`，下一步最值得掌握的自动化能力通常就是 hooks。

---

## hooks 是什么

你可以把 hook 理解成一条规则：

1. 某个事件发生
2. 匹配某个工具或场景
3. 自动执行一个动作

这些动作可以是：

- shell command
- HTTP webhook
- prompt 型判断
- agent 型评估

hooks 最大的价值，是把“你本来每次都要手动做的检查”变成自动流程。

---

## 常见配置位置

- `~/.claude/settings.json`：用户级，对所有项目生效
- `.claude/settings.json`：项目级，适合团队共享
- `.claude/settings.local.json`：本地项目配置，不建议提交
- plugin 内的 `hooks/hooks.json`
- 某些 skill / subagent frontmatter 内的 component-scoped hooks

如果你是新手，建议先从用户级或项目级配置开始。

---

## 基本结构

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

### 关键字段说明

| 字段 | 作用 | 示例 |
|------|------|------|
| `hooks` | hook 顶层配置入口 | `{ "PreToolUse": [...] }` |
| `matcher` | 匹配工具名或模式 | `"Write"`、`"Edit|Write"`、`"*"` |
| `type` | hook 类型 | `"command"`、`"http"`、`"mcp_tool"`、`"prompt"`、`"agent"` |
| `command` | 执行的 shell 命令 | `"$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh"` |
| `timeout` | 超时秒数 | `30` |
| `once` | 每会话只跑一次 | `true` |

> **注意**：这些字段属于配置协议的一部分，不要为了中文化把它们翻掉。

---

## matcher 怎么用

| 形式 | 含义 | 例子 |
|------|------|------|
| 精确匹配 | 只匹配某个工具 | `"Write"` |
| 正则匹配 | 匹配多个工具 | `"Edit|Write"` |
| 全匹配 | 匹配全部工具 | `"*"` 或 `""` |
| MCP 工具模式 | 匹配 MCP 工具 | `"mcp__memory__.*"` |

如果你配的是 `InstructionsLoaded`，它还有几种常见 matcher 值：

| matcher 值 | 含义 |
|------------|------|
| `session_start` | 会话刚启动时加载的 instructions |
| `nested_traversal` | 向下遍历目录时加载的 instructions |
| `path_glob_match` | 通过 path glob 匹配加载的 instructions |

如果你不确定先配什么，最常见的起点是：

- `Bash`
- `Write`
- `Edit|Write`

---

## 五种 hook 类型

### 1. `command`（本地命令）

最常见的类型。适合：

- shell 校验
- 安全扫描
- 自动格式化
- 日志记录

```json
{
  "type": "command",
  "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/validate.py\"",
  "timeout": 60
}
```

### 2. `http`（HTTP 调用）

适合把事件发给 webhook 或外部系统。

```json
{
  "type": "http",
  "url": "https://example.com/hook"
}
```

常见用途：

- 通知系统
- 团队消息流
- 外部审计系统

### 3. `mcp_tool`（MCP 工具调用）

这是上游在 `v2.1.118` 明确补进来的 hook 类型，适合：

- 你已经把验证逻辑做成 MCP server
- 不想每次再绕一层 shell
- 希望 hook 直接调用 MCP tool

典型配置会直接指定：

- `server`
- `tool`

而不是本地 `command` 或远程 `url`。

### 4. `prompt`（提示词）

让模型根据 prompt 判断是否该继续，常见于：

- 任务完成检查
- 结束前质量判断
- prompt 合规性判断

### 5. `agent`（代理）

让 Claude 用独立 agent 做更复杂的评估，适合：

- 架构规则检查
- 多步验证
- 比较复杂的质量门禁

---

## 常见事件

当前最值得先掌握的事件：

| 事件 | 什么时候触发 | 最常见用途 |
|------|--------------|------------|
| `PreToolUse` | 工具执行前 | 校验、阻止、改输入 |
| `PostToolUse` | 工具执行后 | 验证、补上下文、记录 |
| `UserPromptSubmit` | 用户提交 prompt 时 | prompt 校验 |
| `Stop` / `SubagentStop` | Claude / subagent 结束时 | 完成度判断 |
| `SessionStart` / `SessionEnd` | 会话开始 / 结束 | 初始化、清理、日志 |

更完整的生态还包括：

- `PermissionRequest`
- `PermissionDenied`
- `PostToolUseFailure`
- `UserPromptExpansion`
- `PostToolBatch`
- `Notification`
- `TaskCreated`
- `TaskCompleted`
- `CwdChanged`
- `WorktreeCreate`
- `WorktreeRemove`

如果你是新手，不需要一上来把所有事件都学完。

> 截至 `v2.1.119`，上游已经明确写成 **28 个 hook 事件、5 种 hook 类型**。如果你还在参考旧资料里“25 个事件 / 4 种类型”的说法，优先以现在这版为准。

---

## 最实用的三个起步场景

### 场景 1：提交前跑测试

这是最容易感受到 hooks 价值的起点。

```bash
mkdir -p ~/.claude/hooks
cp 06-hooks/pre-commit.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/pre-commit.sh
```

常见配置思路：

- 监听 `PreToolUse`
- matcher 设为 `Bash`
- 在脚本里判断是否是 `git commit`

### 场景 2：写完文件自动格式化

适合在 `PostToolUse` + `Write|Edit` 场景下做代码格式化或轻量校验。

### 场景 3：安全扫描

适合在文件修改后，自动扫明显危险模式，例如 secrets、危险命令或敏感字符串。

---

## hook 的输入输出是怎么工作的

### 输入

hooks 通常通过 `stdin` 接收 JSON 输入。

### 输出

可以通过：

- exit code
- stdout JSON

把结果反馈回 Claude。

常见控制方式包括：

- `allow`
- `deny`
- `ask`
- `updatedInput`
- `additionalContext`

如果你只是在做简单 shell 检查，先把“成功返回 0，失败返回非 0”跑通就够了。

### 这轮上游同步后要特别注意什么

上游最近把一批示例 shell hooks 统一到了 **stdin JSON 协议**，并补了 **Windows Git Bash 兼容性**。

这意味着你现在更应该按这种方式理解示例脚本：

- 从 `stdin` 读 JSON 输入
- 用 `file_path`、`command`、`user_prompt` 这类字段取值
- 需要阻止或修改行为时，返回 Claude Code 认可的 stdout JSON

如果你还在按“第一个位置参数就是文件路径”来写，很容易和新版本示例脱节。

另外，`v2.1.119` 之后 PowerShell 侧的 auto-approve 行为也更接近 Bash 了。<br>
如果你在 Windows 上跑 Claude Code，这意味着权限模式的体验比以前更一致。

---

## 本目录示例脚本怎么用

| 文件 | 用途 | 适合什么时候先试 |
|------|------|------------------|
| `pre-commit.sh` | 提交前跑测试 | 第一个推荐示例 |
| `format-code.sh` | 自动格式化 | 写代码后自动收尾 |
| `security-scan.sh` | 安全扫描 | 团队规范较严格时 |
| `pre-tool-check.sh` | Bash 高风险命令预检查 | 想先拦截危险命令时 |
| `validate-prompt.sh` | prompt 校验 | 控制输入质量 |
| `log-bash.sh` | 记录命令使用 | 做审计或追踪 |
| `dependency-check.sh` | 依赖清单变更后做漏洞扫描 | 团队依赖治理较严格时 |
| `notify-team.sh` | 通知团队 | 配合外部消息系统 |
| `context-tracker.py` | 上下文追踪 | 调试长会话问题 |

---

## 关于 `auto-adapt-mode` 的更新

如果你之前看过旧资料，可能见过一种思路：

- 在 `PostToolUse` 里记录你批准过的命令
- 自动把这些批准“泛化”进本地权限配置

上游最近已经把这条路线下掉了，不再推荐继续使用旧的：

- `06-hooks/auto-adapt-mode.py`

新的建议方式是：

- 使用一次性脚本 `09-advanced-features/setup-auto-mode-permissions.py`
- 直接把一组更保守、更可控的权限规则写进 `~/.claude/settings.json`
- 再通过命令行参数按需放开 edits、tests、git writes、package installs、GitHub write 等能力

这样做的好处是：

- 不再依赖“边用边学你的批准”
- 配置更可预测
- 更适合团队分享和审阅
- 对中国用户来说，也更容易解释“当前到底开了哪些权限”

如果你在意 Auto Mode 但又没有 Team plan，优先看：

- [09-advanced-features/README.md](../09-advanced-features/README.md)

---

## hooks 配置里哪些绝对不能翻

- `hooks`
- `matcher`
- `type`
- `command`
- `timeout`
- 事件名，例如 `PreToolUse`
- JSON key
- 实际命令行片段

可以翻译：

- 注释
- 使用说明
- README 正文

不能翻译：

- 协议字段
- 事件名
- 命令

---

## 中国用户特别注意

### 1. shell 差异

很多示例默认更偏 Unix / macOS / Linux 风格。  
Windows 用户请先确认你当前用的是：

- PowerShell
- Git Bash
- WSL

### 2. 环境依赖

如果 hook 里调用：

- `python`
- `node`
- `uv`
- `npm`
- `pytest`

请先确认本机路径和环境变量，否则“配置看起来对，运行却没效果”非常常见。

如果你在 Windows 上用 Git Bash，这一点更重要。上游最近的脚本更新，核心目的之一就是避免脚本只在 macOS / Linux 上能跑。

### 3. 网络与代理

如果 hook 会发 HTTP 请求，记得考虑：

- 公司代理
- TLS 证书
- 外部服务可访问性

---

## debugging 和排错思路

如果 hook 没生效，优先按这个顺序排查：

1. 事件名是否正确
2. `matcher` 是否匹配到了目标工具
3. 路径是否正确
4. 脚本是否可执行
5. 脚本内部依赖是否存在
6. stdout / exit code 是否符合预期

如果 hook 触发了但效果不对，重点看：

- 命令是否真的执行成功
- 你的 hook 是否过重、太慢
- 是否在错误事件上绑定了错误的逻辑

---

## 最佳实践

- 从一个轻量 hook 开始，不要一口气加很多
- 优先做“高频、确定、低风险”的自动动作
- 不要让 hook 变成新的复杂系统
- 先让 hook 稳，再考虑把它放进 plugin
- 对中国用户来说，环境说明和 shell 差异提示非常重要

---

## 推荐下一步

- 想做自动触发的复用能力：看 [03-skills](../03-skills/)
- 想接入外部系统：看 [05-mcp](../05-mcp/)
- 想把一整套流程打包分发：看 [07-plugins](../07-plugins/)
