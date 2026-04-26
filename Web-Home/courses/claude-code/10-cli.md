<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../resources/logos/claude-howto-logo-dark.svg">
  <img alt="Claude How To" src="../resources/logos/claude-howto-logo.svg">
</picture>

# CLI 指南

Claude Code 的 CLI 是最核心的使用入口。  
很多功能看起来像“对话式能力”，但真正要高效使用、做自动化、接入脚本或 CI/CD，最后都绕不开 CLI。

---

## 最常用的命令

| 命令 | 用途 |
|------|------|
| `claude` | 打开交互模式 |
| `claude "query"` | 带初始问题进入 REPL |
| `claude -p "query"` | print mode，一次执行后退出 |
| `claude -c` | 继续最近一次会话 |
| `claude -r "session"` | 恢复指定 session |
| `claude mcp` | 管理 MCP |
| `claude agents` | 查看 agents |
| `claude plugin` | 管理 plugins |
| `claude remote-control` | 启动远程控制 |
| `claude auth status` | 查看登录状态 |

如果你是新手，先熟悉 `claude`、`claude -p`、`claude -c`、`claude -r` 就已经很有价值。

---

## 交互模式 vs print mode

### 交互模式

适合：

- 连续问答
- 多轮上下文
- 现场探索
- 需要边改边聊

```bash
claude
claude "explain this project"
```

### print mode（输出模式）

适合：

- 一次性任务
- shell 脚本
- CI/CD
- 通过 pipe 处理输入
- 结构化输出

```bash
claude -p "what does this function do?"
cat error.log | claude -p "explain this error"
```

### 一个实用判断标准

- 你要连续来回对话：交互模式
- 你要“给一条明确任务，然后退出”：print mode

---

## 新手最该掌握的 flags

| flag | 用途 |
|------|------|
| `-p, --print` | 进入 print mode |
| `-c, --continue` | 继续最近一次会话 |
| `-r, --resume` | 恢复指定 session |
| `-n, --name` | 给 session 起名 |
| `-w, --worktree` | 在 worktree 中启动 |
| `--model` | 指定模型 |
| `--effort` | 指定思考强度；现在支持 `xhigh` |
| `--permission-mode` | 指定权限模式 |
| `--bare` | 以最小模式启动 |
| `--add-dir` | 加额外目录到工作上下文 |
| `--tmux` | 给 worktree / 多任务场景创建 tmux 会话 |
| `--exclude-dynamic-system-prompt-sections` | 排除系统提示中的动态段落，帮助 prompt cache 更稳定命中 |

---

## 一些真正常用的例子

### 查看项目

```bash
claude "explain this project"
```

### 处理日志

```bash
cat error.log | claude -p "explain this error"
```

### 继续最近一次工作

```bash
claude -c
```

### 恢复命名会话

```bash
claude -r "auth-refactor" "finish this task"
```

### 用于自动化

```bash
claude -p "Run tests and summarize failures" --permission-mode dontAsk
```

---

## 模型与配置

CLI 常见会和这些配置一起使用：

- `--model`
- `--fallback-model`
- `--effort`
- `--settings`
- `--append-system-prompt`

示例：

```bash
claude --model opus "design a caching strategy"
claude -p --fallback-model sonnet "summarize this diff"
claude --append-system-prompt "Always explain tradeoffs" "review this plan"
```

如果你要长期使用 Claude Code，把模型、权限、输出格式这些参数理解清楚，会直接影响效率和成本。

### 这轮 CLI / 平台更新里值得知道的变化

- Opus 主线已经切到 **Opus 4.7**
- `--effort` 新增 `xhigh`，并成为 Opus 4.7 的默认档位
- Windows 侧正在逐步拿到更专门的 PowerShell tool
- 主题里新增了更贴近终端外观的 Auto 模式
- 只读型 Bash / Glob 调用的权限提示比以前更安静

---

## 这轮 CLI 更新里，最值得你知道的一个新 flag

```bash
claude --tmux
```

它适合：

- 你已经开始频繁用 worktrees
- 想把多个任务分屏展示
- 想为更复杂的多终端协作留出界面空间

如果你还处在基础阶段，不必先学它；但当你开始并行做多条任务线时，它会很有用。

---

## 工具与权限相关 flags

下面这些参数非常重要，但也是最容易被误用的一组：

- `--permission-mode`
- `--dangerously-skip-permissions`
- `--allowedTools`
- `--disallowedTools`
- `--tools`

### 实用例子

