# Coffee-CLI 多 Agent 协作架构设计

> 本文档是"北极星文档"——未来任何 session 讨论多 Agent 功能时，先读本文档再开工。
>
> 起稿：2026-04-22
> 状态：**决策完成 + 细节筹备就绪**。开工前先跑完 [附录 C 验证清单](#附录-c开发前必须验证清单1-2-天内完成)
> 分支：`feature/multi-agent-v1`
> 作者决策背景：Claude Opus 4.7 session, 2026-04-22

---

## 一、文档目的

定义 Coffee-CLI 多 Agent 协作功能的：
- 产品定位（永不偏移的北极星）
- 技术路线（做什么 + **不做什么**）
- 范围边界（避免下次聊着聊着又滑向 agent 编排器）
- MVP 实施顺序

本文档存在的原因：**防止多轮 AI 对话中目标漂移**。任何改动产品方向的提议，需先改本文档。

---

## 二、产品定位（北极星）

> **Coffee-CLI 是"跨 CLI 进程的桥梁"**
>
> 不做 Agent 编排器、不做任务 DAG、不做心跳调度、不做容器化沙箱，**也不做同家 CLI 内部的 subagent 编排**。

核心卖点一句话：

> **"你的 Claude Code 可以看到并指挥 Codex 和 Gemini，全程在你眼前发生。"**

市场独特性（竞品都做不了）：
- Opcode/Warp/Superset：有多 Agent，但**用户看不到被控过程**
- Claude Agent Teams / claude-squad / conductor-mcp：**在 Windows 不能用**（依赖 tmux）
- LangGraph/Mastra：**要写 DAG 代码**，用户学习成本高
- Claude subagent：**过程对用户黑盒**，无法干预

**Coffee-CLI 独占位**：Windows 原生 + 用户可见 + 用户可干预 + 异构 CLI 组合（Claude + Codex + Gemini 真并存）。

### 职责边界：同家编排 vs 跨家编排

4 家主控 CLI 都有**自家 subagent SDK**，这些**我们不介入**：

| 场景 | 谁来处理 |
|---|---|
| Claude Code 内部开多个 subagent | Claude Code 自己（[Agent Teams](https://code.claude.com/docs/en/agent-teams)） |
| Codex 内部 rescue / 子任务 | Codex 自己（app-server / [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)） |
| Gemini 内部 agent 分身 | Gemini 自己（Gemini agent framework） |
| OpenCode 内部 subagent + 跨 provider | OpenCode 自己（[TaskTool + Oh My OpenAgent](https://opencode.ai/docs/agents/)） |
| **跨进程协同**（Claude 进程指挥 Codex 进程） | ✅ **Coffee-CLI 专属** |

**结论**：Coffee-CLI 只做跨 CLI 进程桥梁。同家并行交给各家原生 SDK（它们更懂自己）。这让我们的 3 工具职责更窄、定位更稳。

---

## 三、核心设计哲学：透明编排容器

**编排权归主控格（primary pane）里的 LLM，Coffee-CLI 只提供通信原语和可视化。**

三条原则：

1. **LLM 是编排者**
   多步决策（Gemini 做完要不要转给 Codex）由主控格 LLM 临时决定，Coffee-CLI 不预定义 DAG。

2. **用户全程可见可接管**
   四个 pane 的 PTY 输出流式可见，用户可点任意格子直接接管对话。

3. **通信原语最小化**
   只有 3 个 MCP 工具：`list_panes` / `send_to_pane` / `read_pane`。一切更复杂的模式（并行派发、汇总、重试、跨 Agent 对话）由主控 LLM 靠提示工程实现，不做到底层。

---

## 四、被否决的方向（永不要再提，除非推翻本文档）

| 方向 | 否决理由 |
|---|---|
| **DAG 编排层**（mailbox / signal / wait_for_channel） | 滑向 Mastra/LangGraph，和巨头正面竞争打不过 |
| **Agent 身份识别协议** | 不做跨 Agent 对话，只做单向指令注入，不需要 sender tag |
| **异步 `[SUBMITTED]` mailbox 语义** | 已砍：`send_to_pane(wait=true)` 内部轮询就够，长任务走 `wait=false + read_pane` |
| **Pane 布局 DSL**（CCB 的 `agent1:codex; agent2:claude`） | 固定四宫格 + 可滚动加格子足够，不做复杂布局语义 |
| **Safety tier 三档**（readonly/mutating/destructive） | 3 个工具不值得搞分层 |
| **Workstation 模式** | 已在 [project_product_positioning.md](../../../../Users/eben/.claude/projects/d--Coffee-CLI/memory/project_product_positioning.md) 砍掉，tag `archive/workstation-mode` |
| **容器化隔离 / git worktree** | Superset/claude-squad 做了，Coffee-CLI 不做——定位是"美化载体"不是"隔离沙箱" |
| **Agent 心跳 / heartbeat** | 不做进程健康监控，PTY 挂了就挂了，用户重启 |

---

## 五、技术架构

### 5.1 系统总览

```
┌─ Coffee-CLI (Tauri v2 + Rust + xterm.js) ──────────────────────────┐
│                                                                    │
│  ┌─ Pane Grid（UI 层）──────────────────────────────┐             │
│  │  起步 2×2，可向下滚动扩展（6/8/12 格随意）         │             │
│  │  每格 = 独立 portable-pty 子进程（Windows 原生）   │             │
│  │  每格启动时注入 env:                               │             │
│  │    COFFEE_PANE_ID=N                                │             │
│  │    COFFEE_PANE_ROLE=primary|worker                 │             │
│  └────────────────────────────────────────────────────┘             │
│                        ↕                                            │
│  ┌─ Coffee MCP Server（Rust，rmcp crate）──────────┐               │
│  │  传输：stdio（默认）/ Streamable HTTP（可选）      │               │
│  │  工具（仅 3 个）：                                 │               │
│  │    list_panes() → [{id, title, cli, state}]       │               │
│  │    send_to_pane(id, text, timeout_sec, wait)       │               │
│  │                → {status, output}                  │               │
│  │    read_pane(id, last_n_lines)                     │               │
│  │                → {output, is_idle}                 │               │
│  └────────────────────────────────────────────────────┘             │
│                        ↕                                            │
│  ┌─ 主控格（primary pane，用户指定）────────────────┐               │
│  │  Claude Code / Codex / Gemini CLI / OpenCode       │               │
│  │  通过各自 mcp.json 配置接入 Coffee MCP             │               │
│  └────────────────────────────────────────────────────┘             │
│                                                                    │
│  ┌─ 协议注入文件（项目根自动写入）─────────────────┐                │
│  │  CLAUDE.md   ← Claude Code 读取                    │                │
│  │  AGENTS.md   ← Codex/OpenCode/Amp 读取             │                │
│  │  GEMINI.md   ← Gemini CLI 读取                     │                │
│  │  (三文件内容一致，告诉主控 LLM 如何使用 3 工具)    │                │
│  └────────────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 MCP 工具 API（最终定稿，3 个）

**`list_panes()`**
```
输入: 无
输出: [{
  id: string,           // "pane-1" / "pane-2" ...
  title: string,        // 用户给的标签
  cli: string,          // "claude" / "codex" / "gemini" / ...
  state: string,        // "idle" | "busy" | "terminated"
  last_activity_at: ISO timestamp
}]
```

**`send_to_pane(id, text, timeout_sec=60, wait=true)`**
```
输入:
  id: string            // 目标 pane id（不能是调用者自己）
  text: string          // 要输入的文本
  timeout_sec: int      // 默认 60，范围 1-3600
  wait: bool            // true=阻塞轮询直到 idle 或超时; false=立即返回

输出 (wait=true):
  {
    status: "completed" | "timeout" | "failed",
    output: string,     // pane 从发送后到 idle 的全部输出
    duration_ms: int
  }

输出 (wait=false):
  {
    status: "submitted",
    job_id: string,     // 后续用 read_pane 查进度
    sent_at: ISO timestamp
  }

错误:
  - target pane terminated
  - cannot send to self
  - timeout_sec out of range
```

**`read_pane(id, last_n_lines=200)`**
```
输入:
  id: string
  last_n_lines: int     // 默认 200，最大 2000

输出:
  {
    output: string,     // 最近 N 行纯文本（ANSI 已剥离）
    is_idle: bool,      // 当前是否判定为 idle
    cursor_prompt: string // 当前 prompt 行（用于 debug）
  }
```

**不加任何第 4 个工具**，即便用户要求。新功能必须先证明 3 个工具组合满足不了。

### 5.3 Idle 检测策略

判定一个 pane 是否 idle 的组合条件（必须全部满足）：

1. **N 秒无输出**（静默阈值，每个 CLI profile 可配）
2. **光标在 prompt 行正则匹配**（每个 CLI profile 可配）

预置 profile 初稿（上线后按实测微调）：

```
claude-code:  idle_regex = "^\s*[›>❯]\s*$"          silence_ms = 3000
codex:        idle_regex = "^\s*codex[>›]\s*$"      silence_ms = 3000
gemini:       idle_regex = "^\s*$"                  silence_ms = 5000
opencode:     idle_regex = "^\s*[›>]\s*$"           silence_ms = 3000
shell (bash/pwsh): idle_regex = "^\s*[$#>]\s*$"     silence_ms = 1000
aider:        idle_regex = "^\s*>\s*$"              silence_ms = 3000   # 仅被控
```

**兜底机制**：UI 层每个 pane 右上角提供"标记完成"按钮，用户手动触发 idle。启发式检测永远会误判，给用户逃生口。

### 5.4 三文件注入（CLAUDE.md / AGENTS.md / GEMINI.md）

**文件由 Coffee-CLI 在项目根**自动生成/同步**，用户开启多 Agent 模式时 Coffee-CLI 检测并注入。

**内容骨架**（三文件一致）：

```markdown
# Coffee-CLI Multi-Agent Protocol

You are running inside Coffee-CLI as pane "${PANE_ID}" with role "${PANE_ROLE}".

You have access to 3 MCP tools (via the `coffee-cli` MCP server) that let you
observe and instruct the OTHER panes:

- `list_panes()` — see what's in other panes
- `send_to_pane(id, text, wait)` — send a command to another pane
- `read_pane(id)` — read another pane's recent output

## When to use these tools

Use them when the user explicitly asks to involve another CLI agent, or when
a task would genuinely benefit from another agent's strength (e.g., Gemini's
vision, Codex's code generation, Claude's reasoning).

Do NOT automatically chain tasks across panes. After getting a result from
another pane, SUMMARIZE for the user and ASK before continuing to a third pane.

## Sending patterns

- Short task (< 2 min): `send_to_pane(id, text, wait=true, timeout_sec=120)`
  returns completed output directly.
- Long task (> 2 min): `send_to_pane(id, text, wait=false)`, then tell the
  user "I sent this to pane X, ask me when to check results", and use
  `read_pane(id)` later.

## Parallel fan-out pattern

When the user asks to involve MULTIPLE agents at once (e.g., "let Codex,
Gemini and OpenCode each design this"), invoke all `send_to_pane` calls
in a SINGLE assistant turn. Do NOT call them sequentially — that defeats
the whole point of multiple agents.

Correct (parallel, one turn):
  - send_to_pane("pane-1", prompt, wait=true, timeout_sec=180)
  - send_to_pane("pane-2", prompt, wait=true, timeout_sec=180)
  - send_to_pane("pane-3", prompt, wait=true, timeout_sec=180)
  → all three tool_results come back → summarize differences for user.

Wrong (sequential):
  Turn 1: send_to_pane("pane-1", ...) → wait result
  Turn 2: send_to_pane("pane-2", ...) → wait result
  Turn 3: send_to_pane("pane-3", ...) → wait result
  This is 3× slower and loses the multi-agent point.

Scaling (3+ targets OR tasks > 2 min):
  Turn 1: three `send_to_pane(wait=false)` in parallel → tell user
          "dispatched N tasks, ask me when to check"
  Turn 2 (when user asks later): three `read_pane` in parallel →
          if all `is_idle=true`, read outputs and summarize;
          otherwise report which ones are still busy.

## Prompt completeness

The target pane sees ONLY what you send, not your conversation history.
Always include enough context for the target to act independently.

## When NOT to use Coffee-CLI tools

DO NOT use `send_to_pane` just to spawn an internal subagent. Each CLI
has its own native subagent mechanism — use that for intra-CLI parallelism:

- Claude Code → use Agent Teams (/agent spawn, Shift+Down cycle)
- Codex → use Codex subagents / rescue
- Gemini → use Gemini agent framework
- OpenCode → use @subagent-name or TaskTool

USE `send_to_pane` ONLY when the user wants a DIFFERENT CLI (running
in another pane) to do the work. The whole point of Coffee-CLI is
cross-CLI collaboration, not yet-another-way to spawn subagents.

Rule of thumb: if the answer could come from "another version of me",
use your native subagent. If the answer needs a DIFFERENT CLI's
strengths (e.g., Gemini's vision, Codex's code gen), reach for
`send_to_pane`.

## What NOT to do

- Don't send commands to pane "${PANE_ID}" (yourself).
- Don't assume panes share state, files you created, or prior context.
- Don't build automatic multi-step pipelines; the user drives what happens next.
- Don't use Coffee-CLI tools for intra-CLI parallelism — use your native
  subagent SDK instead.
```

注入时机和条件：
- 用户在 Coffee-CLI UI 显式"开启多 Agent 模式"时
- 在当前工作区根目录写入（已存在则合并不覆盖，打 `<!-- COFFEE-CLI:MULTI-AGENT:START -->` 标记）
- 用户关闭多 Agent 模式时，Coffee-CLI 移除自己加的段落

### 5.5 MCP Server 进程架构与传输模式

**问题背景**：Coffee-CLI 本身是常驻 Tauri 进程。MCP 协议的 stdio 模式要求"client spawn server 为子进程"——这和"Coffee-CLI 已经跑着"冲突。

**决策：v1.0 采用 HTTP 传输（Streamable HTTP）**。

```
┌─ Coffee-CLI Tauri 主进程 ──────────────────┐
│  ├─ 前端 WebView（React + xterm.js）        │
│  ├─ 后端 Rust                               │
│  │   ├─ PTY Manager（portable-pty）         │
│  │   ├─ Pane State（每 pane 一个 tokio task）│
│  │   └─ MCP HTTP Server                     │
│  │       listen 127.0.0.1:${dynamic_port}   │
│  │       stdio 关闭（没有 shim 进程）       │
│  └─ Tauri IPC（前后端通信）                 │
└────────────────────────────────────────────┘
              ↑
              │ HTTP（localhost only）
              │
┌─ 主控 CLI（任一 pane 里跑的 Claude/Codex/...）┐
│  通过 mcp.json 配置 HTTP URL：                 │
│    "url": "http://127.0.0.1:${port}/mcp"      │
└────────────────────────────────────────────────┘
```

**为什么选 HTTP 不选 stdio**：

| 维度 | stdio 模式 | HTTP 模式（选定）|
|---|---|---|
| **Coffee-CLI 常驻** | ❌ 需要 shim 子进程中转 | ✅ 直接 listen |
| **CLI 连接方式** | `command = coffee-cli-mcp-stub` | `url = http://127.0.0.1:port/mcp` |
| **多 CLI 并发主控**（v1.x 可选） | ⚠️ 每家 CLI 都 spawn 一个 shim 实例，N 个 stub 再抢共享状态 | ✅ 多个 CLI 连同一个 HTTP server，天然多连接 |
| **断连恢复** | CLI 重启 = shim 重启 | CLI 重启 = 重新 HTTP 连接，Coffee-CLI 状态不丢 |
| **调试** | 要抓 shim 进程日志 | curl 就能测 |
| **跨 CLI 兼容** | Claude Code / Codex / Gemini / OpenCode 全都支持 | 同上 |

**端口分配**：Coffee-CLI 启动时 bind `127.0.0.1:0` 让 OS 自动分配，写入 `~/.coffee-cli/mcp-endpoint.json`，Coffee-CLI 注入 mcp 配置时读这个 endpoint。

**鉴权**：localhost-only bind + 生成随机 API key（每次启动新 key），CLI 注入配置时带上 `X-API-Key` header。不做 OAuth，只防同机误连（比如另一个 MCP client 意外连上来）。

**生命周期**：
- Coffee-CLI 启动 → HTTP server 起
- Coffee-CLI 退出 → HTTP server 停，CLI 侧 MCP tool call 返回连接错误，自然失效
- CLI 运行中 Coffee-CLI 崩溃重启 → 端口变了，CLI 需要重启（或重新读配置）

### 5.6 术语表

| 术语 | 定义 |
|---|---|
| **Pane** | 四宫格里的一格，对应一个 portable-pty 子进程 |
| **Primary pane（主控格）** | 用户**显式指定**的主控格，**只有**这个 pane 里的 CLI 被注入 MCP 配置。不等于"物理 1 号位"——用户可以把 Codex 放在右下角当主控 |
| **Worker pane（被控格）** | 非主控格，CLI 不装 MCP，只是被动接收 PTY 输入（来自 send_to_pane 或用户键盘） |
| **主控 CLI** | Primary pane 里跑的那个 CLI（四家之一：Claude Code / Codex / Gemini CLI / OpenCode） |
| **被控 CLI** | Worker pane 里跑的任意 CLI（含 Aider、shell 等非 MCP client） |
| **多 Agent 模式** | Coffee-CLI 的一个布尔开关：开启 = 四宫格 + MCP 注入 + `.md` 注入；关闭 = 单终端常规模式 |

**关键约束**：同一时刻**只有一个 primary pane**。用户切换 primary 时：
- 旧 primary 的 MCP 配置保留（除非用户明确"关闭多 Agent 模式"才清理）
- 新 primary 的 CLI 启动时会看到 MCP 工具可用
- **用户知情切换**，不自动切换

### 5.7 和 Coffee-CLI 现有 Tab 系统的关系

Coffee-CLI 现在的 Tab 系统：每个 Tab = 一个独立终端实例。

**多 Agent 模式下的关系**：

```
常规模式（v0.x）                  多 Agent 模式（v1.x）
┌─────────┬───────┐               ┌─────────┬───────┐
│ Tab1 Tab2 Tab3 │               │ Tab1 Tab2 Tab3 │
├─────────────────┤               ├─────────────────┤
│                 │               │ ┌─────┬─────┐   │
│   单终端占满    │               │ │pane0│pane1│   │
│                 │               │ ├─────┼─────┤   │
│                 │               │ │pane2│pane3│   │
│                 │               │ └─────┴─────┘   │
└─────────────────┘               └─────────────────┘
```

**决策**：
- 多 Agent 模式是**每个 Tab 独立的属性**，不是全局属性
- 某个 Tab 可以单终端（常规），另一个 Tab 可以多 Agent（四宫格）
- 每个 Tab 的多 Agent 状态独立：独立的 primary pane、独立的 MCP endpoint（走不同路径 `?tab=N`）、独立的 pane 列表
- 切换 Tab 时 MCP server 不重启，只是"当前激活的 pane 集合"变化

**实现层面**：
- MCP server 暴露的 `list_panes()` 返回**当前 Tab 的 pane 列表**（用 tab_id 隔离）
- send_to_pane 的 id 是 `tab-${tabId}-pane-${paneIdx}` 全局唯一

---

## 六、关键参考（前人踩过的坑，直接抄或显式规避）

| 参考仓库 | 抄什么 | 规避什么 |
|---|---|---|
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | 后台 job 三态（queued/running/completed/failed/cancelled）| 别抄 `codex app-server` JSON-RPC（Codex 独有，不通用） |
| [GGPrompts/conductor-mcp](https://github.com/GGPrompts/conductor-mcp) | `send_keys` 的 submit 延迟经验（800ms 防粘连）；profile 可插拔概念 | 57 处 tmux 硬编码 + fcntl = Windows 死路；单人维护不要依赖 |
| [tmux-python/libtmux-mcp](https://github.com/tmux-python/libtmux-mcp) | 工具集分 server/session/window/pane/buffer/hook 六层的信息架构 | 依赖 tmux 二进制，Windows 只能走 WSL |
| [bfly123/claude_code_bridge](https://github.com/bfly123/claude_code_bridge) | **AGENTS.md / CLAUDE.md 双文件注入让非-Claude agent 懂协议**（最核心抄法）；`CCB_CALLER_ACTOR` 环境变量传 sender | AF_UNIX + tmux 236 处硬编码 = Windows 死路；ccbd daemon 不要抄 |
| [superset-sh/superset](https://github.com/superset-sh/superset) | [`executeOnDevice` 的 500ms 轮询 + 参数化 timeout 模式](https://github.com/superset-sh/superset/blob/main/packages/mcp/src/tools/utils/utils.ts)；三态返回（completed/failed/timeout） | Cloud API + DB 架构过重，Coffee-CLI 全本地用内存 map 就行 |
| [Claude Agent Teams 官方](https://code.claude.com/docs/en/agent-teams) | mailbox 的异步消息投递语义（理解用，不实现） | 只支持 Claude Code 当主控；Windows 不支持 |

---

## 七、范围边界

### 7.1 做什么（v1.0）

- [ ] 四宫格 UI（起步 2×2，可滚动扩展至 N 格）
- [ ] 每格独立 portable-pty 子进程
- [ ] Rust MCP Server（3 个工具，stdio 传输）
- [ ] Idle 检测引擎（预置 6 个 profile：5 主控 + shell 被控 + aider 被控）
- [ ] 三文件注入（CLAUDE.md / AGENTS.md / GEMINI.md）
- [ ] **4 家主控 CLI** 的 mcp 配置一键接入脚本：
  - Claude Code → `~/.claude.json` 的 `mcpServers.coffee-cli`
  - Codex CLI → `~/.codex/config.toml` 的 `[mcp_servers.coffee-cli]`
  - Gemini CLI → `~/.gemini/settings.json` 的 `mcpServers.coffee-cli`
  - OpenCode → `opencode.json` 的 `mcp.coffee-cli`
- [ ] UI 光晕/徽标表示"正在被主控指挥"的格子

**仅被控（不能当主控，因为没有 MCP client 能力）**：
- Aider（无 MCP client，[aider-mcp-server](https://github.com/disler/aider-mcp-server) 是反向包装）
- 普通 shell（bash/zsh/pwsh/cmd）

### 7.2 不做什么（v1.0 永不做，后续可重新评估）

- ❌ DAG 编排 / 任务图
- ❌ Agent 间自主对话（Agent A 发给 Agent B 但不经过主控格）
- ❌ git worktree / 容器化沙箱
- ❌ 跨 Agent 身份协议 / sender identity
- ❌ 任务持久化到磁盘（内存 map 够用，Coffee-CLI 进程退出 = 任务结束）
- ❌ 集群 / 远程 pane（所有 pane 都在本地 Coffee-CLI 进程内）
- ❌ pane 之间自动上下文共享

---

## 八、风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| **PTY backpressure 根因 #2**（见 [project_known_issues.md](../../../../Users/eben/.claude/projects/d--Coffee-CLI/memory/project_known_issues.md)）| 4 路并发 PTY emit 放大锁死概率 | 每个 pane 独立 channel + drop 策略；stress test（4 格同时 cat 大文件）必须跑通 |
| **Idle 启发式误判** | 主控等不到、或提前取到半截输出 | 三重保障：silence + prompt regex + 用户手动标记按钮 |
| **MCP tool call 超时**（LLM 端可能 2-5 分钟强制 kill） | 长任务阻塞时被 LLM kill，主控不知道任务真失败还是假失败 | 默认 timeout=60s + `wait=false + read_pane` 模式 + CLAUDE.md 教主控长任务用异步 |
| **xterm.js 4 实例内存**（~30MB × 4 = 120MB+） | 用户开 8-12 格时内存压力大 | 非活跃格 pause 渲染（xterm 原生支持） |
| **Windows 路径 / 编码问题** | PowerShell vs CMD vs bash 的 prompt 正则不同 | profile 按 shell 区分，不只按 CLI agent |
| **LLM 不会用 3 个工具** | CLAUDE.md 写得再好，LLM 可能仍不调 MCP | 在 UI 加"告诉主控格"快捷按钮，一键发示例 prompt |
| **用户不知道何时用多 Agent** | 功能闲置 | UI 加"推荐多 Agent 场景"示例卡片（代码审查 / UI 设计 / 多方案对比） |

---

## 九、MVP 实施路线（8 天 + 开工前 1-2 天验证）

**开工前必做**：跑完 [附录 C 验证清单](#附录-c开发前必须验证清单1-2-天内完成)。验证未通过的条目要么阻塞开工、要么触发 scope 调整。

### 第 1-2 天：Rust MCP Server 骨架
- [ ] `rmcp` crate 接入（或 fallback 手写 JSON-RPC over axum）
- [ ] 实现 3 个工具，先用内存 mock pane 验证协议层
- [ ] **HTTP 传输**跑通（127.0.0.1 + X-API-Key），stdio 不做
- [ ] 端口写入 `~/.coffee-cli/mcp-endpoint.json`

### 第 3-4 天：多 PTY 管理层
- [ ] 扩展 [src/terminal.rs](../src-tauri/src/terminal.rs) 支持多 pane
- [ ] 每 pane 独立 channel，防 backpressure
- [ ] 4 路并发 stress test 必须通过（4 格同时 `cat` 大文件不锁死）

### 第 5 天：UI 四宫格
- [ ] 主区域 2×2 grid（可滚动加格子）
- [ ] 每格 xterm.js 实例 + 非活跃 pause
- [ ] "被主控指挥中"光晕徽标
- [ ] "标记完成"手动按钮（idle 兜底）

### 第 6 天：Idle 检测引擎
- [ ] 4 个主控 CLI profile + aider + shell = 6 个 profile（参考 [5.3 节](#53-idle-检测策略)）
- [ ] silence + prompt regex 组合判定
- [ ] 轮询策略（500ms）
- [ ] 每 pane 右上角"标记完成"兜底按钮

### 第 7 天：三文件注入 + 一键配置
- [ ] CLAUDE.md / AGENTS.md / GEMINI.md 模板
- [ ] 工作区根目录自动写入 + 清理
- [ ] 四家 CLI 的 mcp.json 配置注入脚本

### 第 8 天：端到端验证
- [ ] 主控格 Claude Code 发指令到另一 pane Codex 设计 UI
- [ ] 主控格 Codex 发指令到另外两个 pane 的 Claude Code 并行写代码
- [ ] 长任务 `wait=false` + `read_pane` 回合式拉结果
- [ ] Windows 原生 build + 冒烟测试

---

## 十、决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-04-22 | 确定走"3 工具 + 四宫格 + 三文件注入"路线（方案 C） | 方案 A 不做不差异化，方案 B（完整编排器）打不过 LangGraph/Mastra |
| 2026-04-22 | 否决 Mailbox / Signal / DAG 编排 | 编排决策权留给主控格 LLM，Coffee-CLI 只做通信原语 |
| 2026-04-22 | 否决 Agent 身份识别协议 | 不做跨 Agent 对话，单向指令注入不需要 |
| 2026-04-22 | 抄 CCB 的三文件注入法（AGENTS.md / CLAUDE.md / GEMINI.md） | 这是让非-Claude agent 理解协议的最通用手段（不依赖各家 skill 机制） |
| 2026-04-22 | 抄 Superset 的 500ms 轮询 + 参数化 timeout | `send_to_pane(wait=true)` 内部实现直接对齐 |
| 2026-04-22 | 否决 tmux 依赖 | Windows 用户是主阵地，tmux 路线全部死路 |
| 2026-04-22 | **主控 CLI 锁定 4 家**：Claude Code / Codex / Gemini CLI / OpenCode | 基于 [OpenRouter coding apps 排名](https://openrouter.ai/apps/category/coding) 真实流量数据 + 各家官方直连规模综合判定 |
| 2026-04-22 | 踢掉 Amp | Sourcegraph 2025 砍个人 Free/Pro 自服务，现仅企业 contact-sales，个人开发者无法触达 |
| 2026-04-22 | 否决 Kilo Code | OpenRouter 排名第 1（182B tokens）但本质是 VS Code 插件，其 CLI 套壳 OpenCode——支持 OpenCode 即间接覆盖其 CLI 用户 |
| 2026-04-22 | **否决 Qwen Code（实测决策）** | 用户亲测：账号体系封闭，不接受外部账号登录；2026-04-15 Qwen OAuth 终止后配置流程繁琐。中文开发者可用 OpenCode + OpenAI-compatible endpoint（DeepSeek / 智谱 GLM / 月之暗面 / 阿里云百炼 API）替代，Coffee-CLI 不需为 Qwen Code 做专门适配 |
| 2026-04-22 | **职责边界：同家编排归各家 SDK，Coffee-CLI 只做跨家** | Claude Agent Teams / Codex app-server / Gemini agent / OpenCode TaskTool 四家都有成熟的内部 subagent SDK。Coffee-CLI 不和它们竞争，只做它们都做不到的"跨 CLI 进程桥梁"。CLAUDE.md 模板明确告诉主控 LLM"同家 subagent 用原生 SDK，跨家才用 send_to_pane" |
| 2026-04-22 | **CLAUDE.md 模板补充 Parallel fan-out 使用说明** | 主控 LLM 默认可能串行调用 tool（pane-1 等完再 pane-2），速度降为 1/N。模板明确教"一条消息多个 send_to_pane" + 给出正确/错误示例，覆盖"同时派给多个 pane"这个 Coffee-CLI 的核心场景 |
| 2026-04-22 | Aider 仅支持被控不支持主控 | Aider 本身不是 MCP client（`aider-mcp-server` 是反向包装），但其 git-first 特性独特，作为被控能力保留价值 |
| 2026-04-22 | **MCP 传输选 HTTP 不选 stdio** | Coffee-CLI 是常驻 Tauri 进程，不能被 CLI spawn 成子进程；HTTP 还天然支持多 CLI 并发主控 + 断连恢复。详见 [5.5 节](#55-mcp-server-进程架构与传输模式) |
| 2026-04-22 | **术语"1 号位"→"主控格（primary pane）"** | 用户可以把主控 CLI 放在任意格子，物理位置不等同于角色；术语不严谨会误导架构讨论 |
| 2026-04-22 | **加附录 C（开工前验证清单）+ 附录 D（开发中细节决策）** | 文档初稿的 15 处细节未想透；开工前把可验证的验证掉，不可立即验证的标注到"写到那天再定" |

---

## 附录 A：不变量（永不违背）

1. **Coffee-CLI 永远是"容器"不是"编排器"** —— 任何涉及"多步自动决策"的提议，重读第三节
2. **永远优先 Windows 用户** —— 任何只能在 POSIX 跑的方案直接否决
3. **3 个 MCP 工具上限** —— 加第 4 个工具必须先证明 3 个组合不够
4. **用户全程可见可干预** —— 任何"后台黑盒执行"的提议重读第二节独特性部分
5. **编排权归主控格 LLM** —— Coffee-CLI 不写 DAG、不写 task list、不写依赖图

---

## 附录 B：4 家主控 CLI 的 MCP 接入清单

**每家的配置位置 / 格式 / 协议入口**。实施"一键接入"脚本时按此表查。

| CLI | mcp 配置文件 | 配置 key | 协议提示文件（项目根） | 备注 |
|---|---|---|---|---|
| **Claude Code** | `~/.claude.json` | `mcpServers.coffee-cli` | `CLAUDE.md` | 或走 Skill（`~/.claude/skills/coffee-multi-agent/SKILL.md`），token 效率更高 |
| **Codex CLI** | `~/.codex/config.toml` | `[mcp_servers.coffee-cli]` | `AGENTS.md` | OpenAI 官方格式 |
| **Gemini CLI** | `~/.gemini/settings.json` | `mcpServers.coffee-cli` | `GEMINI.md` | Google 官方 |
| **OpenCode** | `opencode.json` | `mcp.coffee-cli` | `AGENTS.md` | sst/opencode，支持 local(stdio)/remote(HTTP) |

**三 `.md` 文件只写三份**（CLAUDE.md / AGENTS.md / GEMINI.md 内容一致），分别被 Claude Code / Codex 和 OpenCode 共用 / Gemini CLI 读取。

**传输方式**：全部用 **HTTP（Streamable HTTP）**。Coffee-CLI 主进程监听 `127.0.0.1:${动态端口}`，所有主控 CLI 的 `mcpServers.coffee-cli` 配置统一为：

```json
{
  "url": "http://127.0.0.1:${port}/mcp",
  "headers": { "X-API-Key": "${session_key}" }
}
```

实际端口和 key 由 Coffee-CLI 启动时写入 `~/.coffee-cli/mcp-endpoint.json`，注入脚本读取后填入各家 CLI 配置。

**为什么不用 stdio**：Coffee-CLI 是常驻 Tauri 进程，不能被 CLI spawn 为子进程。详见 [5.5 节](#55-mcp-server-进程架构与传输模式)。

---

## 附录 C：开发前必须验证清单（1-2 天内完成）

这些是**实施 MVP 前必须有真实答案**的事实问题。每个对应一段可执行的验证动作。

### C.1 四家主控 CLI 的 HTTP MCP 支持情况

| CLI | 验证动作 | 通过标准 |
|---|---|---|
| Claude Code | 手写 `mcp-test` HTTP server，注入 `~/.claude.json`，在 Claude Code 里试调用 | tool call 正常返回 |
| Codex CLI | 同上，注入 `~/.codex/config.toml` 的 `[mcp_servers.test]` | tool call 正常返回 |
| Gemini CLI | 同上，注入 `~/.gemini/settings.json` 的 `mcpServers.test` | tool call 正常返回 |
| OpenCode | 同上，注入 `opencode.json` 的 `mcp.test` | tool call 正常返回 |

**降级预案**：如果某家 CLI 不支持 HTTP（仅支持 stdio），v1.0 先砍掉这家，v1.1 做 stdio shim 补上。**不把 v1.0 卡在蹩脚的 shim 实现上**。

### C.2 现有 PTY backpressure 在 4 路并发下稳定性

- 动作：在当前 `main` 分支写一个 4 pane 并发 stress test（4 格同时 `find / -type f 2>/dev/null` 或 `cat /dev/urandom | head -c 100M`），观察是否锁死
- 通过标准：10 次连续跑完不锁死；如果锁死，锁定[根因 #2](../../../../Users/eben/.claude/projects/d--Coffee-CLI/memory/project_known_issues.md)，v1.0 前修掉

### C.3 四家 CLI 的 prompt regex 实测

- 动作：每家 CLI 启动后录制 60 秒的 PTY 输出（typing + 等待 + 提交 + 等待），肉眼定位 idle 时光标所在行的字节序列
- 通过标准：4 个 idle_regex 全部有测到真实值，不是猜的；写进 5.3 节表

### C.4 Aider 作为被控的可行性

- 动作：手动起 Aider，手动发 `send_to_pane` 模拟：输入 `/ask what files are in this repo`，观察输出结构
- 通过标准：确定 Aider 的 prompt 形状 + 确定用户发指令的正确语法前缀（如 `/ask`、`/code`、`/add`）

### C.5 rmcp crate 可用性

- 动作：`cargo add rmcp`，按官方 example 起一个 HTTP MCP server，Claude Code 能连上
- 通过标准：hello-world tool 能被调用并返回；如果 rmcp 不可用或 API 差太远，备选方案是手写 JSON-RPC over HTTP（不复杂，axum + tokio 半天够）

---

## 附录 D：开发中必须处理的细节（P1，在对应日程天前思考好）

这些不是开发前必须答，但**写到相关代码那天必须有明确答案**。

### D.1 配置文件 merge 策略（第 7 天 CLI 接入脚本时）

修改用户 `~/.claude.json` 等配置**必须 merge 不能 overwrite**：

1. 读取现有配置（JSON / TOML）
2. 保留所有现有字段，只在 `mcpServers` 里添加 `coffee-cli` 一项
3. 写回前备份到 `~/.coffee-cli/backup/claude.json.${timestamp}.bak`
4. 卸载时按 backup 文件**精确还原**（不是删除我们加的那项——因为用户可能手动改了其他地方）
5. 备份保留最近 10 份，自动清理更老的

### D.2 send_to_pane 返回的输出起点（第 1-2 天 MCP 工具实现时）

问题：返回"发送后到 idle 的输出"——用户在此期间如果手动输入会干扰。

方案：
- 发送前记录 PTY output buffer 长度作为 `start_offset`
- idle 时读取 `buffer[start_offset..]` 作为返回
- UI 层在这段输出上加"正在被主控指挥"视觉遮罩，告知用户**这段别打扰**
- 用户仍可手动输入（不强制锁），但输入内容会进返回 output——这是副作用，主控 LLM 收到后可识别

### D.3 job_id 的角色（第 1-2 天 MCP 工具实现时）

**job_id 仅作诊断标识**，**不作为后续 MCP 工具的调用 handle**。主控想取长任务结果，用 `read_pane(pane_id)` 而不是 `read_job(job_id)`。

job_id 的用途：
- 写入服务端日志（`~/.coffee-cli/mcp-jobs.log`）便于事后调试
- UI 在"被主控指挥中"徽标上显示 job_id 让用户和日志对应
- **不会**暴露一个 `read_job` 工具（违反 3 工具上限）

### D.4 shell 类被控的危险命令拦截（第 5-6 天 UI 层）

主控 LLM 调 `send_to_pane(shell_pane, "rm -rf /")` 是真实风险。

分级策略：
- **被控是 agent CLI**（Claude/Codex/Gemini/OpenCode/Aider）→ 直接发送，agent 自己有安全机制
- **被控是 shell**（bash/zsh/pwsh/cmd）→ **弹确认框**，用户点"允许一次" / "允许总是（此会话）" / "拒绝"
- profile 字段 `requires_confirmation: bool`，shell profile 默认 true，agent profile 默认 false
- 用户可在设置里对 shell 关闭确认（"我知道我在做什么"）

### D.5 并发模型（第 3-4 天 PTY 层）

每个 pane 一个 tokio actor（独立 `tokio::task`），actor 持有：
- PTY 子进程 handle
- stdout/stderr bounded channel（背压友好，默认 1024 帧）
- idle 状态机
- 一个 mpsc receiver 接受来自 MCP server 的命令（send_keys / capture_output / get_state）

MCP server 本身是独立 actor，通过 per-pane mpsc 和 pane actor 通信。无全局锁。

### D.6 主控格切换流程（第 5-6 天 UI）

用户把 primary 从 pane 0 切到 pane 2 时：

1. 旧 primary pane 的 MCP 配置**不动**（保留在 `~/.claude.json` 等）
2. 新 primary pane 所在 CLI 启动时看到 MCP 工具可用
3. **建议**用户**重启**新 primary 的 CLI 以加载 MCP（显示提示，不强制）
4. 关闭多 Agent 模式时**才真正**清理所有 MCP 配置

### D.7 用户触发"开启多 Agent 模式"的 UX

**核心原则：启动权归用户**。主控 LLM 可以**指挥**已启动的 pane，**不能启动**新 pane。避免 spawn 开销阻塞 tool call + auth 无法自动化 + 烧钱失控 + 违反[附录 A 不变量 #3](#附录-a不变量永不违背)（3 工具上限）。

#### 入口

- Tab 右上角一个"⊞"四宫格图标 → 点击切换当前 Tab 到四宫格模式
- 切换即生效，**不弹确认框**（保持极简）

#### 四宫格内每格的初始状态

- **pane-0（当前 Tab 正在跑的那个 CLI）**：保留原样，自动标记为 `primary pane`
- **pane-1 / pane-2 / pane-3**：**空 pane**，中央显示一个下拉 + 启动按钮

#### 空 pane 的启动交互

```
┌──────── pane-N (empty) ────────┐
│                                 │
│        ┌──────────────┐         │
│        │ 选择 CLI   ⌄ │         │
│        │ ─────────── │         │
│        │ Claude Code │         │
│        │ Codex       │         │
│        │ Gemini CLI  │         │
│        │ OpenCode    │         │
│        │ shell       │         │
│        │ 自定义命令   │         │
│        └──────────────┘         │
│          [ 启动 ]               │
│                                 │
└─────────────────────────────────┘
```

- 下拉选择后点"启动"才 spawn 子进程
- 未安装的 CLI 标灰 + 小图标提示"点击安装"
- 下拉旁齿轮可选 profile（模型 / 工作目录 / 额外参数），非必填

#### 主控格对空 pane 的调用

`send_to_pane(pane_id, text)` 调空 pane 时返回：
```
{ status: "failed", error: "pane is empty, ask user to start a CLI first" }
```

主控 LLM 应当告知用户"如果要 Gemini 帮忙，请在 pane-2 启动 Gemini CLI"——这段 guidance 写进 CLAUDE.md / AGENTS.md / GEMINI.md 模板。

#### 关闭多 Agent 模式

- Tab 右上角"⊞"图标再次点击 → 退回单 pane 模式
- 退出时：
  - 所有 worker pane 的子进程**终止**（主控格 CLI 保留，因为它就是 Tab 的原进程）
  - MCP 配置**还原**（按 `~/.coffee-cli/backup/*.bak` 还原）
  - 项目根的 CLAUDE.md / AGENTS.md / GEMINI.md **移除** Coffee-CLI 加的段落（按 `<!-- COFFEE-CLI:MULTI-AGENT:START/END -->` 标记精确移除，用户手动加的内容不动）

#### 可选增强（v1.1，不阻塞 MVP）

- **"恢复上次组合"按钮**：用户之前启动过 `[Claude / Codex / Gemini / OpenCode]`，下次 Tab 右上角出现"恢复上次"按钮，一键四格同时启（仍是用户触发）
- **快捷模板**：预置"代码审查三人组"（Claude + Codex + Gemini）、"双模对比"（Claude + OpenCode）等常见组合

### D.8 测试矩阵（第 8 天）

最小必跑的 E2E 场景：

| # | 场景 | 通过标准 |
|---|---|---|
| 1 | Claude Code 主控 Codex（设计 UI） | `send_to_pane(wait=true)` 返回 Codex 完整输出 |
| 2 | Claude Code 主控 Gemini + OpenCode（并行研究） | 两个 pane 同时被指挥，主控 LLM 合并结果 |
| 3 | Codex 主控 3 个 Claude Code（并行写代码） | 3 个 Claude Code pane 收到不同指令，独立进行 |
| 4 | 长任务 wait=false + 用户隔会儿问 | read_pane 能拿到阶段性输出 |
| 5 | 切换主控格（Claude → Codex） | MCP 工具在新主控格可用，旧主控格不再主动指挥 |
| 6 | 关闭多 Agent 模式 | 所有 mcp 配置还原、`.md` 文件清理干净 |
| 7 | Windows 原生 build + 中文 prompt 测试 | 无编码错误、idle 检测准确 |
| 8 | Coffee-CLI 崩溃重启 | 端口重新分配、CLI 需重启、状态清白 |
