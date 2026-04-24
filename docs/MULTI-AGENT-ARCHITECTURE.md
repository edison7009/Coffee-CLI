# Coffee-CLI 多 Agent 协作架构设计

> 本文档是"北极星文档"——任何 session 讨论多 Agent 功能时，先读本文档再开工。
>
> 起稿：2026-04-22（MCP 方案）
> 重写：2026-04-25（纠正 v1.1.6 错误写成"agent 之间不存在通信"，本版为正确版）
> 状态：**v1.1.8 已交付，双向哨兵协议为当前真实实现**

---

## 一、文档目的

定义 Coffee-CLI 多 Agent 协作功能的：
- 产品定位（永不偏移的北极星）
- 技术路线（做什么 + **不做什么**）
- 范围边界（避免滑向 agent 编排器）
- 当前真实实现

本文档存在的原因：**防止多轮 AI 对话中目标漂移**。任何改动产品方向的提议，需先改本文档。

---

## 二、产品定位（北极星）

> **Coffee-CLI 是"跨 CLI 进程的可视化容器"**
>
> 4 个 AI CLI 并排跑，agent 之间通过 PTY 文本标记自动派发和回执任务，**全程用户眼睛看得见**。

核心卖点一句话：

> **"Claude Code 可以自动让 Codex 和 Gemini 干活，你在一个窗口里看 4 个 agent 相互协作，随时能接管。"**

市场独特性（竞品都做不了）：
- Opcode / Warp / Superset：有多 Agent，但**用户看不到被控过程**
- LangGraph / Mastra：**要写 DAG 代码**，学习成本高
- Claude subagent：**过程对用户黑盒**，无法干预
- claude-squad / conductor-mcp：**Windows 不能用**（依赖 tmux）

**Coffee-CLI 独占位**：Windows 原生 + 用户可见 + 用户可干预 + 异构 CLI 组合 + agent 自主协作但人类能随时接管。

---

## 三、核心通信机制：哨兵协议（双向 PTY 标记）

**agent 之间通过 PTY 输出里的文本标记通信。** Coffee-CLI 前端扫描每个 pane 的 PTY 流，命中标记时把内容投递到目标 pane 的输入流。

### 两种标记

| 标记 | 方向 | 何时激活 | 作用 |
|---|---|---|---|
| `[COFFEE-TELL:paneN->paneM] <text>` | 派发（N → M） | **永远激活**（产品核心能力） | pane M 的 PTY 收到 "`[From pane N] <text>`" + Enter |
| `[COFFEE-DONE:paneN->paneM]` | 回执（N → M） | **仅哨兵开启时** | pane N 徽章亮绿点；pane M 也开了哨兵就收到"`[From pane N] Task complete.`" |

### 触发规则

**TELL（派发）**：
- 目标 pane 有 CLI 在跑
- 目标 ≠ 发起方
- `<text>` 非空

**DONE（回执）**：
- 发起方 pane 开启了哨兵模式
- 目标 pane 也开启了哨兵（才会注入通知）
- 目标 pane 有 CLI 在跑
- 目标 ≠ 发起方

### 开哨兵 vs 不开哨兵，行为差异

| 行为 | 不开哨兵 | 开哨兵 |
|---|---|---|
| pane A Claude 能给 pane B Gemini 派任务 | ✅ 能（TELL 常开） | ✅ 能 |
| pane B Gemini 干完后自动通知 pane A | ❌ 不通知 | ✅ 注入"Task complete"到 pane A |
| pane B 徽章亮绿点提示完成 | ❌ | ✅ 30 分钟内有效 |
| 用户需要盯屏判断是否干完 | 要 | 不要 |

### 用户可见性

- **发起方 scrollback**：看得见 agent 写出的 marker 原文
- **目标方 scrollback**：看得见注入的 "`[From pane N] ...`" 行
- **不隐藏任何东西**：整条编排链路 = 用户随时能跟读的聊天记录

### 为什么不是 MCP

| 维度 | 哨兵协议（当前） | MCP（2026-04-24 退休） |
|---|---|---|
| 传输 | PTY 文本 | HTTP JSON-RPC |
| 用户可见性 | 100%（每条消息在 scrollback） | 0%（agent 工具调用对用户黑盒） |
| 注入用户 CLI 配置 | 不用 | 要写 `~/.claude.json` 等 |
| 端口残留问题 | 没有 | 有（老版本 coffee-cli MCP 死端口残留报错） |
| 工作量 | 前端 regex + PTY 写入 | rmcp crate + HTTP server + 3 CLI config 合并注入 |
| 产品定位契合度 | 契合"透明容器" | 契合"agent 编排器"，和 LangGraph 正面竞争 |