```bash
# 只做只读分析
claude --permission-mode plan "review this codebase"

# 非交互测试摘要
claude -p "Run tests" --permission-mode dontAsk

# 限制工具范围
claude -p --tools "Read,Grep,Glob" "find all TODO comments"
```

---

## 输出与格式

如果你要把 Claude Code 接进脚本或程序，最值得关注的是：

- `--output-format`
- `--json-schema`
- `--include-partial-messages`

### 常见使用方式

```bash
# 默认文本输出
claude -p "explain this code"

# JSON 输出
claude -p --output-format json "list all functions in main.py"

# 用 schema 约束结构
claude -p --json-schema '{"type":"object"}' "return structured analysis"
```

如果你的下游还要接 `jq`、Python、Node 或 CI job，结构化输出会非常有用。

---

## workspace 与多目录

如果你需要让 Claude 同时看多个目录，可以用：

```bash
claude --add-dir ../frontend ../backend ../shared "find all API endpoints"
```

这对 monorepo、前后端分仓或跨目录排查问题特别有帮助。

---

## MCP 与 plugin 相关 CLI

你不只会在文档里看到：

- `claude mcp`
- `claude mcp serve`
- `claude plugin`

你实际使用中也经常会碰到它们。

### 典型场景

```bash
claude mcp
claude mcp serve
claude plugin install my-plugin
```

如果你要做自动化、集成第三方系统或团队分发，这些命令迟早会用到。

---

## session 管理

当你开始做稍复杂的工作后，session 管理会非常重要。

常见场景：

- 延续昨天的任务
- 给当前任务起名
- 从当前会话分叉出实验方案

常用命令和 flags：

- `/resume`
- `/rename`
- `/branch`（较新的主名称，部分环境里 `/fork` 仍可能作为兼容别名出现）
- `/fork`
- `claude -c`
- `claude -r`

不命名 session，前期感觉没问题，后期会越来越难管理。

---

## CLI 和自动化的关系

当你要做这些事情时，CLI 会变得尤其重要：

- CI/CD
- shell 脚本
- 批处理
- JSON 输出
- 定时任务
- 后台任务编排

很多“高级能力”最后都会落回 CLI 参数和脚本调用层。

所以如果你真想把 Claude Code 用深，CLI 不是可选项，而是核心能力。

---

## 哪些内容绝对不能翻

如果你在本地化文档，这些内容必须保持英文原样：

- `claude`
- `claude -p`
- flags，例如 `--model`、`--permission-mode`
- 子命令，例如 `claude mcp`、`claude plugin`
- 输出格式名，例如 `json`

CLI 是最典型的“说明文本可以翻，命令本身不能翻”的内容。

---

## 中国用户特别注意

### 1. 网络环境

如果你在公司网络、代理或受控环境下使用 CLI，先确认：

- API 访问
- GitHub 连通性
- npm / uv / Python 依赖下载
- 证书与代理设置

### 2. Windows / WSL 差异

Windows 用户建议尽早确认自己使用的是：

- PowerShell
- Git Bash
- WSL

这会直接影响路径、命令行为和脚本兼容性。

### 3. 自动化不要一开始就开太猛

建议从这些低风险任务开始：

- 日志解释
- 测试摘要
- 结构化分析

不要一开始就上高权限全自动修改流程。

---

## 常见坑

### 1. 把 print mode 当普通聊天

`claude -p` 更适合一次性、明确输入输出的任务。

### 2. 不给 session 命名

短期还行，任务一多就会混乱。

### 3. 翻译 CLI flags

这会让用户复制命令后直接失败。

### 4. 没区分“能跑”和“适合自动化”

某个命令能跑，不代表它就适合直接放进 CI/CD。

---

## 故障排查

如果 CLI 行为不符合预期，优先排查：

1. 当前是不是该用交互模式，而不是 print mode
2. flags 是否拼对
3. 权限模式是否合适
4. 环境变量是否已导出
5. 当前 shell / 路径环境是否匹配

---

## 最佳实践

- 先熟练 `claude`、`claude -p`、`claude -c`、`claude -r`
- 自动化从小任务开始
- 所有 CLI 示例都保留英文原样
- 把 session 命名当成好习惯
- 中国用户优先排除网络与 shell 环境问题

---

## 推荐下一步

- 想更系统地看高级能力：看 [09-advanced-features](../09-advanced-features/)
- 想查安装与路径：看 [QUICK_REFERENCE.md](../QUICK_REFERENCE.md)
- 想结合 hooks / MCP / plugins：回看 [06-hooks](../06-hooks/)、[05-mcp](../05-mcp/)、[07-plugins](../07-plugins/)
