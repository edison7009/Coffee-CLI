# Coffee-CLI 多 Agent 协作架构设计

> 本文档是"北极星文档"——未来任何 session 讨论多 Agent 功能时，先读本文档再开工。
>
> 起稿：2026-04-22（MCP 方案）
> 改写：2026-04-24（退休 MCP，改走 Sentinel Protocol）
> 状态：**v1.0 已交付，Sentinel-only 为当前真实实现**
> 历史 MCP 方案细节见 [附录 F](#附录-f历史方案存档mcp-时代2026-04-22--2026-04-24-已退休)

---

## 一、文档目的

定义 Coffee-CLI 多 Agent 协作功能的：
- 产品定位（永不偏移的北极星）
- 技术路线（做什么 + **不做什么**）
- 范围边界（避免下次聊着聊着又滑向 agent 编排器）
- 当前真实实现（v1.0 已发布的部分）

本文档存在的原因：**防止多轮 AI 对话中目标漂移**。任何改动产品方向的提议，需先改本文档。

---

## 二、产品定位（北极星）

> **Coffee-CLI 是"跨 CLI 进程的可视化容器"**
>
> 不做 Agent 编排器、不做任务 DAG、不做心跳调度、不做容器化沙箱，**也不做同家 CLI 内部的 subagent 编排**，**更不做 agent-to-agent 结构化通信**。

核心卖点一句话：

> **"四个 AI CLI 并排跑，你一个人坐在前面看 + 发消息，不是 agent 自己互相调度。"**

市场独特性（竞品都做不了）：
- Opcode / Warp / Superset：有多 Agent，但**用户看不到被控过程**
- Claude Agent Teams / claude-squad / conductor-mcp：**在 Windows 不能用**（依赖 tmux）
- LangGraph / Mastra：**要写 DAG 代码**，用户学习成本高
- Claude subagent：**过程对用户黑盒**，无法干预

**Coffee-CLI 独占位**：Windows 原生 + 用户可见 + 用户可干预 + 异构 CLI 组合（Claude + Codex + Gemini 真并排共存）。

### 职责边界：同家编排 vs 跨家编排 vs agent 自治

| 场景 | 谁来处理 |
|---|---|
| Claude Code 内部开多个 subagent | Claude Code 自己（Agent Teams） |
| Codex 内部 rescue / 子任务 | Codex 自己 |
| Gemini 内部 agent 分身 | Gemini 自己 |
| **跨进程显示 + 人类可干预调度** | ✅ **Coffee-CLI** |
| **跨进程 agent-to-agent 自动消息** | ❌ **不做**（这是 MCP 时代被否决的路线） |

**结论**：Coffee-CLI 只做"跨 CLI 进程桥梁 + 可视化容器"。编排决策权归人类眼睛+键盘，不归 agent。

---

## 三、核心设计哲学：人类编排，不是 agent 编排

**编排权归坐在电脑前的人类，Coffee-CLI 只提供 UI 可视化、输入广播、可选完成提示。**

三条原则：

1. **人类是编排者**
   多步决策（Gemini 做完要不要转给 Codex）由**用户**实时决定，不由任何 agent 自动转发。
   agent 之间**没有任何结构化通信通道**——每个 pane 是孤立的 CLI 进程。

2. **用户全程可见可接管**
   四个 pane 的 PTY 输出流式可见，用户可点任意格子直接接管对话。Gambit 一键广播给用户省了手工复制-粘贴，但"发给谁"仍是用户决定。

3. **通信原语最小化**
   - 人 → agent：键盘 / Gambit UI 广播
   - agent → agent：**不存在**
   - agent → 人：PTY 输出 + 可选的哨兵完成标记

一切更复杂的模式（重试、acceptance criteria、fan-out 编排）都是**历史 MCP 方案**的概念，v1.0 不实现，以后也不打算做——靠人类坐在前面判断就够了。

---

## 四、被否决的方向（永不要再提，除非推翻本文档）

| 方向 | 否决理由 |
|---|---|
| **MCP agent-to-agent 工具（list_panes / send_to_pane / read_pane）** | 2026-04-24 退休。定位是"人类编排"，agent 互相调度不是我们要的产品 |
| **DAG 编排层** | 滑向 Mastra/LangGraph，和巨头正面竞争打不过 |
| **Agent 身份识别协议 / sender tag** | 不做跨 agent 对话，不需要 |
| **异步 mailbox / job 语义** | 不做异步通信，哨兵协议就够提示完成 |
| **Pane 布局 DSL** | 四宫格 + 可选 2/3 split 足够 |
| **Safety tier 分级** | 没有 agent-to-agent 通信就没有跨 agent 安全层问题 |
| **Workstation 模式** | 已砍，tag `archive/workstation-mode` |
| **容器化隔离 / git worktree** | 定位是"可视化容器"不是"隔离沙箱" |
| **Agent 心跳 / heartbeat** | 不做进程健康监控，PTY 挂了用户重启 |
| **DetachedTerminal（tab 分离窗口）** | 2026-04-24 删除，零 LOC 零用户 |

---

## 五、技术架构（Sentinel-only）

### 5.1 系统总览

```
┌─ Coffee-CLI (Tauri v2 + Rust + xterm.js) ──────────────────────────┐
│                                                                    │
│  ┌─ Pane Grid（UI 层）──────────────────────────────┐             │
│  │  2×2 / 1×2 / 1×3 多种布局                          │             │
│  │  每格 = 独立 portable-pty 子进程                   │             │
│  │  每格运行任意 CLI（Claude / Codex / Gemini / ...）  │             │
│  └────────────────────────────────────────────────────┘             │
│                        ↑                                            │
│                  人类眼睛 + 键盘 / Gambit UI                         │
│                        ↓                                            │
│  ┌─ Sentinel Scanner（前端 regex）─────────────────┐               │
│  │  每帧 PTY 输出扫 [COFFEE-DONE:paneN->paneM]      │               │
│  │  命中 → 绿点徽章 + 可选注入"完成"到 target pane  │               │
│  └────────────────────────────────────────────────────┘             │
│                                                                    │
│  ┌─ 协议 .md 注入（项目根）──────────────────────┐                │
│  │  CLAUDE.md / AGENTS.md / GEMINI.md 薄指针         │                │
│  │  .multi-agent/PROTOCOL.md 完整说明                │                │
│  │  告诉 agent："你没有跨 pane 工具，只有可选的哨兵   │                │
│  │    完成标记；用户是编排者"                         │                │
│  └────────────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

**注意和 MCP 时代的区别**：
- ❌ 没有 MCP Server
- ❌ 没有 tool API
- ❌ 没有注入 `~/.claude.json` / `~/.codex/config.toml` / `~/.gemini/settings.json`（但保留 self-heal 清理老版本残留）
- ✅ 只剩三件事：PTY 并排显示 + 哨兵扫描 + 协议 .md 告知

### 5.2 哨兵协议（Sentinel Protocol）

**格式**：在 PTY 输出里单独一行：

```
[COFFEE-DONE:paneN->paneM]
```

- `N` = 发起者 pane 编号（1..4）
- `M` = 目标 pane 编号（谁要这个完成信号）

**前端行为**（见 [src-ui/src/components/center/TierTerminal.tsx](../src-ui/src/components/center/TierTerminal.tsx)）：

1. 扫到匹配且**发起者 pane 开启了哨兵** → 发起者徽章亮绿点（30 分钟内有效）
2. 如果**目标 pane 也开启哨兵且 target ≠ emitter** → 前端把一条"paneN 完成"通知文本**注入 target pane 的 PTY 输入流**，让 target 的 agent 看到

**不做什么**：
- 不携带业务内容（只是完成信号）
- 不替代 agent-to-agent 通信（业务内容还是用户手动/Gambit 路由）
- agent 自己不会知道自己是 paneN——**用户必须告诉 agent 它的编号**

**为什么这样设计**：3 方参与者（人+发起 agent+目标 agent）最小化，每方都 opt-in。不开哨兵 = 纯 PTY，零副作用。

### 5.3 协议 .md 注入（告诉 agent 怎么配合）

Coffee-CLI 在用户开启多 Agent 模式时，在工作区根写入：

| 文件 | 被谁读 |
|---|---|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Codex CLI / OpenCode 系 |
| `GEMINI.md` | Gemini CLI |
| `.multi-agent/PROTOCOL.md` | 三家同时指向（长文档） |

内容由 [src/multi_agent_protocol.rs](../src/multi_agent_protocol.rs) 的 `THIN_POINTER_BODY` 和 `FULL_PROTOCOL_BODY` 模板生成。

核心信息：
- 你是 Coffee-CLI 多 Agent 容器里的一个 pane
- **你没有跨 pane 工具**，不要调 `list_panes` / `send_to_pane` 之类（不存在）
- 用户是编排者——他用眼睛+键盘决定消息路由
- 如果用户告诉你你的 pane 编号，完成任务时可以选择打印 `[COFFEE-DONE:paneN->paneM]`

**合并策略**：如果用户自己有 CLAUDE.md，我们只在 `<!-- COFFEE-CLI:MULTI-AGENT:START -->` 标记内插入块，不动其他内容；退出多 Agent 模式时精确移除标记块。

### 5.4 Tab 与多 Agent 的关系

- Tab 是**独立**的多 Agent 单元：同一个 Coffee-CLI 窗口可以有 Tab1=单终端，Tab2=四宫格多 Agent
- 多 Agent 模式是**每个 Tab 独立的属性**，不是全局
- Tab 切换时不影响其他 Tab 的 pane 状态
- pane 编号 1..4 与 UI 角标数字一致

### 5.5 术语表

| 术语 | 定义 |
|---|---|
| **Pane** | 四宫格里的一格，对应一个 portable-pty 子进程 |
| **多 Agent 模式** | 一个 Tab 的布尔属性：开启 = 多格布局 + 协议 .md 注入 + 可选哨兵 |
| **哨兵协议** | 每个 pane 独立 opt-in 的完成标记扫描机制 |
| **Gambit** | UI 的跨 pane 广播功能（用户触发，不是 agent 触发） |

---

## 六、关键参考（前人踩过的坑，直接抄或显式规避）

| 参考仓库 | 抄什么 | 规避什么 |
|---|---|---|
| [claude_code_bridge (CCB)](https://github.com/bfly123/claude_code_bridge) | **三文件注入 CLAUDE.md / AGENTS.md / GEMINI.md 让非-Claude agent 懂约定**（最核心抄法） | AF_UNIX + tmux 236 处硬编码 = Windows 死路 |
| [GGPrompts/conductor-mcp](https://github.com/GGPrompts/conductor-mcp) | 理解多 pane 分发的概念 | 57 处 tmux 硬编码 |
| [Claude Agent Teams 官方](https://code.claude.com/docs/en/agent-teams) | 同家 subagent 归 Claude 自己管 | 只支持 Claude 当主控 |

---

## 七、范围边界

### 7.1 v1.0 已交付

- [x] 四宫格 UI（2×2）+ 1×2 / 1×3 布局
- [x] 每格独立 portable-pty 子进程
- [x] Tab 独立的多 Agent 模式开关
- [x] 协议 .md 注入（CLAUDE.md / AGENTS.md / GEMINI.md + `.multi-agent/PROTOCOL.md`）
- [x] 哨兵协议（每 pane opt-in）
- [x] Gambit 跨 pane 广播 UI
- [x] 历史 MCP 残留自愈（每次启动自动清理 `~/.claude.json` / `~/.codex/config.toml` / `~/.gemini/settings.json` 里的 `coffee-cli` 条目）

### 7.2 永不做（放弃理由见 §4）

- ❌ MCP / ACP 结构化 agent-to-agent 通信
- ❌ DAG 编排 / 任务图
- ❌ git worktree / 容器化沙箱
- ❌ 任务持久化到磁盘
- ❌ 集群 / 远程 pane
- ❌ pane 之间自动上下文共享
- ❌ DetachedTerminal（拆分窗口）

### 7.3 未来可能考虑（不承诺）

- ACP adapter（结构化 diff/permission）：等 Zed ACP 生态成熟度验证，且用户真提出需求再评估

---

## 八、风险清单

| 风险 | 对策 |
|---|---|
| **PTY backpressure 根因 #2** | 每 pane 独立 channel；stress test（4 格同时 cat 大文件）必须通过 |
| **xterm.js 4 实例内存（~30MB × 4）** | 非活跃 Tab 暂停渲染 |
| **用户不知道何时用多 Agent** | UI 示例卡片引导（代码审查 / UI 设计 / 多方案对比） |
| **哨兵协议误触发**（PTY 里凑巧出现匹配文本） | 只在 pane 开启哨兵时才起效；30 分钟过期；双方向寻址降低重名概率 |
| **Windows 路径 / 编码问题** | 持续测试 |

---

## 九、版本实施记录

### v1.0（2026-04）— MCP 方案（已退休）
- 实现 MCP Server + 3 工具 + 注入三家 CLI config
- 2026-04-24 完全退休

### v1.1（2026-04-24 当前）— Sentinel-only
- 删除 MCP spawn + 注入路径
- `mcp_server.rs` / `mcp_injector.rs` 归档 `#![allow(dead_code)]`
- 协议 .md 全部改写，告诉 agent "no cross-pane tools exist"
- 自愈路径保留，清理老版本残留

---

## 十、决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-04-22 | 确定走"3 工具 + 四宫格 + 三文件注入"路线（MCP 方案） | 详见附录 F |
| 2026-04-22 | 否决 DAG 编排 / Agent 身份识别 | 编排决策权留给主控 LLM |
| 2026-04-22 | **主控 CLI 锁定 3 家**：Claude Code / Codex / Gemini CLI | OpenCode 的 config 形状差异太大，v1.1 单独做 |
| 2026-04-23 | **MCP 传输选 HTTP 不选 stdio** | 常驻进程不能被 CLI spawn |
| 2026-04-24 | **退休 MCP，改走 Sentinel Protocol** | 产品定位澄清：多 Agent 本质是"4 pane + 1 人眼"，agent-to-agent 结构化通信不是我们要的。三条理由：(1) 用户眼睛+键盘+Gambit 就能完成路由；(2) MCP 注入污染 global CLI config 带来维护负担（残留、stale 端口、错误提示）；(3) 定位"美化载体"和"agent 自治"本就矛盾 |
| 2026-04-24 | **删除 DetachedTerminal 特性** | 开发过但零用户零引用，不符合当前定位 |
| 2026-04-24 | **删除翻译流水线脚本** | 战略转向时未清理，6000+ LOC |

---

## 附录 A：不变量（永不违背）

1. **Coffee-CLI 永远是"可视化容器"不是"编排器"** —— 任何涉及"多步自动决策"的提议，重读第三节
2. **永远优先 Windows 用户** —— 任何只能在 POSIX 跑的方案直接否决
3. **agent 之间没有结构化通信** —— 编排权归坐在电脑前的人，不归任何 agent
4. **用户全程可见可干预** —— 任何"后台黑盒执行"的提议重读第二节独特性部分
5. **协议 .md 不能对 agent 撒谎** —— 告诉 agent 的工具必须真实存在

---

## 附录 B：三家 CLI 的协议 .md 注入清单

| CLI | 协议提示文件（项目根） |
|---|---|
| **Claude Code** | `CLAUDE.md`（薄指针指向 `.multi-agent/PROTOCOL.md`） |
| **Codex CLI** | `AGENTS.md`（内容同上） |
| **Gemini CLI** | `GEMINI.md`（内容同上） |

**已移除**：
- 所有 `mcpServers.coffee-cli` 注入（已退休）
- `~/.coffee-cli/mcp-endpoint.json` 不再生成

**自愈**：每次 Coffee-CLI 启动会扫描三个 CLI 配置文件，如有老版本遗留的 `coffee-cli` MCP 条目自动清理。

---

## 附录 E：竞品扫描与独占位验证（2026-04-22 原始扫描，结论仍成立）

5 个疑似对标方案已逐一扒过源码，Coffee-CLI 独占位仍成立。

| 方案 | 能否跨 CLI 进程 | Windows 原生 | 可视化 GUI | 用户全程可见 | 对 Coffee-CLI 影响 |
|---|---|---|---|---|---|
| metaswarm | 半真 | ❌ POSIX-first | ❌ CLI-only | ❌ | 零威胁 |
| myclaude | 真（Go wrapper） | ⚠️ POSIX-first | ❌ CLI-only | ❌ | 零威胁 |
| claude_code_bridge | 真（tmux） | ❌ tmux-only | ❌ | ✅ tmux pane | 零威胁（Windows 死路） |
| Claude Co-Commands | ❌ 只是插件 | — | ❌ | ❌ | 零威胁 |
| Zed ACP | ❌ 1:1 协议 | ✅ 纯协议 | Zed/JetBrains 内 | ✅ 结构化事件 | **机会窗**（未来可选） |

### 三条护城河完整无损

1. **桌面 GUI + 可见多 PTY** —— 4 家竞品都是 CLI-only 或 tmux-only，**没人做 GUI**
2. **Windows 原生 Tauri** —— 4 家要么 POSIX-first，要么 tmux，要么 AF_UNIX
3. **人类可干预的跨 CLI 并排** —— 各家 CLI 的 subagent 对用户黑盒，我们全透明

ACP（Zed Agent Client Protocol）是 2026 年的 LSP 级事件，但**没有 agent-to-agent 消息类型**——它只管"宿主 ↔ 单 agent"。对 Coffee-CLI 的定位不构成威胁，如果未来引入将作为"拿结构化 diff/permission"的 adapter，和 PTY 并行共存。

---

## 附录 F：历史方案存档（MCP 时代 2026-04-22 → 2026-04-24，已退休）

> ⚠️ 以下内容**仅供查阅历史决策脉络**，**不要作为实现参考**。当前实现见正文 §5。

### F.1 MCP 3 工具设计（2026-04-22 定稿，2026-04-24 全部退休）

原计划通过 Rust MCP Server（`rmcp` crate + Streamable HTTP 传输）暴露：
- `list_panes()` — 返回 pane 列表
- `send_to_pane(id, text, timeout_sec, wait)` — 给指定 pane 发指令，同步/异步均支持
- `read_pane(id, last_n_lines)` — 读指定 pane 的最近输出

通过注入 `~/.claude.json` / `~/.codex/config.toml` / `~/.gemini/settings.json` 让主控 CLI 发现该 MCP Server。

### F.2 Idle 检测策略（MCP 时代遗产）

为 `send_to_pane(wait=true)` 的阻塞语义设计了 6 个 CLI profile（claude / codex / gemini / opencode / shell / aider）的 silence + prompt regex 组合判定。Sentinel-only 不需要 idle 判定（人眼直接看）。

### F.3 为什么整套被退休（2026-04-24）

1. **产品定位矛盾**：宣称"用户全程可见可干预"，但 MCP 一接入，agent 开始自己调 tool 发消息，用户又变回"看日志"的角色
2. **Config 污染**：MCP 注入污染三家 global CLI 配置，端口失效后残留报错（"1 MCP server failed"）
3. **哨兵协议足够**：人眼看 + 绿点徽章 + Gambit 广播的组合，实测覆盖所有真实使用场景
4. **代码简化**：去掉 MCP 减少 ~1500 LOC 主动代码 + ~40 行孤儿 protocol 文本对 agent 撒谎的风险

### F.4 代码保留状态

- [src/mcp_server.rs](../src/mcp_server.rs) 归档，`#![allow(dead_code)]`，保留 rmcp + axum 基础设施以备未来 opt-in 模式
- [src/mcp_injector.rs](../src/mcp_injector.rs) 同上，保留 config merge + backup 逻辑
- `uninstall_all` 在 `start_ui` / shutdown 持续运行，清理任何用 v1.0 build 产生的残留

### F.5 历史附录备份

原文 §5.5（MCP Server 进程架构）、附录 B（MCP 接入清单详版）、附录 C（MCP 开工前验证清单）、附录 D（MCP 开发中细节决策）共 ~300 行，已随本次改写合并或删除。如需原始完整版本，可通过 `git log docs/MULTI-AGENT-ARCHITECTURE.md` 查到 2026-04-23 之前的提交快照。