**结论**：哨兵协议在覆盖 agent-to-agent 自主通信的同时，保留了"用户可见可接管"的核心定位。MCP 是多余的。

---

## 四、被否决的方向（永不要再提，除非推翻本文档）

| 方向 | 否决理由 |
|---|---|
| **MCP agent-to-agent 工具** | 哨兵协议已覆盖 agent-to-agent 能力，MCP 是多余复杂度 + 污染 global CLI 配置 |
| **DAG 编排层** | 滑向 Mastra/LangGraph，和巨头正面竞争打不过 |
| **多行 TELL 文本** | 跨行解析易碎 + 用户 scrollback 难读；agent 应把 prompt 摘要到单行 |
| **Agent 身份识别协议 / sender tag** | `[From pane N]` 前缀已经够了 |
| **Pane 布局 DSL** | 四宫格 + 1×2 / 1×3 足够 |
| **Workstation 模式** | 已砍，tag `archive/workstation-mode` |
| **容器化隔离 / git worktree** | 定位是"可视化容器"不是"隔离沙箱" |
| **Agent 心跳 / heartbeat** | PTY 挂了用户重启 |
| **DetachedTerminal（tab 分离窗口）** | 2026-04-24 删除，零引用 |

---

## 五、技术架构

### 5.1 系统总览

```
┌─ Coffee-CLI (Tauri v2 + Rust + xterm.js) ──────────────────────────┐
│                                                                    │
│  ┌─ Pane Grid（UI 层）──────────────────────────────┐             │
│  │  2×2 / 1×2 / 1×3 多种布局                          │             │
│  │  每格 = 独立 portable-pty 子进程                   │             │
│  │  每格运行任意 CLI（Claude / Codex / Gemini / ...）  │             │
│  └────────────────────────────────────────────────────┘             │
│                        ↓ agent 输出 marker                          │
│  ┌─ Sentinel Scanner（前端 regex）─────────────────┐               │
│  │  每帧 PTY 扫 TELL / DONE                          │               │
│  │  TELL → 注入 target PTY + Enter（永远开）         │               │
│  │  DONE → 绿点 + 注入 target 通知（哨兵开启时）     │               │
│  └────────────────────────────────────────────────────┘             │
│                        ↓ 注入 target pane PTY                       │
│  ┌─ 协议 .md 注入（项目根）──────────────────────┐                │
│  │  CLAUDE.md / AGENTS.md / GEMINI.md                │                │
│  │  告诉 agent TELL / DONE 的语法和使用时机           │                │
│  │  `.multi-agent/PROTOCOL.md` 存完整协议             │                │
│  └────────────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 TELL marker 规格（永远激活）

**格式**：
```
[COFFEE-TELL:paneN->paneM] <single-line text>
```

- `N` = 发起者 pane 号（1..4）
- `M` = 目标 pane 号（1..4，M ≠ N）
- `<text>` 在同一行，以 `\n` 或 `\r` 结束
- 长 prompt 必须 agent 摘要成单行再发

**前端行为**（见 [src-ui/src/components/center/TierTerminal.tsx](../src-ui/src/components/center/TierTerminal.tsx)）：

1. Regex `\[COFFEE-TELL:pane(\d+)->pane(\d+)\]\s+([^\r\n]+)` 匹配
2. 校验：target pane 有 CLI 在跑 + target ≠ emitter + text 非空
3. 调 `getTabActions(targetId)?.paste("[From pane N] <text>")`
4. 50ms 延迟后发 `\r`（在 bracketed-paste frame 外，TUI 会当成 Enter）

**agent 怎么知道自己的 pane 号**：用户会告诉它（"你是 pane 3"），或首次对话时 agent 主动问。agent 进程本身看不见 pane 号。

### 5.3 DONE marker 规格（仅哨兵开启时）

**格式**：
```
[COFFEE-DONE:paneN->paneM]
```

**前端行为**：

1. 检测到 marker
2. **门槛 1**：发起者 pane `sentinelEnabled === true` → 发起者徽章 `completionTs = Date.now()` 亮绿点（30 分钟有效）
3. **门槛 2**：目标 pane 也 `sentinelEnabled === true` + 有 CLI + target ≠ emitter → 注入 "`[From pane N] Task complete.`" + Enter

不开哨兵 = 两个门槛都不过，什么都不会发生。agent 可能照样输出 marker 但纯粹是文本留在 scrollback。

### 5.4 协议 .md 注入

Coffee-CLI 在开启多 Agent 模式时，向工作区根写入：

| 文件 | 被谁读 |
|---|---|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Codex CLI / OpenCode 系 |
| `GEMINI.md` | Gemini CLI |
| `.multi-agent/PROTOCOL.md` | 长文档，三家同时指向 |

内容由 [src/multi_agent_protocol.rs](../src/multi_agent_protocol.rs) 模板生成，告诉 agent：
- TELL 语法 + 何时用（要另一个 pane 干活时）
- DONE 语法 + 何时用（用户开了哨兵模式且完成任务）
- 单行限制 + 自己 pane 号需用户告知
- 完成任务后除了输出结果也输出 DONE（如果适用）

**合并策略**：如果用户已有 CLAUDE.md，只在 `<!-- COFFEE-CLI:MULTI-AGENT:START/END -->` 标记内插入块。退出多 Agent 模式时精确移除。

### 5.5 Tab 独立性

- 多 Agent 模式是**每个 Tab 独立属性**
- Tab 切换不影响其他 Tab 的 pane 状态
- 哨兵开关**每个 pane 独立**（点击 pane 徽章上的小开关 toggle）

---

## 六、关键参考

| 参考仓库 | 抄什么 | 规避什么 |
|---|---|---|
| [bfly123/claude_code_bridge](https://github.com/bfly123/claude_code_bridge) | 三文件注入 CLAUDE.md / AGENTS.md / GEMINI.md 的思路 | AF_UNIX + tmux 236 处硬编码 = Windows 死路 |
| [Claude Agent Teams](https://code.claude.com/docs/en/agent-teams) | 同家 subagent 归 Claude 自己管 | 只支持 Claude 当主控 |

---

## 七、范围边界

### 7.1 v1.1.8 已交付

- [x] 四宫格 + 1×2 / 1×3 布局
- [x] 每格独立 portable-pty 子进程
- [x] Tab 独立的多 Agent 模式开关
- [x] 协议 .md 注入（CLAUDE.md / AGENTS.md / GEMINI.md + PROTOCOL.md）
- [x] TELL 双向派发（永远激活）
- [x] DONE 回执（哨兵模式开启时）
- [x] 每 pane 独立的哨兵开关
- [x] Gambit 用户手动广播（和 TELL 并存，供用户直接使用）
- [x] 历史 MCP 残留自愈（清理 `~/.claude.json` 等老条目）
- [x] 7 家 built-in AI CLI（Claude / OpenCode / OpenClaw / Codex / Gemini / Qwen / Hermes）

### 7.2 永不做（放弃理由见 §4）

- ❌ MCP / ACP 结构化 agent-to-agent 通信（哨兵已覆盖）
- ❌ DAG 编排 / 任务图
- ❌ 多行 TELL 文本
- ❌ git worktree / 容器化沙箱
- ❌ 任务持久化到磁盘
- ❌ 集群 / 远程 pane
- ❌ pane 之间自动上下文共享

---

## 八、风险清单

| 风险 | 对策 |
|---|---|
| **假 marker 触发**：agent 输出文档/代码样例中凑巧包含 `[COFFEE-TELL:...]` | TELL 对用户是"可见即可控"，发生了用户立刻看得见并可以关闭那个 pane 的 sentinel 或直接叫停 |
| **target pane 忙时被派发打扰** | 注入仍会发，agent 端 prompt 处理；v1.2 可加"target busy 时排队"，当前暂不做 |
| **PTY backpressure 4 路并发** | 每 pane 独立 channel；stress test（4 格同时 cat 大文件）必须通过 |
| **xterm.js 4 实例内存（~30MB × 4）** | 非活跃 Tab 暂停渲染 |
| **用户不知道何时开哨兵** | UI 提示：哨兵只影响完成通知，TELL 派发一直是活的 |

---

## 九、决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-04-22 | 初版走 MCP 3 工具方案 | 见附录 F（已退休） |
| 2026-04-24 | **退 MCP，迁移到哨兵协议** | MCP 污染 global CLI 配置；PTY-marker 方案更透明、零污染 |
| 2026-04-24 | ⚠️ **误写**：北极星文档错写成"agent→agent 不存在" | 当时混淆了"退 MCP"和"退所有 agent 通信"，见 §九第一条决议日志 |
| 2026-04-25 | **纠正**：哨兵协议 = 双向 PTY marker（TELL 常开 + DONE 哨兵门） | 用户指出 v1.1.6 文档写错；TELL forward 方向本来就该实现。v1.1.8 实装 + 文档重写 |
| 2026-04-24 | 删 DetachedTerminal | 孤儿组件零引用 |
| 2026-04-24 | 删翻译流水线脚本 | 6000+ 行战略转向前残留 |
| 2026-04-24 | OpenClaw 加入 built-in | 第 7 家 AI CLI，命令 `openclaw tui` |

---

## 附录 A：不变量（永不违背）

1. **Coffee-CLI 永远是"可视化容器"不是"编排器"** —— 多步自动决策归 agent 自己，不归 Coffee-CLI 写 DAG
2. **永远优先 Windows 用户** —— 任何只能在 POSIX 跑的方案直接否决
3. **agent 间通信**走 PTY 文本标记，**不走结构化 API**（无 MCP / 无 ACP）
4. **用户全程可见可干预** —— 每条 agent 间消息都在 scrollback，人随时能接管
5. **协议 .md 不能对 agent 撒谎** —— 告诉 agent 的能力必须真实可用

---

## 附录 B：三家 CLI 的协议 .md 注入清单

| CLI | 协议提示文件（项目根） |
|---|---|
| **Claude Code** | `CLAUDE.md` |
| **Codex CLI** | `AGENTS.md` |
| **Gemini CLI** | `GEMINI.md` |

**已移除**：所有 `mcpServers.coffee-cli` 注入（退 MCP）。每次 Coffee-CLI 启动会扫描三个 CLI 配置文件自愈清理老残留。

---

## 附录 E：竞品扫描与独占位验证（2026-04-22 扫描，结论仍成立）

| 方案 | 能否跨 CLI | Windows 原生 | 可视化 GUI | 用户全程可见 | 对 Coffee-CLI 影响 |
|---|---|---|---|---|---|
| metaswarm | 半真 | ❌ POSIX-first | ❌ | ❌ | 零威胁 |
| myclaude | 真 | ⚠️ POSIX-first | ❌ | ❌ | 零威胁 |
| claude_code_bridge | 真（tmux） | ❌ | ❌ | ✅ tmux pane | 零威胁 |
| Claude Co-Commands | 插件 | — | ❌ | ❌ | 零威胁 |
| Zed ACP | 1:1 协议 | ✅ | Zed/JetBrains 内 | ✅ | 机会窗（未来可选） |

三条护城河：**桌面 GUI + 可见多 PTY / Windows 原生 / 人类可接管的 agent 自治**。

---

## 附录 F：历史方案存档（MCP 时代 2026-04-22 → 2026-04-24，已退休）

> ⚠️ 以下仅供查阅决策脉络，不是实现参考。

### F.1 MCP 3 工具（退休）

原计划通过 Rust MCP Server (rmcp + Streamable HTTP) 暴露：
- `list_panes()` / `send_to_pane(id, text)` / `read_pane(id)`

通过注入 `~/.claude.json` / `~/.codex/config.toml` / `~/.gemini/settings.json` 让主控 CLI 发现该 MCP Server。

### F.2 为什么退休

1. **污染 global CLI 配置**：写入用户 `~/.claude.json` 等全局配置；老端口残留导致"1 MCP server failed"报错
2. **用户不可见**：MCP tool call 对用户黑盒，违反"全程可见"护城河
3. **哨兵协议覆盖同等能力**：双向 PTY marker 达到 agent-to-agent 自治，无需结构化 API
4. **产品定位**：MCP 路线是"agent 编排器"，和 LangGraph/Mastra 正面竞争打不过；PTY 路线是"可视化容器"，独占位

### F.3 代码保留状态

- [src/mcp_server.rs](../src/mcp_server.rs) 和 [src/mcp_injector.rs](../src/mcp_injector.rs) 归档，`#![allow(dead_code)]`
- `uninstall_all` 在 `start_ui` / shutdown 持续运行，清理老版本残留

### F.4 2026-04-24 文档写错回顾

当时退 MCP 时我（AI assistant）错误地把"退 MCP"理解成"退所有 agent 间通信"，导致文档 §3 写成"agent→agent: 不存在"。实际产品意图一直是"哨兵协议双向 PTY marker"——TELL forward 方向 v1.1.6 漏实现，DONE backward 方向早已做好。2026-04-25 用户指出错误，本版文档 + 代码同步纠正。
